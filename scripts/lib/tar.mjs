/**
 * 极简 tar.gz 读取器。
 *
 * 为什么要自己写：`prepare-vendor` 的唯一外部依赖就是"把 npm 的 .tgz 解开"。
 * 为这一件事去依赖系统里的 `tar` 命令（Windows 上还分 bsdtar / Git Bash 两套）
 * 或者第三方包（会又多个 node_modules），都不划算 —— tar 格式本身很简单，
 * 而 node 自带 zlib，所以这里只补一个解析器。
 *
 * 覆盖 npm 打包实际会用到的三种情况：
 *   · ustar 前缀字段（长路径）
 *   · pax 扩展头（`x` / `g` 类型），npm 打包长文件名时走这条
 *   · GNU longname（`L` 类型），老工具链会走这条
 *
 * 只做"读"，不做符号链接 / 硬链接 / 设备文件（npm 包里没有）。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const BLOCK = 512

/** 读 tar 头里的八进制数字（可能是 "0000644\0" 或 "00000000000 " 形式） */
function readOctal(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length).toString('ascii')
  const text = raw.replace(/\0/g, ' ').trim()
  if (!text) return 0
  const n = parseInt(text, 8)
  return Number.isFinite(n) ? n : 0
}

function readString(buf, offset, length) {
  const end = buf.indexOf(0, offset)
  const stop = end === -1 || end > offset + length ? offset + length : end
  return buf.subarray(offset, stop).toString('utf8')
}

/** 解析 pax 扩展头的内容：每行形如 "LEN key=value\n" */
function parsePax(buf) {
  const out = {}
  let i = 0
  while (i < buf.length) {
    let sp = buf.indexOf(0x20, i)
    if (sp === -1) break
    const len = parseInt(buf.subarray(i, sp).toString('ascii'), 10)
    if (!Number.isFinite(len) || len <= 0) break
    const line = buf.subarray(sp + 1, i + len - 1).toString('utf8')
    const eq = line.indexOf('=')
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1)
    i += len
  }
  return out
}

function isZeroBlock(buf, offset) {
  for (let i = offset; i < offset + BLOCK; i++) {
    if (buf[i] !== 0) return false
  }
  return true
}

/**
 * 解开 .tar.gz。
 *
 * @param {Buffer} tgz 压缩包内容
 * @param {(entry: { name: string, type: string, size: number, read: () => Buffer }) => boolean | void} onEntry
 *        每个条目回调一次。返回 false 表示跳过该条目的内容（仍然会正确跳过它的字节）。
 * @returns {{ entries: number, skipped: number }}
 */
export function readTgz(tgz, onEntry) {
  const tar = zlib.gunzipSync(tgz)

  let offset = 0
  let entries = 0
  let skipped = 0
  let pendingPax = null
  let pendingLongName = null
  let pendingLongLink = null

  while (offset + BLOCK <= tar.length) {
    if (isZeroBlock(tar, offset)) break

    const name = readString(tar, offset, 100)
    const prefix = readString(tar, offset + 345, 155)
    const size = readOctal(tar, offset + 124, 12)
    const type = String.fromCharCode(tar[offset + 156]) || '0'
    const linkName = readString(tar, offset + 157, 100)
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size

    if (dataEnd > tar.length) break

    if (type === 'x' || type === 'g') {
      const pax = parsePax(tar.subarray(dataStart, dataEnd))
      // 全局头（g）在本包里用不到，只认逐条目的扩展头
      if (type === 'x') pendingPax = pax
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    if (type === 'L') {
      pendingLongName = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '')
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    if (type === 'K') {
      pendingLongLink = tar.subarray(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '')
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      continue
    }

    let fullName = pendingPax?.path || pendingLongName || (prefix ? `${prefix}/${name}` : name)
    const link = pendingPax?.linkpath || pendingLongLink || linkName
    pendingPax = null
    pendingLongName = null
    pendingLongLink = null

    // 目录条目常见于末尾带 '/'，统一去掉，写盘时按父目录处理
    const isDir = type === '5' || fullName.endsWith('/')
    fullName = fullName.replace(/\/+$/, '')

    if (!fullName || fullName.startsWith('/') || fullName.includes('..')) {
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
      skipped++
      continue
    }

    if (isDir) {
      const keep = onEntry?.({ name: fullName, type: 'dir', size: 0, read: () => Buffer.alloc(0) })
      if (keep === false) skipped++
      else entries++
    } else if (type === '0' || type === '\0' || type === '') {
      const keep = onEntry?.({
        name: fullName,
        type: 'file',
        size,
        read: () => tar.subarray(dataStart, dataEnd)
      })
      if (keep === false) skipped++
      else entries++
    } else {
      // 符号链接 / 硬链接等：记下来但内容为空，npm 包里用不到
      const keep = onEntry?.({ name: fullName, type: 'link', size: 0, link, read: () => Buffer.alloc(0) })
      if (keep === false) skipped++
      else entries++
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  return { entries, skipped }
}

/** 安全地写出一个条目（自动建父目录） */
export function writeEntry(outDir, name, buffer) {
  const target = path.join(outDir, name)
  const rel = path.relative(outDir, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`拒绝写出越界路径：${name}`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buffer)
  return target
}
