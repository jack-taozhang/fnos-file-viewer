/**
 * 「产物解包后再跑一遍」—— 校验 .fpk 真的能用。
 *
 * 为什么必须有这一步：源码目录能跑，完全不代表包里有问题也一样能跑。
 * 打包脚本负责"把文件放进 app.tgz"，而**放进去了 / 放对位置了 / 运行时找得到**
 * 是三件不同的事。这里把 .fpk 解开、按飞牛安装后的布局起服务、打一遍接口，
 * 才能确定"装上去就是这个样子"。
 *
 * 用法：
 *   node scripts/verify-fpk.mjs                       # 取 dist-package 里最新的 .fpk
 *   node scripts/verify-fpk.mjs path/to/xxx.fpk
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTgz, writeEntry } from './lib/tar.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PORT = 18032
const BASE = `http://127.0.0.1:${PORT}`

const SAMPLES = path.join(ROOT, '.verify', 'smoke', 'vol1')

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

const log = (m) => console.log(`\n[fpk-verify] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function newestFpk() {
  const dir = path.join(ROOT, 'dist-package')
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.fpk'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return files.length ? path.join(dir, files[0].f) : null
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
    await sleep(200)
  }
  throw new Error('解包出来的服务没有就绪')
}

async function main() {
  const fpk = process.argv[2] ? path.resolve(process.argv[2]) : newestFpk()
  if (!fpk || !fs.existsSync(fpk)) {
    console.error('[fpk-verify] 找不到 .fpk，先跑 npm run fpk')
    process.exit(1)
  }
  log(`校验 ${path.relative(ROOT, fpk)}（${(fs.statSync(fpk).size / 1048576).toFixed(1)} MB）`)

  const outRoot = path.join(ROOT, '.verify', 'from-fpk')
  try {
    fs.rmSync(outRoot, { recursive: true, force: true })
  } catch {
    /* 批量删除可能被守卫拦下，覆盖写即可 */
  }
  fs.mkdirSync(outRoot, { recursive: true })

  /* ── 1. 解包 .fpk ── */
  const outer = fs.readFileSync(fpk)
  let manifestText = ''
  let appTgz = null
  const entries = []
  readTgz(outer, (e) => {
    entries.push(e.name)
    if (e.name === 'manifest') manifestText = e.read().toString('utf8')
    if (e.name === 'app.tgz') appTgz = Buffer.from(e.read())
    const keep = e.name.startsWith('cmd/') || e.name.startsWith('config/') || e.name === 'manifest'
    if (keep && e.type === 'file') writeEntry(outRoot, e.name, e.read())
    return false
  })

  await ok('包里有 manifest / config / 生命周期脚本 / app.tgz', () => {
    // fnpack 会把 manifest 重新排版（键名补空格对齐、追加 checksum），
    // 所以这里绝不能写死 "appname=xxx" 这种不带空格的形态。
    assert.match(manifestText, /appname\s*=\s*fnos-file-viewer/, `manifest 不对：${manifestText.slice(0, 120)}`)
    assert.ok(appTgz, '没有 app.tgz —— fnOS 会判「不符合系统要求」')
    for (const c of [
      'main',
      'install_init',
      'install_callback',
      'uninstall_init',
      'uninstall_callback',
      'upgrade_init',
      'upgrade_callback',
      'config_init',
      'config_callback',
      'fix-open-type'
    ]) {
      assert.ok(entries.includes(`cmd/${c}`), `缺 cmd/${c}`)
    }

    // 桌面图标入口必须没有被声明（用户要求取消桌面图标）。
    //
    // 注意 fnpack 会**无条件**写一行 `desktop_applaunchname`，我们不声明时
    // 它写成空值。所以判据是"值是不是空"，而不是"键在不在"——
    // 断言键不存在会一直误报（踩过一次）。
    //
    // 用 [^\S\n]* 而不是 \s*：后者能跨行匹配，会把下一行一起吞进来（又踩一次）。
    const desktopLaunch = manifestText.match(/^[^\S\n]*desktop_applaunchname[^\S\n]*=([^\n]*)$/m)
    assert.ok(
      desktopLaunch && desktopLaunch[1].trim() === '',
      `manifest 声明了桌面图标入口（desktop_applaunchname=${desktopLaunch?.[1]?.trim()}），本应用应取消桌面图标`
    )

    // changelog 里不能出现未转义的 ; 或 #（INI 会当注释截断），
    // 这条在 build 阶段也拦，这里对**产物**再核一遍。
    for (const line of manifestText.split(/\r?\n/)) {
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1)
      assert.ok(
        !/[;#]/.test(value),
        `manifest 的 ${key} 值里出现了 ; 或 #，装到飞牛上会被截断：${value.slice(0, 80)}…`
      )
    }
  })

  await ok('manifest 声明 root 权限版且端口为 8030', () => {
    assert.match(manifestText, /service_port\s*=\s*8030/, 'service_port 不是 8030')
    assert.match(manifestText, /disable_authorization_path\s*=\s*true/, '没隐藏授权目录设置项')
    const privilege = JSON.parse(fs.readFileSync(path.join(outRoot, 'config', 'privilege'), 'utf8'))
    assert.equal(privilege.defaults['run-as'], 'root')
  })

  /* ── 2. 解开 app.tgz（飞牛安装后的真实布局） ── */
  const appDir = path.join(outRoot, 'app')
  const appEntries = []
  readTgz(appTgz, (e) => {
    appEntries.push(e.name)
    if (e.type === 'file') writeEntry(appDir, e.name, e.read())
    return false
  })

  await ok('app.tgz 解开后没有 app/ 前缀，且含 ui/ 与 server/ 两棵树', () => {
    assert.ok(appEntries.includes('ui/config'), `app.tgz 里没有 ui/config：${appEntries.slice(0, 8)}`)
    assert.ok(appEntries.includes('server/index.mjs'), 'app.tgz 里没有 server/index.mjs')
    assert.ok(
      appEntries.includes('server/vendor/dist/flyfish-file-viewer-web-full.iife.js'),
      'app.tgz 里没有预览组件入口'
    )
    assert.ok(appEntries.includes('server/web/index.html'), 'app.tgz 里没有前端页面')
    assert.equal(appEntries.filter((n) => n.startsWith('app/')).length, 0, '不该有 app/ 前缀')
  })

  await ok('app/ui/config 的 fileTypes 分多条服务，且每条都装得进 varchar(500)', () => {
    const ui = JSON.parse(fs.readFileSync(path.join(appDir, 'ui', 'config'), 'utf8'))
    const keys = Object.keys(ui['.url']).filter((k) => /\.open\d*$/.test(k))
    assert.ok(keys.length >= 2, `只有 ${keys.length} 条打开方式服务`)

    const all = []
    for (const k of keys) {
      const types = ui['.url'][k].fileTypes
      const chars = JSON.stringify(types).length
      assert.ok(chars <= 500, `${k} 序列化后 ${chars} 字符，超过 500`)
      assert.equal(ui['.url'][k].noDisplay, true, `${k} 不该占桌面图标`)
      assert.equal(ui['.url'][k].title, '用文件预览打开', `${k} 标题不一致，菜单里会看起来像两个应用`)
      assert.equal(ui['.url'][k].type, 'url', `${k} 的 type 不是 url，会嵌在桌面窗口里而不是用浏览器打开`)
      assert.equal(ui['.url'][k].url, '/open', `${k} 的入口不是 /open`)
      assert.equal(ui['.url'][k].port, '8030', `${k} 的端口不是 8030`)
      all.push(...types)
    }
    assert.equal(new Set(all).size, all.length, '多条服务声明了重复扩展名，菜单会重复')
    assert.ok(all.length > 200, `fileTypes 只有 ${all.length} 项`)
    for (const e of ['docx', 'xlsx', 'pptx', 'pdf', 'png', 'mp4', 'zip', 'dwg']) {
      assert.ok(all.includes(e), `fileTypes 缺 ${e}`)
    }

    // 桌面图标入口必须**不存在**（用户要求取消桌面图标，只留双击打开方式）
    const mains = Object.keys(ui['.url']).filter((k) => /\.main$/.test(k))
    assert.equal(mains.length, 0, `app/ui/config 里不该有桌面图标入口：${mains.join(', ')}`)
  })

  /* ── 3. 按飞牛的方式启动它 ── */
  log('按安装后的布局启动服务 …')
  const child = spawn(process.execPath, [path.join(appDir, 'server', 'index.mjs')], {
    cwd: path.join(appDir, 'server'),
    env: { ...process.env, PORT: String(PORT), FNOS_PID_FILE: '', FNOS_VOL_ROOTS: SAMPLES },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const logs = []
  child.stdout.on('data', (d) => logs.push(String(d)))
  child.stderr.on('data', (d) => logs.push(String(d)))

  try {
    const health = await waitHealthy()
    await ok('解包后的服务能起来（说明相对路径解析在安装布局下成立）', () => {
      assert.equal(health.app, 'fnos-file-viewer')
      assert.equal(health.viewer, '3.1.2')
    })

    const cfg = await (await fetch(`${BASE}/api/config`)).json()
    await ok('能从安装布局里找到前端与预览组件', () => {
      assert.equal(cfg.assets.webReady, true, `webDir=${cfg.assets.webDir}`)
      assert.equal(cfg.assets.viewerReady, true, `viewerDir=${cfg.assets.viewerDir}`)
      assert.equal(cfg.unrestricted, true)
    })

    await ok('前端页面 / 静态资源 / renderer 分片都能取到', async () => {
      const html = await fetch(BASE + '/')
      assert.equal(html.status, 200)
      assert.match(await html.text(), /flyfish-file-viewer/)

      const iife = await fetch(BASE + '/file-viewer/dist/flyfish-file-viewer-web-full.iife.js')
      assert.equal(iife.status, 200)
      assert.match(iife.headers.get('content-type'), /javascript/)

      const chunk = await fetch(BASE + '/file-viewer/dist/renderers/pdf.iife.js')
      assert.equal(chunk.status, 200)
      assert.match(chunk.headers.get('content-type'), /javascript/)
      assert.ok((await chunk.text()).length > 50000)
    })

    await ok('能在解包出来的服务上列目录并取文件流', async () => {
      const list = await (await fetch(`${BASE}/api/list?path=/`)).json()
      assert.ok(list.items.length > 0, '顶层没有条目')

      // 存储空间顶层往往只有目录，往下走几层找一个真实文件 ——
      // 别假设"顶层第一个子项里就有文件"。
      let dir = list.items.find((i) => i.isDir) || list.items[0]
      let file = null
      for (let depth = 0; depth < 4 && !file; depth++) {
        const inner = await (await fetch(`${BASE}/api/list?path=${encodeURIComponent(dir.path)}`)).json()
        file = inner.items.find((i) => !i.isDir)
        if (file) break
        const next = inner.items.find((i) => i.isDir)
        if (!next) break
        dir = next
      }
      assert.ok(file, '往下找了 4 层都没找到文件')

      const res = await fetch(
        `${BASE}/api/file/${encodeURIComponent(file.name)}?path=${encodeURIComponent(file.path)}`
      )
      assert.equal(res.status, 200, `取文件失败：${file.path}`)
      assert.equal(res.headers.get('accept-ranges'), 'bytes')
      assert.ok((await res.arrayBuffer()).byteLength > 0)
    })
  } finally {
    child.kill()
    await sleep(500)
    if (child.exitCode && child.exitCode !== 0) console.error(logs.join(''))
  }

  log(`解包产物保留在 ${path.relative(ROOT, outRoot)}（可人工翻看）`)
}

main()
  .then(() => {
    console.log(`\n[fpk-verify] ${passed} 通过 / ${failures.length} 失败`)
    if (failures.length) process.exit(1)
  })
  .catch((err) => {
    console.error('\n[fpk-verify] 运行失败：' + (err?.stack || err))
    process.exit(1)
  })
