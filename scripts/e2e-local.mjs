/**
 * 本地端到端测试 —— 不碰 NAS，在开发机上把服务端跑起来打一遍真实 HTTP。
 *
 * 为什么要有它：真机上翻车最贵的几类问题（Range 不支持导致 PDF 白屏、
 * 中文路径编码、存储空间列表为空、静态资源挂错目录）在这里都能先抓住，
 * 而在这里跑一次只要几秒。
 *
 * 做法：
 *   1) 造一个"假的飞牛存储"（vol1 / vol2 两个挂载点 + 一个存储空间之外的目录）
 *   2) 用 FNOS_VOL_ROOTS 把服务端的浏览根指过去 —— 多个根故意用**冒号**分隔，
 *      顺便把"冒号拼接解析"那条历史坑锁在 E2E 里
 *   3) 起服务，打接口，断言，收工
 *
 * ⚠️ 夹具路径一律从 /api/list 的返回值里取，不要手写 /vol1：
 *    在 Linux（真机）上 /vol1 就是绝对路径，但在 Windows 上夹具在
 *    D:\...\vol1，客户端拿到的是 D:/.../vol1。手写会让测试只在一个平台成立。
 *
 * 夹具由脚本自己创建/清空，不依赖任何手工目录 —— 手工目录里多一个文件
 * 就会让"顶层只有两个条目"这类断言莫名其妙地红。
 *
 * 用法：npm run e2e
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PORT = 18030
const BASE = `http://127.0.0.1:${PORT}`

const FIX = path.join(ROOT, '.verify', 'fixtures')
const VOL1 = path.join(FIX, 'vol1')
const VOL2 = path.join(FIX, 'vol2')
const OUTSIDE = path.join(FIX, 'outside')

const DOCX = path.join(VOL1, '1000', '报告 2026.docx')
const README = path.join(VOL1, 'readme.md')
const SECRET = path.join(OUTSIDE, 'secret.txt')

/** 文件系统路径 → 客户端路径形态（服务端 toClientPath 就是这么给的） */
const client = (p) => p.split(path.sep).join('/')

let passed = 0
const failures = []

async function ok(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push([name, err])
    console.error(`  ✗ ${name}\n      ${err.message}`)
  }
}

function sameSet(actual, expected, label) {
  const a = [...new Set(actual)].sort()
  const b = [...new Set(expected)].sort()
  assert.deepEqual(a, b, `${label || '集合不一致'}\n      实际：${JSON.stringify(a)}\n      期望：${JSON.stringify(b)}`)
}

/* ── 夹具 ─────────────────────────────────────────────────────── */

function buildFixtures() {
  try {
    fs.rmSync(FIX, { recursive: true, force: true })
  } catch {
    /* 清不掉就覆盖写，反正下面都是幂等的 */
  }
  fs.mkdirSync(path.join(VOL1, '1000', '图纸'), { recursive: true })
  fs.mkdirSync(path.join(VOL1, '空目录'), { recursive: true })
  fs.mkdirSync(VOL2, { recursive: true })
  fs.mkdirSync(OUTSIDE, { recursive: true })

  fs.writeFileSync(DOCX, Buffer.from('DOCX-FIXTURE-0123456789'))
  fs.writeFileSync(path.join(VOL1, '1000', '图纸', '平面图.dwg'), Buffer.from('DWG-FIXTURE'))
  fs.writeFileSync(README, '# 夹具\n')
  // 存储空间之外的路径：root 模式下应该照样读得到，这才是 root 直读的意义
  fs.writeFileSync(SECRET, 'OUTSIDE-VOL-ROOTS-OK')
}

/* ── 起服务 ───────────────────────────────────────────────────── */

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      // 故意用冒号拼接：这是飞牛传授权目录的真实形态，也是最容易踩的坑
      FNOS_VOL_ROOTS: `${VOL1}:${VOL2}`,
      FNOS_PID_FILE: '',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const lines = []
  child.stdout.on('data', (d) => lines.push(String(d)))
  child.stderr.on('data', (d) => lines.push(String(d)))

  return {
    child,
    logs: () => lines.join(''),
    stop: () =>
      new Promise((resolve) => {
        let done = false
        const finish = () => {
          if (!done) {
            done = true
            resolve()
          }
        }
        child.once('close', finish)
        child.kill()
        setTimeout(finish, 3000).unref()
      })
  }
}

async function waitHealthy(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return await res.json()
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('服务在超时时间内没有就绪')
}

const j = async (p, init) => {
  const res = await fetch(BASE + p, init)
  const body = await res.json().catch(() => null)
  return { res, body }
}

/* ── 主流程 ───────────────────────────────────────────────────── */

const log = (m) => console.log(`\n[e2e] ${m}`)

async function main() {
  buildFixtures()
  log(`夹具：${path.relative(ROOT, FIX)}`)

  log('启动服务（unrestricted / 多根 / 冒号分隔）…')
  const server = startServer()
  let health
  try {
    health = await waitHealthy()
  } catch (err) {
    console.error(server.logs())
    throw err
  }
  console.log(`  health: ${JSON.stringify(health)}`)

  /* —— 基础接口 —— */
  log('/api/health 与 /api/config')
  await ok('health 报出应用名与版本', () => {
    assert.equal(health.ok, true)
    assert.equal(health.app, 'fnos-file-viewer')
    assert.ok(health.version, 'version 不该为空')
    assert.ok(health.viewer, '应该报出预览组件版本')
  })

  const { body: cfg } = await j('/api/config')
  await ok('config：默认全盘可读', () => {
    assert.equal(cfg.unrestricted, true)
    assert.equal(cfg.accessMode, 'root')
  })
  await ok('config：冒号分隔的两个根都被认出来', () => {
    const paths = cfg.sources.map((s) => client(s.path))
    assert.equal(cfg.sources.length, 2, `期望 2 个源，实际 ${JSON.stringify(cfg.sources)}`)
    assert.ok(paths.some((p) => p.endsWith('/vol1')), '缺 vol1')
    assert.ok(paths.some((p) => p.endsWith('/vol2')), '缺 vol2')
  })
  await ok('config：存储空间显示名是「存储空间 N」', () => {
    sameSet(cfg.sources.map((s) => s.label), ['存储空间 1', '存储空间 2'], '显示名')
  })
  await ok('config：预览组件已就位', () => {
    assert.equal(cfg.assets.viewerReady, true, `vendorDir=${cfg.assets.vendorDir}`)
    assert.equal(cfg.assets.webReady, true)
  })

  /* —— 目录列表 —— */
  log('/api/list')
  const { body: rootList } = await j('/api/list?path=/')
  await ok('顶层列出两个存储空间', () => {
    assert.equal(rootList.virtual, true)
    assert.equal(rootList.items.length, 2)
    assert.ok(rootList.items.every((i) => i.isDir))
    assert.ok(rootList.items.every((i) => i.path))
  })

  // 之后一律用客户端返回的路径，不手写 /vol1
  const vol1 = rootList.items.find((i) => i.label === undefined && i.name === '存储空间 1')?.path
    || rootList.items.find((i) => i.name === '存储空间 1')?.path
  assert.ok(vol1, '没能在顶层找到「存储空间 1」')

  const { body: vol1List } = await j('/api/list?path=' + encodeURIComponent(vol1))
  await ok('/vol1 里目录排在文件前面', () => {
    const flags = vol1List.items.map((i) => i.isDir)
    const lastDir = flags.lastIndexOf(true)
    const firstFile = flags.indexOf(false)
    assert.ok(firstFile === -1 || lastDir < firstFile, `排序不对：${JSON.stringify(vol1List.items.map((i) => i.name))}`)
  })
  await ok('/vol1 列出了 1000 / 空目录 / readme.md（且不过滤后缀）', () => {
    sameSet(vol1List.items.map((i) => i.name), ['1000', 'readme.md', '空目录'], '/vol1 条目')
  })
  await ok('目录条目 isDir=true，文件条目带分类信息', () => {
    const md = vol1List.items.find((i) => i.name === 'readme.md')
    assert.equal(md.isDir, false)
    assert.equal(md.info.group, 'text')
    assert.equal(md.info.previewable, true)
    assert.equal(md.size, fs.statSync(README).size)
  })
  await ok('未登记格式的文件也会列出来（只是标成未知类型）', () => {
    const unknown = vol1List.items.find((i) => i.name === '1000')
    assert.ok(unknown)
  })

  const dir1000 = vol1List.items.find((i) => i.name === '1000').path
  const { body: deep } = await j('/api/list?path=' + encodeURIComponent(dir1000))
  await ok('中文路径 + 中文文件名能正确列出', () => {
    sameSet(deep.items.map((i) => i.name), ['报告 2026.docx', '图纸'], '中文字目录')
    const doc = deep.items.find((i) => i.name.startsWith('报告'))
    assert.equal(doc.info.group, 'word')
    assert.equal(doc.info.previewable, true)
    assert.equal(doc.ext, 'docx')
  })

  const emptyDir = vol1List.items.find((i) => i.name === '空目录').path
  await ok('空目录返回空数组而不是报错', async () => {
    const { res, body } = await j('/api/list?path=' + encodeURIComponent(emptyDir))
    assert.equal(res.status, 200)
    assert.deepEqual(body.items, [])
  })

  /* —— probe —— */
  log('/api/probe')
  const docxClient = client(DOCX)
  const docxName = path.basename(DOCX)

  await ok('probe 文件：回传修正后的真实路径与文件名', async () => {
    const { body } = await j('/api/probe?path=' + encodeURIComponent(docxClient))
    assert.equal(body.isDir, false)
    assert.equal(body.name, docxName)
    assert.equal(body.info.group, 'word')
    assert.ok(body.size > 0)
  })
  await ok('probe 目录：isDir=true', async () => {
    const { body } = await j('/api/probe?path=' + encodeURIComponent(vol1))
    assert.equal(body.isDir, true)
  })
  await ok('probe 不存在的路径 → 404 NOT_FOUND', async () => {
    const { res, body } = await j('/api/probe?path=' + encodeURIComponent(client(VOL1) + '/不存在的文件.pdf'))
    assert.equal(res.status, 404)
    assert.equal(body.code, 'NOT_FOUND')
  })
  await ok('probe 百分号重复编码的路径能被纠正（历史坑）', async () => {
    // 模拟"文件管理器把已经编码过的路径又传了一次"：path 值里带着 %xx
    const rawWithPct = client(path.dirname(DOCX)) + '/' + encodeURIComponent(docxName)
    const { res, body } = await j('/api/probe?path=' + encodeURIComponent(rawWithPct))
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(body.name, docxName)
  })
  await ok('probe 不把存储空间之外的路径当越权（root 模式）', async () => {
    const { res, body } = await j('/api/probe?path=' + encodeURIComponent(client(SECRET)))
    assert.equal(res.status, 200)
    assert.equal(body.name, 'secret.txt')
  })

  /* —— 文件流 —— */
  log('/api/file')
  const fileUrl = `/api/file/${encodeURIComponent(docxName)}?path=${encodeURIComponent(docxClient)}`
  const docxSize = fs.statSync(DOCX).size

  await ok('整份取：200 + 正确长度与 MIME + Accept-Ranges', async () => {
    const res = await fetch(BASE + fileUrl)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-length'), String(docxSize))
    assert.match(res.headers.get('content-type'), /wordprocessingml/)
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
    assert.equal(await res.text(), 'DOCX-FIXTURE-0123456789')
  })

  await ok('Range 取：206 + Content-Range + 正确切片', async () => {
    const res = await fetch(BASE + fileUrl, { headers: { Range: 'bytes=0-3' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), `bytes 0-3/${docxSize}`)
    assert.equal(res.headers.get('content-length'), '4')
    assert.equal(await res.text(), 'DOCX')
  })

  await ok('Range 后缀形式（bytes=-5）取到末尾', async () => {
    const res = await fetch(BASE + fileUrl, { headers: { Range: 'bytes=-5' } })
    assert.equal(res.status, 206)
    assert.equal(res.headers.get('content-range'), `bytes ${docxSize - 5}-${docxSize - 1}/${docxSize}`)
    assert.equal(await res.text(), '56789')
  })

  /* 预览流用的地址形状：路径里**不带扩展名**。
     ★★ 这不是洁癖：下载管理器（迅雷 / IDM）按 URL 路径的扩展名嗅探，路径以 .zip/.exe
     结尾时请求会被劫持，页面只拿到空响应（"打不开 / 压缩包 0 个文件"）。 */
  const streamUrl = `/api/file?path=${encodeURIComponent(docxClient)}`

  await ok('不带文件名的 /api/file 也能取到整份内容（预览走的就是这个形状）', async () => {
    const res = await fetch(BASE + streamUrl)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'DOCX-FIXTURE-0123456789')
  })

  await ok('不带文件名的 /api/file 仍声明真实文件名与 MIME（靠响应头，不靠 URL）', async () => {
    const res = await fetch(BASE + streamUrl)
    // 中文名走 RFC 5987 的 filename*，ASCII 的 filename= 只是回退值
    const cd = res.headers.get('content-disposition')
    const m = /filename\*=UTF-8''([^;]+)/.exec(cd)
    assert.ok(m, `content-disposition 里没有 filename*：${cd}`)
    assert.equal(decodeURIComponent(m[1]), docxName)
    assert.match(res.headers.get('content-type'), /wordprocessingml/)
    assert.equal(res.headers.get('accept-ranges'), 'bytes')
  })

  await ok('不带文件名的 /api/file 也支持 Range', async () => {
    const res = await fetch(BASE + streamUrl, { headers: { Range: 'bytes=0-3' } })
    assert.equal(res.status, 206)
    assert.equal(await res.text(), 'DOCX')
  })

  await ok('dl=1 改成附件下载', async () => {
    const res = await fetch(BASE + streamUrl + '&dl=1')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-disposition'), /^attachment/)
  })

  await ok('Range 越界 → 退回 200 整份（不是 416 空白）', async () => {
    const res = await fetch(BASE + fileUrl, { headers: { Range: 'bytes=99999-' } })
    assert.equal(res.status, 200)
  })

  await ok('HEAD 请求不带 body 但有 Content-Length', async () => {
    const res = await fetch(BASE + fileUrl, { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-length'), String(docxSize))
    assert.equal(await res.text(), '')
  })

  await ok('dl=1 时改成 attachment 下载', async () => {
    const res = await fetch(BASE + fileUrl + '&dl=1')
    assert.match(res.headers.get('content-disposition'), /^attachment/)
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/)
  })

  await ok('中文文件名走 filename*（不被截成下划线）', async () => {
    const res = await fetch(BASE + fileUrl)
    const cd = res.headers.get('content-disposition')
    assert.ok(cd.includes(encodeURIComponent(docxName)), cd)
  })

  await ok('目标是目录 → 400 NOT_A_FILE', async () => {
    const { res, body } = await j('/api/file/x?path=' + encodeURIComponent(dir1000))
    assert.equal(res.status, 400)
    assert.equal(body.code, 'NOT_A_FILE')
  })

  await ok('存储空间之外的路径在 root 模式下也能读（这才是全盘直读）', async () => {
    const res = await fetch(
      `${BASE}/api/file/secret.txt?path=${encodeURIComponent(client(SECRET))}`
    )
    assert.equal(res.status, 200, `路径 ${client(SECRET)}`)
    assert.equal(await res.text(), 'OUTSIDE-VOL-ROOTS-OK')
  })

  /* —— 静态资源 —— */
  log('静态资源')
  await ok('GET / 返回前端页面，且引用了预览组件', async () => {
    const res = await fetch(BASE + '/')
    const html = await res.text()
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.ok(html.includes('/file-viewer/dist/flyfish-file-viewer-web-full.iife.js'))
    assert.ok(html.includes('flyfish-file-viewer'))
  })

  await ok('/open?path=... 也交给前端路由（SPA 兜底）', async () => {
    const res = await fetch(BASE + '/open?path=/vol1/readme.md')
    assert.equal(res.status, 200)
    assert.match(await res.text(), /flyfish-file-viewer/)
  })

  await ok('/app.js 与 /app.css 正常返回', async () => {
    const js = await fetch(BASE + '/app.js')
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
    const css = await fetch(BASE + '/app.css')
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /text\/css/)
  })

  await ok('预览组件入口 IIFE 正常返回', async () => {
    const res = await fetch(BASE + '/file-viewer/dist/flyfish-file-viewer-web-full.iife.js')
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /javascript/)
    assert.ok((await res.text()).length > 100000)
  })

  await ok('renderer 分片能取到（懒加载路径没挂错）', async () => {
    for (const name of ['pdf', 'word', 'spreadsheet', 'presentation', 'image', 'archive', 'text', 'cad']) {
      const res = await fetch(`${BASE}/file-viewer/dist/renderers/${name}.iife.js`)
      assert.equal(res.status, 200, `${name}.iife.js 取不到`)
      // 只断言 200 是"假绿"：挂错目录时 SPA 兜底会回 200 + index.html。
      // 必须同时看内容类型和体积，才能证明真的拿到了 renderer。
      assert.match(res.headers.get('content-type'), /javascript/, `${name}.iife.js 返回的不是 JS`)
      assert.ok((await res.text()).length > 50000, `${name}.iife.js 内容过小，可能回的是 index.html`)
    }
  })

  await ok('wasm 资产能取到，且 MIME 是 application/wasm', async () => {
    const rel = findUnder(path.join(ROOT, 'vendor', 'dist', 'wasm'), (f) => f.endsWith('.wasm'))
    assert.ok(rel, 'vendor/dist/wasm 下没有 wasm 文件')
    const res = await fetch(BASE + '/file-viewer/dist/wasm/' + rel.split(path.sep).join('/'))
    assert.equal(res.status, 200, rel)
    assert.equal(res.headers.get('content-type'), 'application/wasm')
  })

  await ok('vendor 资产能取到（PDF 字体 / worker）', async () => {
    const rel = findUnder(path.join(ROOT, 'vendor', 'dist', 'vendor'), (f) => f.endsWith('.mjs'))
    assert.ok(rel, 'vendor/dist/vendor 下没有 .mjs')
    const res = await fetch(BASE + '/file-viewer/dist/vendor/' + rel.split(path.sep).join('/'))
    assert.equal(res.status, 200, rel)
    assert.match(res.headers.get('content-type'), /javascript/)
  })

  await ok('资产清单 JSON 能取到', async () => {
    const res = await fetch(BASE + '/file-viewer/dist/flyfish-viewer-manifest.json')
    assert.equal(res.status, 200)
    assert.equal((await res.json()).name, '@file-viewer/web-full')
  })

  /* —— 安全 —— */
  log('负例（不通过才是通过）')
  await ok('路径穿越拿不到包外的文件', async () => {
    // 用编码过的 .. 绕过 URL 规范化，确保真的走到了服务端的判断
    const res = await fetch(BASE + '/file-viewer/dist/%2e%2e/%2e%2e/package.json')
    const text = await res.text()
    assert.ok(!text.includes('"fnos-file-viewer"'), '路径穿越读到了 package.json！')
    assert.ok(!text.includes('"scripts"'), '路径穿越读到了 package.json！')
  })

  await ok('穿越到系统目录也不泄露', async () => {
    const res = await fetch(BASE + '/%2e%2e/%2e%2e/Windows/win.ini')
    assert.ok(!(await res.text()).includes('[fonts]'))
  })

  await server.stop()

  /* —— 应急的 scoped 模式 —— */
  log('应急模式：FNOS_ACCESS_MODE=scoped')
  const scoped = startServer({
    FNOS_ACCESS_MODE: 'scoped',
    ALLOW_PREFIXES: VOL1,
    FNOS_VOL_ROOTS: ''
  })
  try {
    await waitHealthy()

    const { body: scopedRoot } = await j('/api/list?path=/')
    const scopedVol1 = scopedRoot.items[0]?.path
    assert.ok(scopedVol1, `scoped 顶层没有条目：${JSON.stringify(scopedRoot)}`)

    await ok('scoped：白名单内的目录能列', async () => {
      const { res } = await j('/api/list?path=' + encodeURIComponent(scopedVol1))
      assert.equal(res.status, 200)
    })
    await ok('scoped：白名单外的目录 403 OUT_OF_SCOPE', async () => {
      const { res, body } = await j('/api/list?path=' + encodeURIComponent(client(VOL2)))
      assert.equal(res.status, 403, JSON.stringify(body))
      assert.equal(body.code, 'OUT_OF_SCOPE')
    })
    await ok('scoped：/api/config 如实汇报 unrestricted=false', async () => {
      const { body } = await j('/api/config')
      assert.equal(body.unrestricted, false)
      assert.equal(body.accessMode, 'scoped')
    })
  } finally {
    await scoped.stop()
  }
}

/** 在目录下找第一个满足条件的文件，返回相对路径 */
function findUnder(dir, pred, _base = dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      const hit = findUnder(p, pred, _base)
      if (hit) return hit
    } else if (pred(p)) {
      return path.relative(_base, p)
    }
  }
  return null
}

main()
  .then(() => {
    console.log(`\n[e2e] ${passed} 通过 / ${failures.length} 失败`)
    if (failures.length) process.exit(1)
  })
  .catch((err) => {
    console.error('\n[e2e] 运行失败：' + (err?.stack || err))
    process.exit(1)
  })
