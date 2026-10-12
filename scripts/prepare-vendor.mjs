/**
 * 准备预览组件（vendor）
 *
 * 把 npm 上的 `@file-viewer/web-full` 里的 **完整 dist/** 原样落到
 * `vendor/dist/`。之后服务端会把 `vendor/dist/` 挂到 `/file-viewer/dist/`，
 * 前端的 <script src="/file-viewer/dist/flyfish-file-viewer-web-full.iife.js">
 * 加载它，组件再用 document.currentScript 推导资源基址，按需懒加载
 * renderers/*.iife.js 与 vendor/、wasm/ 下的 Worker / WASM / 字体。
 *
 * ⚠️ 为什么必须整份 dist，而不是只抄一个 iife 文件：
 *    IIFE 首包只含"外壳 + 懒加载的 preset"，PDF / Word / Excel / PPT /
 *    CAD / Typst / 压缩包等重型 renderer 是在命中文件类型时才去拿
 *    `dist/renderers/*.iife.js` 的。少一个目录，对应的格式就会在打开时
 *    报"资源加载失败"，而报错信息完全看不出是部署漏文件。
 *
 * 用法：
 *   node scripts/prepare-vendor.mjs            # 缺什么补什么
 *   node scripts/prepare-vendor.mjs --force    # 强制重新下载解包
 *   node scripts/prepare-vendor.mjs --slim     # 瘦身（见下）
 *   node scripts/prepare-vendor.mjs --local .cache/web-full-3.1.2.tgz   # 用本地 tgz
 *
 * --slim 说明：默认（full）是官方支持且验证过的部署形态，**不要轻易改**。
 * slim 只是给"实在嫌 233MB 太大"的人一个折中：删掉几块最大的可选资产，
 * 代价是少数格式不再可用（界面会明确提示"渲染失败"，不会静默白屏）：
 *   vendor/drawio  66MB → .drawio / .dio 等 draw.io 图示
 *   wasm/cad       40MB → .dwg / .dxf / .dwf（本机已有专门的 CAD 看图应用）
 *   wasm/typst     37MB → .typ / .typst
 *   vendor/design  22MB → Adobe 设计文件（Full 包本就不含该 renderer）
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { readTgz, writeEntry } from './lib/tar.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor')
const DIST = path.join(VENDOR, 'dist')
const CACHE = path.join(ROOT, '.cache')

/** 想升级预览组件就改这里（或设 FILE_VIEWER_VERSION 环境变量） */
const VERSION = process.env.FILE_VIEWER_VERSION || '3.1.2'
const PACKAGE = '@file-viewer/web-full'

/** 国内优先，失败再走官方源 —— 实测两者速度差 50 倍 */
const REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org'
]

const SLIM_DROP = [
  'vendor/drawio',
  'vendor/design',
  'wasm/cad',
  'wasm/typst'
]

const args = process.argv.slice(2)
const FORCE = args.includes('--force')
const SLIM = args.includes('--slim')
const LOCAL_TGZ = (() => {
  const i = args.indexOf('--local')
  return i >= 0 ? path.resolve(args[i + 1] || '') : null
})()

const log = (m) => console.log(`[vendor] ${m}`)
const fail = (m) => {
  console.error(`[vendor] ✗ ${m}`)
  process.exit(1)
}

/* ── 1. 已经就绪就直接返回 ─────────────────────────────────────── */

const stampPath = path.join(VENDOR, 'VERSION.json')

function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(stampPath, 'utf8'))
  } catch {
    return null
  }
}

function distLooksComplete() {
  const entry = path.join(DIST, 'flyfish-file-viewer-web-full.iife.js')
  const renderers = path.join(DIST, 'renderers')
  if (!fs.existsSync(entry) || !fs.existsSync(renderers)) return false
  try {
    return fs.readdirSync(renderers).some((f) => f.endsWith('.iife.js'))
  } catch {
    return false
  }
}

const stamp = readStamp()
if (!FORCE && !LOCAL_TGZ && !SLIM && stamp?.version === VERSION && distLooksComplete()) {
  log(`已就绪：${PACKAGE}@${stamp.version}（${stamp.files} 个文件，${(stamp.bytes / 1048576).toFixed(1)} MB）`)
  log('需要重建请加 --force')
  process.exit(0)
}

/* ── 2. 取 tarball（优先本地缓存） ─────────────────────────────── */

fs.mkdirSync(CACHE, { recursive: true })
const cached = path.join(CACHE, `web-full-${VERSION}.tgz`)

async function fetchTarball() {
  if (LOCAL_TGZ) {
    if (!fs.existsSync(LOCAL_TGZ)) fail(`本地 tarball 不存在：${LOCAL_TGZ}`)
    log(`使用本地 tarball：${path.relative(ROOT, LOCAL_TGZ)}`)
    return { buf: fs.readFileSync(LOCAL_TGZ), integrity: '', from: LOCAL_TGZ }
  }

  if (!FORCE && fs.existsSync(cached)) {
    log(`使用缓存：${path.relative(ROOT, cached)}`)
    return { buf: fs.readFileSync(cached), integrity: '', from: cached }
  }

  let lastErr = null
  for (const registry of REGISTRIES) {
    try {
      log(`查询 ${registry} …`)
      const metaUrl = `${registry}/${PACKAGE.replace('/', '%2F')}/${VERSION}`
      const metaRes = await fetch(metaUrl, { signal: AbortSignal.timeout(30000) })
      if (!metaRes.ok) throw new Error(`元数据 HTTP ${metaRes.status}`)
      const meta = await metaRes.json()
      const integrity = meta?.dist?.integrity || ''
      const tarball = meta?.dist?.tarball
      if (!tarball) throw new Error('元数据里没有 dist.tarball')

      log(`下载 ${tarball} …`)
      const res = await fetch(tarball, { signal: AbortSignal.timeout(600000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < 1024) throw new Error(`下载内容过小（${buf.length} 字节）`)

      fs.writeFileSync(cached, buf)
      log(`已缓存到 ${path.relative(ROOT, cached)}（${(buf.length / 1048576).toFixed(1)} MB）`)
      return { buf, integrity, from: tarball }
    } catch (err) {
      lastErr = err
      log(`${registry} 失败：${err.message}`)
    }
  }
  return fail(`所有源都取不到 ${PACKAGE}@${VERSION}：${lastErr?.message || lastErr}`)
}

/**
 * 校验 npm 给的 sha512 完整性。
 *
 * 78MB 的产物如果下载过程中被截断，解包时只会看到"某个文件不存在"这类
 * 莫名其妙的错误；先校验一次，能把问题在源头说清楚。
 */
function verifyIntegrity(buf, integrity) {
  if (!integrity || !integrity.startsWith('sha512-')) {
    log('（该源未提供 integrity，跳过校验）')
    return
  }
  const want = integrity.slice('sha512-'.length)
  const got = crypto.createHash('sha512').update(buf).digest('base64')
  if (got !== want) fail(`tarball 校验失败：\n  期望 ${want}\n  实际 ${got}`)
  log('sha512 校验通过')
}

/* ── 3. 解包 dist/ → vendor/dist/ ─────────────────────────────── */

function extract(buf) {
  log('解包中…')
  fs.rmSync(DIST, { recursive: true, force: true })
  fs.mkdirSync(DIST, { recursive: true })

  const PREFIX = 'package/dist/'
  let files = 0
  let bytes = 0
  let dropped = 0

  const { entries } = readTgz(buf, (entry) => {
    if (entry.type === 'dir') return false

    // npm 包的路径是 package/dist/...；也容忍没有 package/ 前缀的打包方式
    const rel = entry.name.startsWith(PREFIX)
      ? entry.name.slice(PREFIX.length)
      : entry.name.startsWith('dist/')
        ? entry.name.slice('dist/'.length)
        : null
    if (!rel) return false

    if (SLIM && SLIM_DROP.some((d) => rel === d || rel.startsWith(d + '/'))) {
      dropped++
      return false
    }

    const data = entry.read()
    writeEntry(DIST, rel, data)
    files++
    bytes += data.length
    return true
  })

  return { scanned: entries, files, bytes, dropped }
}

/* ── 4. 落盘说明文件 ─────────────────────────────────────────── */

async function main() {
  const { buf, integrity, from } = await fetchTarball()
  verifyIntegrity(buf, integrity)

  const result = extract(buf)

  if (result.files === 0) fail('一个文件都没解出来，tarball 结构可能变了')

  if (!distLooksComplete()) {
    fail('解包结果不完整：缺少 flyfish-file-viewer-web-full.iife.js 或 renderers/')
  }

  const info = {
    package: PACKAGE,
    version: VERSION,
    profile: SLIM ? 'slim' : 'full',
    droppedBySlim: SLIM ? SLIM_DROP : [],
    source: from,
    integrity,
    files: result.files,
    bytes: result.bytes,
    extractedAt: new Date().toISOString()
  }
  fs.writeFileSync(stampPath, JSON.stringify(info, null, 2))

  log(`完成：${result.files} 个文件，${(result.bytes / 1048576).toFixed(1)} MB → ${path.relative(ROOT, DIST)}`)
  if (result.dropped) log(`--slim 已跳过 ${result.dropped} 个条目（${SLIM_DROP.join(', ')}）`)
  log(`版本记录：${path.relative(ROOT, stampPath)}`)
}

main().catch((err) => fail(err?.stack || String(err)))
