/**
 * 最小但**结构完整**的 ZIP 写入器（store 方式，不压缩）。
 *
 * 为什么要有它：压缩包预览要验的是「renderer 能不能真的把包解开并列出内容」，
 * 拿几个字节的假文件只会走到错误分支。ZIP 的 store 方式不需要 deflate，
 * 只要 CRC32 和中央目录的偏移写对，任何解压器（含 libarchive）都认。
 *
 * 只依赖 node:zlib 之外的自实现 CRC32，零第三方依赖。
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS 时间格式；固定值即可，测试不关心时间戳 */
const DOS_TIME = 0x0000
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 9

/** 目录项也一并写进去，让解压器能看到目录树 */
function toEntry(name, data, isDir) {
  if (isDir && !name.endsWith('/')) name += '/'
  return {
    name,
    isDir,
    /** 位 11 = UTF-8 文件名（中文目录名必须置上，否则会被按 CP437 解） */
    flags: 0x0800,
    data: isDir ? Buffer.alloc(0) : data,
    size: isDir ? 0 : data.length,
    crc: isDir ? 0 : crc32(data)
  }
}

/**
 * @param {Array<[string, string|Buffer] | [string, null]>} items
 *        `[名字, 内容]` 写文件；`[名字, null]` 写空目录
 * @returns {Buffer} 完整的 ZIP 字节流
 */
export function makeZip(items) {
  const entries = items.map(([name, content]) =>
    toEntry(name, content === null ? Buffer.alloc(0) : Buffer.from(content, 'utf8'), content === null)
  )

  const locals = []
  const centrals = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(e.flags, 6)
    local.writeUInt16LE(0, 8) // 压缩方式 0 = store
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(e.crc, 14)
    local.writeUInt32LE(e.size, 18) // 压缩后大小
    local.writeUInt32LE(e.size, 22) // 原始大小
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    locals.push(local, nameBuf, e.data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    central.writeUInt16LE(20, 4) // 生成版本
    central.writeUInt16LE(20, 6) // 解压所需版本
    central.writeUInt16LE(e.flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(e.crc, 16)
    central.writeUInt32LE(e.size, 20)
    central.writeUInt32LE(e.size, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段
    central.writeUInt16LE(0, 32) // 注释
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(e.isDir ? 0x41ed0010 : 0x81a40000, 38) // 外部属性（含 unix 权限位）
    central.writeUInt32LE(offset, 42) // 本地头偏移

    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + e.data.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // 结束记录签名
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...locals, centralBuf, eocd])
}
