/**
 * fnos-file-viewer —— 飞牛 fnOS 原生「文件预览」应用的服务端
 *
 * 干的活很少，只有两件：
 *
 *   1) 当文件服务器：把磁盘上的文件以 HTTP 流出去，供浏览器里的预览组件
 *      （file-viewer）按需拉取。必须支持 Range 请求 —— PDF、音视频、CAD
 *      wasm 都会用分段读取，不支持的话轻则卡顿、重则直接打不开。
 *
 *   2) 当静态服务器：把 file-viewer 的完整 dist 挂到 /file-viewer/dist/ 下，
 *      并把本应用自己的前端挂到 /。
 *
 * 设计上和 fnos-dwg-viewer 保持一致的地方：**预览能力全部交给第三方组件，
 * 自己只做「把文件安全地喂给浏览器」这一件事**。上一版验证过的路径解析、
 * 授权目录、root 全盘直读那一套直接沿用（见 path-utils.mjs）。
 *
 * 与 fnos-dwg-viewer 的关键差别：那个应用只认 dwg/dxf，会过滤掉其它文件；
 * 本应用是**通用预览器**，列表里所有文件都列出来，能不能渲染交给 file-viewer
 * 自己判断 —— 它认 274 个扩展名，我们没资格替它筛。
 */
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { isInside, parentCandidates, recoverCandidates, splitEnvList, suggestAuthorizeDir } from './path-utils.mjs'
import { extInfo, mimeOf } from './formats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/**
 * 版本号取自 package.json。
 * 打包后 build-fpk 会把一份同名 package.json 放到服务端目录旁，
 * 源码目录里没有那一份，就退到项目根的 —— 行为一致，避免两个版本号打架。
 */
const APP_VERSION = (() => {
  for (const p of [path.join(__dirname, 'package.json'), path.join(ROOT, 'package.json')]) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version
      if (v) return v
    } catch {
      /* 试下一个 */
    }
  }
  return 'dev'
})()

/** file-viewer 的版本号（从 vendor 里的 manifest 读，不打进自己的版本号） */
const VIEWER_VERSION = (() => {
  try {
    const p = path.join(ROOT, 'vendor', 'dist', 'flyfish-viewer-manifest.json')
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || ''
  } catch {
    try {
      const p = path.join(__dirname, 'vendor', 'dist', 'flyfish-viewer-manifest.json')
      return JSON.parse(fs.readFileSync(p, 'utf8')).version || ''
    } catch {
      return ''
    }
  }
})()

const PORT = Number(process.env.TRIM_SERVICE_PORT || process.env.PORT || 8030)
const HOST = process.env.HOST || '0.0.0.0'

/* ------------------------------------------------------------------ */
/* 目录布局                                                            */
/* ------------------------------------------------------------------ */

/**
 * 前端与预览组件的位置。
 *
 * 两种布局都要支持：
 *  · 源码目录：D:/Docker/fnos-file-viewer/{web,vendor}
 *  · 打包后：  <app>/server/{web,vendor}   （build-fpk 拷进来）
 * 所以两个候选都试，谁能用用谁。
 */
function firstDirWith(candidates, marker) {
  for (const d of candidates) {
    try {
      if (fs.statSync(path.join(d, marker)).isFile()) return d
      if (fs.statSync(path.join(d, marker)).isDirectory()) return d
    } catch {
      /* 试下一个 */
    }
  }
  return candidates[0]
}

const WEB_DIR = firstDirWith([path.join(ROOT, 'web'), path.join(__dirname, 'web')], 'index.html')
/**
 * 预览组件的 dist 目录。
 *
 * 路由前缀 `/file-viewer/dist/` 直接映射到它 —— 和 file-viewer 官方文档里
 * "把完整 dist/ 部署到 /file-viewer/dist/" 的示例一致，这样组件用
 * document.currentScript 推导出来的资源基址（脚本所在的目录）正好落在
 * `/file-viewer/dist/` 上，renderers / vendor / wasm 全都能按相对路径找到。
 */
const VIEWER_DIST = path.join(
  firstDirWith(
    [path.join(ROOT, 'vendor'), path.join(__dirname, 'vendor')],
    path.join('dist', 'flyfish-file-viewer-web-full.iife.js')
  ),
  'dist'
)

/* ------------------------------------------------------------------ */
/* 权限 / 访问模式                                                     */
/* ------------------------------------------------------------------ */

/**
 * 进程真实身份。
 *
 * 必须看运行期 uid，而不是"装的是不是 root 版包"：飞牛的 root 权限版
 * （config/privilege 里 run-as: root）会让 cmd/ 里的生命周期脚本以 root
 * 执行，node 进程随之拿到 root —— 这时它本来就能读全盘。可如果代码仍然按
 * "白名单为空 → 全部拦住"处理，用户就会遇到「装了 root 版、双击文件还是
 * 提示没授权」这种荒唐结果。所以权限判定一律只看 uid。
 */
const IS_ROOT =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0

/**
 * 访问模式：默认**全盘直读**（root 权限版）。
 *
 * FNOS_ACCESS_MODE=scoped 是留给自己的应急开关：万一某个系统版本不允许
 * 第三方应用以 root 运行，可以退回"只认白名单"的老行为，免得应用完全不可用。
 * 它不会被自动设置，界面上也没有入口。
 */
const ACCESS_MODE_ENV = String(process.env.FNOS_ACCESS_MODE || '').trim().toLowerCase()
const SCOPED_MODE = ACCESS_MODE_ENV === 'scoped'
const UNRESTRICTED = !SCOPED_MODE

const LOCAL_ROOT = process.env.LOCAL_ROOT ? path.resolve(process.env.LOCAL_ROOT) : null
const ALLOW_PREFIXES = splitEnvList(process.env.ALLOW_PREFIXES).map((s) => path.resolve(s))

const APP_USER = (() => {
  try {
    return os.userInfo().username || process.env.TRIM_RUN_USERNAME || ''
  } catch {
    return process.env.TRIM_RUN_USERNAME || ''
  }
})()

const DATA_DIR = process.env.TRIM_PKGVAR || path.join(ROOT, 'var')
try {
  fs.mkdirSync(DATA_DIR, { recursive: true })
} catch {
  /* 只读环境就退化成内存态 */
}

/**
 * 存储空间的挂载点（飞牛上是 /vol1、/vol2 …，外接盘是 /vol00、/vol01 …）。
 *
 * 不把 / 当浏览根：那样一进来就是 bin / etc / proc，既没用又容易误触。
 * FNOS_VOL_ROOTS 可以显式指定根（Docker 挂载整盘 / e2e 造夹具）。
 */
function detectStorageRoots() {
  const override = splitEnvList(process.env.FNOS_VOL_ROOTS)
  if (override.length) return [...new Set(override.map((p) => path.resolve(p)))].sort()

  const vols = []
  try {
    for (const name of fs.readdirSync('/')) {
      if (!/^vol\d+$/.test(name)) continue
      try {
        if (fs.statSync('/' + name).isDirectory()) vols.push('/' + name)
      } catch {
        /* 单个挂载点探测失败就跳过 */
      }
    }
  } catch {
    /* 读不动 /：交给兜底 */
  }
  return vols.sort()
}

/** 顶层浏览根：各个存储空间的挂载点（界面上显示成「存储空间 1」） */
function browseSources() {
  return allowedRoots().map((p) => ({ label: rootLabel(p) || p, path: p }))
}

function allowedRoots() {
  return [
    ...new Set([
      ...(LOCAL_ROOT ? [LOCAL_ROOT] : []),
      ...detectStorageRoots(),
      ...ALLOW_PREFIXES
    ])
  ]
}

/**
 * 多根模式：没有单一浏览根、且至少有一个入口时启用。
 *
 * 是个函数而不是常量：入口来自磁盘上的实际目录（挂载点会变），每次请求
 * 重算才不会出现"插了 U 盘但列表里没有"。
 */
function multiRoot() {
  if (LOCAL_ROOT) return false
  const sources = browseSources()
  if (sources.length === 1 && path.parse(sources[0].path).root === sources[0].path) return false
  return sources.length > 0
}

function isAllowed(abs) {
  // 全盘模式：进程本身就是 root，白名单没有存在意义
  if (UNRESTRICTED) return true
  const roots = allowedRoots()
  if (roots.length === 0) return isInside(abs, ROOT)
  return roots.some((root) => isInside(abs, root))
}

/**
 * 顶层条目的显示名。
 *
 * 直接把 /vol1 摆出来用户认不出是哪个盘，换成飞牛界面里的叫法「存储空间 1」。
 * 匹配的是"路径最后一段是 volN"，不是"整条路径就是 /volN" ——
 * Docker 挂到 /mnt/vol1、开发机夹具在 C:/tmp/xxx/vol1 时同样要认出来。
 */
function rootLabel(root) {
  const p = String(root).split(path.sep).join('/').replace(/\/+$/, '')
  const m = /(?:^|\/)vol(\d+)$/.exec(p)
  return m ? `存储空间 ${m[1]}` : path.basename(p) || root
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const MIME_STATIC = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.data': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.mem': 'application/octet-stream'
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

/**
 * HTTP 头只能安全地写 ASCII，中文名直接塞进 filename="…" 会变乱码，
 * 所以 filename 放 ASCII 回退值，真名走 RFC 5987 的 filename*。
 */
function contentDisposition(name, asAttachment = false) {
  const safe = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file'
  return `${asAttachment ? 'attachment' : 'inline'}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

function toApiError(err, absPath) {
  if (err instanceof ApiError) return err
  const name = String(err?.message || err)
  const where = absPath || '(未知路径)'
  switch (err?.code) {
    case 'ENOENT':
      return new ApiError(404, 'NOT_FOUND', `文件或目录不存在：${where}`, { path: where })
    case 'EACCES':
    case 'EPERM':
      return new ApiError(
        403,
        'EACCES',
        `没有读取权限：${where}`,
        { path: where }
      )
    case 'EISDIR':
      return new ApiError(400, 'NOT_A_FILE', '这是一个目录，不是文件')
    case 'ENOTDIR':
      return new ApiError(400, 'NOT_A_DIR', '路径中间有一层不是目录')
    default:
      return new ApiError(500, 'INTERNAL', `${name}（${where}）`)
  }
}

/* ------------------------------------------------------------------ */
/* 路径解析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把请求路径解析成真实磁盘路径。
 *
 * 支持两种形态：
 *  · 浏览用相对路径：`/1000/资料` → LOCAL_ROOT/1000/资料
 *  · fnOS 绝对路径：`/vol1/1000/资料/报告.pdf`（来自文件管理器双击）
 *
 * 解析过程带兜底（见 path-utils.recoverCandidates）：先按原样、再按冒号切段、
 * 再按百分号解码，最后逐级上溯到父目录。每一步都用 isAllowed 卡一遍白名单，
 * 所以兜底不会把越权路径放进来。
 */
function localCandidates(raw) {
  const out = []
  const push = (p) => {
    const abs = path.resolve(p)
    if (!out.includes(abs)) out.push(abs)
  }
  for (const cand of recoverCandidates(raw)) {
    if (path.isAbsolute(cand)) {
      push(cand)
      // 单根模式下，绝对路径也可能要按 LOCAL_ROOT 前缀来找
      if (LOCAL_ROOT) push(path.resolve(LOCAL_ROOT, '.' + cand))
    } else if (LOCAL_ROOT) {
      push(path.resolve(LOCAL_ROOT, cand))
    }
  }
  return out
}

async function matchesWant(abs, want) {
  let st
  try {
    st = await fsp.stat(abs)
  } catch {
    return false
  }
  if (want === 'file') return st.isFile()
  if (want === 'dir') return st.isDirectory()
  return true
}

/**
 * 解析并校验路径。
 *
 * @param raw  客户端传来的路径
 * @param want 'file' | 'dir' | 'exact' | 'any'
 *        'exact' = 只认这一个路径本身，不存在就报错（不做"退到上级目录"的兜底）。
 *        probe 必须用它：否则一个拼错的文件名会被悄悄兜底成它所在的目录，
 *        前端拿到 200 之后会拿目录去当文件打开。
 * @returns 真实绝对路径
 * @throws ApiError OUT_OF_SCOPE / NOT_FOUND / EACCES
 */
async function resolveLocalPath(raw, want = 'any') {
  const candidates = localCandidates(String(raw || '/'))
  const allowed = candidates.filter(isAllowed)

  if (allowed.length === 0) {
    throw new ApiError(403, 'OUT_OF_SCOPE', `该路径不在可访问范围内：${raw}`, {
      path: raw,
      suggest: SCOPED_MODE ? suggestAuthorizeDir(raw) : '',
      allowedRoots: allowedRoots()
    })
  }

  for (const abs of allowed) {
    if (await matchesWant(abs, want)) return abs
  }

  // 目录：退到最近一个真实存在的上级（目录被改名/删除时的兜底）
  if (want !== 'file' && want !== 'exact') {
    for (const cand of candidates) {
      for (const parent of parentCandidates(cand)) {
        if (isAllowed(parent) && (await matchesWant(parent, 'dir'))) return parent
      }
    }
  }

  // 已放行但确实不存在 / 类型不符：让文件系统给出真实错误
  try {
    await fsp.stat(allowed[0])
  } catch (err) {
    throw toApiError(err, allowed[0])
  }
  return allowed[0]
}

/** 回给前端的路径形态：单根模式给相对路径，多根/绝对路径给绝对路径 */
function toClientPath(abs) {
  const posix = abs.split(path.sep).join('/')
  if (LOCAL_ROOT && isInside(abs, LOCAL_ROOT)) {
    const rel = path.relative(LOCAL_ROOT, abs).split(path.sep).filter(Boolean).join('/')
    return rel ? '/' + rel : '/'
  }
  return posix
}

function sortItems(items) {
  return items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN')
  })
}

function childPathOf(prefix, name) {
  return `${prefix.replace(/\/+$/, '')}/${name}` || '/'
}

async function canRead(abs) {
  try {
    await fsp.access(abs, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 文件列表                                                            */
/* ------------------------------------------------------------------ */

/**
 * 列目录。
 *
 * 和 dwg 看图最大的不同：**这里不过滤后缀**。
 * 那个应用只认 dwg/dxf，把别的都藏了是对的；本应用是通用预览器，
 * file-viewer 认 274 个扩展名，我们替它筛只会把能看的文件藏起来。
 * 只做两件事：把隐藏文件（`.` 开头）跳过，以及给每个文件附上分类信息
 * 供前端打标记。
 */
async function listLocal(p) {
  const raw = String(p || '/').replace(/\\/g, '/')

  // 顶层：列出各个存储空间的挂载点
  if (multiRoot() && (raw === '/' || raw === '')) {
    const items = []
    for (const src of browseSources()) {
      let st
      try {
        st = await fsp.stat(src.path)
      } catch {
        console.warn(`[warn] 存储空间不存在，已跳过：${src.path}`)
        continue
      }
      const clientPath = toClientPath(src.path)
      items.push({
        name: src.label || rootLabel(src.path) || clientPath,
        path: clientPath,
        isDir: st.isDirectory(),
        size: st.size,
        mtime: st.mtimeMs,
        ext: '',
        info: { ext: '', group: 'root', label: '存储空间', optIn: false, previewable: false },
        readable: await canRead(src.path)
      })
    }
    return { source: 'local', path: '/', virtual: true, parent: null, items: sortItems(items) }
  }

  const abs = await resolveLocalPath(raw, 'dir')
  const dir = toClientPath(abs)

  let entries
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true })
  } catch (err) {
    // 关键：一定要把 abs 带进来，否则用户看到的是"没有读取权限：undefined"
    throw toApiError(err, abs)
  }

  const items = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const childAbs = path.join(abs, e.name)
    let st
    try {
      st = await fsp.stat(childAbs)
    } catch {
      // 断链的软链接 / 权限不足的单个条目：跳过，不影响整个列表
      continue
    }
    const isDir = st.isDirectory()
    items.push({
      name: e.name,
      path: childPathOf(dir, e.name),
      isDir,
      size: st.size,
      mtime: st.mtimeMs,
      ext: isDir ? '' : path.extname(e.name).slice(1).toLowerCase(),
      info: isDir
        ? { ext: '', group: '', label: '', optIn: false, previewable: false }
        : extInfo(e.name),
      readable: true
    })
  }

  const parent = parentOf(dir)
  return { source: 'local', path: dir, virtual: false, parent, items: sortItems(items) }
}

/** 面包屑上一级；已经在顶层就返回 null */
function parentOf(dir) {
  if (multiRoot()) {
    const d = String(dir).replace(/\/+$/, '')
    if (!d) return null
    const idx = d.lastIndexOf('/')
    if (idx <= 0) return '/'
    return d.slice(0, idx)
  }
  const d = String(dir).replace(/\/+$/, '')
  const idx = d.lastIndexOf('/')
  if (idx <= 0) return '/'
  return d.slice(0, idx)
}

/* ------------------------------------------------------------------ */
/* 文件流                                                              */
/* ------------------------------------------------------------------ */

/**
 * 解析 Range 头。
 *
 * ⚠️ 这个不是可选项：PDF（pdf.js）、音视频、以及 font/wasm 的按需读取都会发
 * Range 请求。回 200 整份内容虽然"也能用"，但大文件会先被整份读进内存，
 * 而且播放器无法拖动进度条 —— 用户看到的现象是"视频不能快进""PDF 一片白"。
 *
 * @returns null（没有/无法解析）| { start, end }（闭区间，已夹紧到文件范围内）
 */
function parseRange(header, size) {
  if (!header || !size) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m

  let start
  let end
  if (rawStart === '') {
    // 后缀形式：bytes=-500 表示"最后 500 字节"
    if (rawEnd === '') return null
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  }

  if (start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

/**
 * 把磁盘上的文件流出去。
 *
 * 用 createReadStream 的 start/end 做真正的分段读，不是"读完再切片" ——
 * 后者在面对 4GB 的 iso / 视频时会把服务进程直接撑爆。
 */
async function streamLocal(p, req, res, headOnly, asAttachment) {
  const abs = await resolveLocalPath(String(p), 'file')
  let st
  try {
    st = await fsp.stat(abs)
  } catch (err) {
    throw toApiError(err, abs)
  }
  if (!st.isFile()) throw new ApiError(400, 'NOT_A_FILE', '这是一个目录，不是文件')

  const name = path.basename(abs)
  const headers = {
    'Content-Type': mimeOf(name),
    'Content-Disposition': contentDisposition(name, asAttachment),
    'Accept-Ranges': 'bytes',
    // 文件随时可能被替换成同名新版本，缓存住只会让用户看到旧内容
    'Cache-Control': 'no-store',
    'Last-Modified': st.mtime.toUTCString()
  }

  const range = parseRange(req.headers.range, st.size)
  if (range) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': String(end - start + 1)
    })
    if (headOnly || req.method === 'HEAD') return res.end()
    return createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res)
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(st.size) })
  if (headOnly || req.method === 'HEAD') return res.end()
  createReadStream(abs).on('error', () => res.destroy()).pipe(res)
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

function cacheHeader(pathname) {
  // 带内容哈希的资源可以长缓存；入口与前端壳走 no-cache，升级后立刻生效
  if (/\.[0-9a-f]{8,}\.(js|css|woff2?|png|jpg|svg|wasm|data|bin|mem|json)$/i.test(pathname)) {
    return 'public, max-age=31536000, immutable'
  }
  if (pathname.startsWith('/file-viewer/dist/vendor/') || pathname.startsWith('/file-viewer/dist/wasm/')) {
    return 'public, max-age=604800'
  }
  return 'no-cache'
}

/**
 * 把 URL 映射到磁盘文件。
 *
 * 两个静态根：
 *   /file-viewer/dist/*  → vendor/dist/*   （file-viewer 的完整产物）
 *   其它                 → web/*           （本应用的前端）
 *
 * 显式挡掉 `..` 和 NUL：这是本进程唯一可能被外网直接打到的入口，
 * 而且它以 root 跑，路径穿越的代价是整个磁盘。
 */
async function serveStatic(req, res, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return false
  }
  if (rel.includes('\0') || rel.includes('..')) return false

  let baseDir
  let sub
  if (rel === '/file-viewer/dist' || rel.startsWith('/file-viewer/dist/')) {
    baseDir = VIEWER_DIST
    sub = rel.slice('/file-viewer/dist'.length) || '/'
  } else {
    baseDir = WEB_DIR
    sub = rel
  }

  if (sub === '/' || sub === '') sub = '/index.html'
  if (sub.startsWith('/')) sub = sub.slice(1)

  const file = path.join(baseDir, sub)
  if (!isInside(file, baseDir)) return false

  let st
  try {
    st = await fsp.stat(file)
  } catch {
    return false
  }
  if (!st.isFile()) return false

  const ext = path.extname(file).toLowerCase()
  res.writeHead(200, {
    'Content-Type': MIME_STATIC[ext] || mimeOf(file),
    'Content-Length': String(st.size),
    'Cache-Control': cacheHeader(rel)
  })
  // 查看器探测 worker 是否可用时发的是 HEAD 请求，必须支持
  if (req.method === 'HEAD') return res.end(), true
  createReadStream(file).on('error', () => res.destroy()).pipe(res)
  return true
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url
  const headOnly = req.method === 'HEAD'

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      app: 'fnos-file-viewer',
      version: APP_VERSION,
      viewer: VIEWER_VERSION,
      node: process.version
    })
  }

  if (pathname === '/api/config') {
    const roots = allowedRoots()
    return sendJson(res, 200, {
      port: PORT,
      version: APP_VERSION,
      viewer: VIEWER_VERSION,
      multiRoot: multiRoot(),
      localRoot: LOCAL_ROOT || '',
      localRootName: multiRoot() ? '存储空间' : path.basename(LOCAL_ROOT || ROOT) || '本机',
      allowedRoots: roots,
      sources: browseSources(),
      accessMode: UNRESTRICTED ? 'root' : 'scoped',
      unrestricted: UNRESTRICTED,
      storageRoots: detectStorageRoots(),
      appUser: APP_USER,
      uid: typeof process.getuid === 'function' ? process.getuid() : null,
      gid: typeof process.getgid === 'function' ? process.getgid() : null,
      runsAsRoot: IS_ROOT,
      runUsername: process.env.TRIM_RUN_USERNAME || '',
      dataDir: DATA_DIR,
      /** 前端启动时自检用：预览组件有没有正确部署 */
      assets: {
        webDir: WEB_DIR,
        viewerDir: VIEWER_DIST,
        webReady: fs.existsSync(path.join(WEB_DIR, 'index.html')),
        viewerReady: fs.existsSync(
          path.join(VIEWER_DIST, 'flyfish-file-viewer-web-full.iife.js')
        )
      },
      env: {
        rawAccessiblePaths: process.env.TRIM_DATA_ACCESSIBLE_PATHS || '',
        rawSharePaths: process.env.TRIM_DATA_SHARE_PATHS || '',
        rawAllowPrefixes: process.env.ALLOW_PREFIXES || '',
        accessMode: ACCESS_MODE_ENV,
        volRoots: process.env.FNOS_VOL_ROOTS || ''
      }
    })
  }

  if (pathname === '/api/doctor') {
    return sendJson(res, 200, await buildDoctorReport())
  }

  /**
   * 目录列表接口。
   *
   * ★ 现已**不再被前端使用**（本应用取消了文件浏览，只做"打开一个文件"）。
   * 保留它有两个理由：
   *   · 它同时是"目录可遍历性"的探针，`/api/doctor` 的排障链路会用到；
   *   · 外部脚本 / 排障时用 curl 看一眼目录内容很方便。
   * 如果哪天要彻底删掉，记得连带清掉 listLocal 与它的单测。
   */
  if (pathname === '/api/list') {
    const p = searchParams.get('path') || '/'
    return sendJson(res, 200, await listLocal(p))
  }

  /**
   * 打开前的预检：只做权限与存在性检查，不返回内容。
   *
   * 前端拿到 ?path= 之后先问一次这里，被拒时就能显示"为什么打不开"的指引，
   * 而不是把裸 URL 丢给预览组件、由它抛一句看不懂的错误。
   */
  if (pathname === '/api/probe') {
    const p = searchParams.get('path') || ''
    if (!p) return sendJson(res, 400, { error: '缺少 path 参数', code: 'BAD_REQUEST' })
    // 'exact'：不存在就报错，不要兜底成上级目录（见 resolveLocalPath 的说明）
    const abs = await resolveLocalPath(p, 'exact')
    let st
    try {
      st = await fsp.stat(abs)
    } catch (err) {
      throw toApiError(err, abs)
    }
    return sendJson(res, 200, {
      ok: true,
      source: 'local',
      // 回传「修正后」的路径与文件名：客户端据此纠正面包屑 / 显示名，
      // 例如请求里带着百分号编码时，这里给的是解码后的真实文件名。
      path: toClientPath(abs),
      name: path.basename(abs),
      isDir: st.isDirectory(),
      size: st.size,
      mtime: st.mtimeMs,
      info: st.isDirectory() ? null : extInfo(abs),
      readable: await canRead(abs)
    })
  }

  // /api/file 与 /api/file/<文件名>
  // 文件名只是为了满足预览组件"按 URL 后缀判断类型"的规则，真正读哪个文件看 path 参数
  if (pathname === '/api/file' || pathname.startsWith('/api/file/')) {
    const p = searchParams.get('path') || '/'
    const asAttachment = searchParams.get('dl') === '1'
    return void (await streamLocal(p, req, res, headOnly, asAttachment))
  }

  return sendJson(res, 404, { error: '接口不存在：' + pathname, code: 'NO_ROUTE' })
}

/* ------------------------------------------------------------------ */
/* 权限自检                                                            */
/* ------------------------------------------------------------------ */

function ancestorChain(abs) {
  const resolved = path.resolve(abs)
  const parts = resolved.split(path.sep).filter(Boolean)
  const out = []
  let cur = ''
  for (const part of parts) {
    if (!cur) {
      cur = /^[a-zA-Z]:$/.test(part) ? part + path.sep : path.sep + part
    } else {
      cur = cur.endsWith(path.sep) ? cur + part : cur + path.sep + part
    }
    out.push(cur)
  }
  return out
}

async function inspectPath(dir) {
  const info = { path: dir, exists: false, isDir: false, mode: '', uid: null, gid: null }
  try {
    const st = await fsp.stat(dir)
    info.exists = true
    info.isDir = st.isDirectory()
    info.mode = '0' + (st.mode & 0o7777).toString(8)
    info.uid = st.uid
    info.gid = st.gid
  } catch (err) {
    info.error = `${err?.code || ''} ${err?.message || err}`.trim()
    return info
  }
  info.canRead = await permOk(dir, fs.constants.R_OK)
  info.canTraverse = await permOk(dir, fs.constants.X_OK)
  return info
}

async function permOk(p, flag) {
  try {
    await fsp.access(p, flag)
    return true
  } catch {
    return false
  }
}

/**
 * 一次性把"为什么读不到"查清楚。
 *
 * 只在真出问题时才有人看，所以这里不吝啬：把身份、白名单、原始环境变量、
 * 每个浏览根逐级可读性、以及修复命令全列出来。
 */
async function buildDoctorReport() {
  const sources = browseSources()
  const report = {
    ok: true,
    version: APP_VERSION,
    viewer: VIEWER_VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch} ${os.release()}`,
    appUser: APP_USER,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    gid: typeof process.getgid === 'function' ? process.getgid() : null,
    runsAsRoot: IS_ROOT,
    dataDir: DATA_DIR,
    multiRoot: multiRoot(),
    accessMode: UNRESTRICTED ? 'root' : 'scoped',
    unrestricted: UNRESTRICTED,
    sources,
    storageRoots: detectStorageRoots(),
    rawRoots: allowedRoots(),
    runUsername: process.env.TRIM_RUN_USERNAME || '',
    assets: {
      webDir: WEB_DIR,
      viewerDir: VIEWER_DIST,
      webReady: fs.existsSync(path.join(WEB_DIR, 'index.html')),
      viewerReady: fs.existsSync(path.join(VIEWER_DIST, 'flyfish-file-viewer-web-full.iife.js'))
    },
    env: {
      rawAccessiblePaths: process.env.TRIM_DATA_ACCESSIBLE_PATHS || '',
      rawSharePaths: process.env.TRIM_DATA_SHARE_PATHS || '',
      rawAllowPrefixes: process.env.ALLOW_PREFIXES || '',
      accessMode: ACCESS_MODE_ENV,
      volRoots: process.env.FNOS_VOL_ROOTS || ''
    },
    roots: [],
    ancestors: [],
    fixCommands: [],
    hints: []
  }

  const seenAncestors = new Set()

  for (const src of sources) {
    const info = await inspectPath(src.path)
    info.label = src.label

    if (info.exists && info.isDir && info.canRead && info.canTraverse) {
      try {
        const entries = await fsp.readdir(src.path, { withFileTypes: true })
        info.entryCount = entries.length
        info.listable = true
      } catch (err) {
        info.listable = false
        info.listError = `${err?.code || ''} ${err?.message || err}`.trim()
      }
    } else {
      info.listable = false
    }

    if (!info.listable) {
      // 逐级上溯：第一个"进不去"的目录就是根因所在
      const unreachable = []
      for (const level of ancestorChain(src.path)) {
        const lv = await inspectPath(level)
        if (!seenAncestors.has(level)) {
          seenAncestors.add(level)
          report.ancestors.push(lv)
        }
        if (level !== src.path && (!lv.exists || !lv.canTraverse)) unreachable.push(level)
      }
      info.blockedBy = unreachable

      // setfacl 只在应急的 scoped 模式下有意义：root 进程的读权限来自身份，
      // 加 ACL 解决不了它遇到的问题（坏挂载、只读介质…）
      if (SCOPED_MODE) {
        for (const t of [...new Set([...unreachable, src.path])]) {
          report.fixCommands.push(`sudo setfacl -m u:${APP_USER}:rwx "${t}"`)
        }
        report.fixCommands.push(`sudo setfacl -R -m u:${APP_USER}:rwx "${src.path}"`)
      }
    }
    report.roots.push(info)
  }

  if (UNRESTRICTED) {
    if (IS_ROOT) {
      report.hints.push(
        `本服务以 root 身份运行，可以直接读取全部存储空间（${sources.map((s) => s.path).join(' / ') || '（未探测到）'}）—— 不需要授权任何目录。`
      )
    } else {
      report.hints.push(
        `注意：服务进程实际以 ${APP_USER}（uid ${report.uid ?? '-'}）运行，不是 root，` +
          '所以能读到的只有这个账号本身有权限的目录。飞牛上安装包是 root 权限版（config/privilege 里 run-as: root），' +
          '若这里仍然显示非 root，请确认装的是最新包并重启过应用。'
      )
    }
  } else {
    report.hints.push(
      `当前处于应急的「按目录白名单」模式（FNOS_ACCESS_MODE=${ACCESS_MODE_ENV}）：` +
        `只有 ${report.rawRoots.join(' / ') || '（白名单为空）'} 能被读取。正常情况下不需要这个开关。`
    )
  }

  if (!report.assets.viewerReady) {
    report.hints.push(
      `预览组件没有部署完整：找不到 ${path.join(VIEWER_DIST, 'flyfish-file-viewer-web-full.iife.js')}。` +
        '请重新执行 npm run vendor 后重新打包装载。'
    )
  }

  report.fixCommands = [...new Set(report.fixCommands)]
  return report
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://localhost')
  } catch {
    return sendJson(res, 400, { error: '非法请求地址' })
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url)
      return
    }

    if (await serveStatic(req, res, url.pathname)) return

    // SPA 兜底：/open?path=... 之类的路径交给前端路由
    if (req.method === 'GET' || req.method === 'HEAD') {
      const indexPath = path.join(WEB_DIR, 'index.html')
      if (fs.existsSync(indexPath)) {
        const html = await fsp.readFile(indexPath)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': String(html.length),
          'Cache-Control': 'no-cache'
        })
        return res.end(req.method === 'HEAD' ? undefined : html)
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end('<h2>前端文件缺失</h2><p>请重新执行 <code>npm run vendor</code> 后重装应用。</p>')
    }

    sendJson(res, 404, { error: 'Not Found' })
  } catch (err) {
    if (res.headersSent) {
      res.end()
      return
    }
    const api = err instanceof ApiError ? err : toApiError(err)
    if (url.pathname.startsWith('/api/')) {
      if (api.status >= 500) console.error('[api]', api.code, api.message)
      sendJson(res, api.status, { error: api.message, code: api.code, ...api.extra })
    } else {
      res.writeHead(api.status, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('服务器错误：' + api.message)
    }
  }
})

/**
 * PID 文件由服务自己写。
 *
 * cmd/main 里的 `$!` 在 `nohup setsid node … &` 这种写法下拿到的可能是
 * 立刻退出的壳进程，pid 一旦是错的，应用中心就会判定"服务没在跑"，
 * 显示成已停用。让真正在监听的进程写自己的 pid，状态判断才可靠。
 */
const PID_FILE = process.env.FNOS_PID_FILE || ''

function writePidFile() {
  if (!PID_FILE) return
  try {
    fs.writeFileSync(PID_FILE, String(process.pid))
  } catch (err) {
    console.warn('[warn] 写 PID 文件失败：' + (err?.message || err))
  }
}

function clearPidFile() {
  if (!PID_FILE) return
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(PID_FILE, { force: true })
    }
  } catch {
    /* 文件没了也无所谓 */
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearPidFile()
    server.close(() => process.exit(0))
    // 兜底：有长连接挂着时 close 会一直等，1 秒后强退
    setTimeout(() => process.exit(0), 1000).unref()
  })
}

server.on('error', (err) => {
  const msg = `监听 ${HOST}:${PORT} 失败：${err?.code || ''} ${err?.message || err}`
  console.error('[fatal] ' + msg)
  // 应用中心会把这个文件的内容显示出来，用户不用登 SSH 就知道为什么起不来
  const target = process.env.TRIM_TEMP_LOGFILE
  if (target) {
    try {
      fs.writeFileSync(target, msg)
    } catch {
      /* 写不进去就算了 */
    }
  }
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  writePidFile()
  console.log(`[fnos-file-viewer] v${APP_VERSION} (viewer ${VIEWER_VERSION || '?'})`)
  console.log(`  listen   http://${HOST}:${PORT}`)
  console.log(`  web      ${WEB_DIR}`)
  console.log(`  viewer   ${VIEWER_DIST}`)
  console.log(`  uid      ${typeof process.getuid === 'function' ? process.getuid() : '-'} (root=${IS_ROOT})`)
  console.log(`  mode     ${UNRESTRICTED ? 'unrestricted (全盘直读)' : 'scoped (白名单)'}`)
  console.log(`  roots    ${allowedRoots().join(' / ') || '(none)'}`)
})
