/**
 * 真实浏览器冒烟：确认「浏览器里真的渲染出来了」。
 *
 * 为什么非要有它：接口全绿完全不等于能用。线上最容易发生的是
 * **请求都成功、页面却是白的**（资产路径挂错、renderer 拉不到、组件没注册），
 * 而"失败请求数 = 0"在这种情况下恰恰也是 0 —— 光看网络统计会得到假绿。
 * 唯一可信的判据是：渲染结果真的出现在 DOM 里（canvas 有尺寸 / 文本能读到）。
 *
 * 做法（零第三方依赖）：
 *   1) 造真实样例文件（含一个结构完整的 PDF —— 它能顺带验证 worker/wasm 资产路径）
 *   2) 起服务、起 headless Chrome（CDP 直连）
 *   3) 逐个打开文件，轮询 DOM 探针，直到看到 canvas / 文本 / img
 *   4) 顺手抓 console 报错、4xx 响应、加载失败，作为诊断信息
 *   5) 每个用例存一张截图到 .verify/screenshots/，便于人工复核
 *
 * 用法：npm run smoke
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MARKERS, writeSamples } from './lib/samples.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const PORT = 18031
const DEBUG_PORT = 19333
const BASE = `http://127.0.0.1:${PORT}`

const VOL1 = path.join(ROOT, '.verify', 'smoke', 'vol1')
const SAMPLES_DIR = path.join(VOL1, '样例文件')
const SHOTS = path.join(ROOT, '.verify', 'screenshots')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => console.log(`\n[smoke] ${m}`)

/* ── CDP ──────────────────────────────────────────────────────── */

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    const listeners = new Map()
    let seq = 0

    const api = {
      send(method, params) {
        const id = ++seq
        return new Promise((res, rej) => {
          pending.set(id, { res, rej })
          ws.send(JSON.stringify({ id, method, params: params || {} }))
        })
      },
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(fn)
      },
      once(event, timeoutMs = 15000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`等待事件 ${event} 超时`)), timeoutMs)
          api.on(event, (p) => {
            clearTimeout(timer)
            res(p)
          })
        })
      },
      close() {
        try {
          ws.close()
        } catch {
          /* 已经关了 */
        }
      }
    }

    ws.addEventListener('open', () => resolve(api))
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'))
      } catch {
        return
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(`${msg.error.message} ${msg.error.data || ''}`.trim()))
        else res(msg.result)
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params)
      }
    })
  })
}

async function pollJson(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return await res.json()
    } catch (err) {
      lastErr = err
    }
    await sleep(200)
  }
  throw new Error(`等待 ${url} 超时：${lastErr?.message || ''}`)
}

/* ── 服务端 ───────────────────────────────────────────────────── */

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      FNOS_VOL_ROOTS: VOL1,
      FNOS_PID_FILE: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const out = []
  child.stdout.on('data', (d) => out.push(String(d)))
  child.stderr.on('data', (d) => out.push(String(d)))
  return {
    child,
    logs: () => out.join(''),
    stop: () =>
      new Promise((resolve) => {
        let done = false
        const fin = () => {
          if (!done) {
            done = true
            resolve()
          }
        }
        child.once('close', fin)
        child.kill()
        setTimeout(fin, 3000).unref()
      })
  }
}

/* ── DOM 探针 ─────────────────────────────────────────────────── */

/**
 * 在页面里跑，判断"到底渲染出来没有"。
 *
 * 注意要**递归穿过 shadow root**：file-viewer 默认用 Shadow DOM 隔离样式，
 * 只在 document 上 querySelector 会一个 canvas 都找不到 ——
 * 那样会得到"看起来没渲染"的错误结论。
 */
const PROBE = `(() => {
  const out = { host: false, shadow: false, canvases: [], imgs: [], text: '', errVisible: false, errText: '' };
  const host = document.querySelector('flyfish-file-viewer');
  const errEl = document.getElementById('error');
  if (errEl && !errEl.classList.contains('hidden')) {
    out.errVisible = true;
    out.errText = errEl.innerText || '';
  }
  if (!host) return out;
  out.host = true;
  out.shadow = !!host.shadowRoot;

  // ⚠️ 只取"文本节点"，不能直接用 textContent：
  //    组件把样式注入在 shadow root 里的 <style> 标签内，
  //    textContent 会把整份 CSS 也算进来，真正的文档内容被挤到几百字之后，
  //    于是"文本没渲染出来"会成为假警报。
  const SKIP = new Set(['STYLE','SCRIPT','TEMPLATE','NOSCRIPT','LINK','META','TITLE']);
  let text = '';
  const canvases = [];
  const imgs = [];
  const walk = (root) => {
    for (const node of root.childNodes) {
      if (node.nodeType === 3) { text += node.nodeValue; continue; }
      if (node.nodeType !== 1) continue;
      if (SKIP.has(node.tagName)) continue;
      if (node.tagName === 'CANVAS') canvases.push(node.width + 'x' + node.height);
      else if (node.tagName === 'IMG') imgs.push(node.naturalWidth + 'x' + node.naturalHeight);
      if (node.shadowRoot) walk(node.shadowRoot);
      walk(node);
    }
  };
  walk(host.shadowRoot || host);

  out.canvases = canvases;
  out.imgs = imgs;
  out.text = text.slice(0, 8000);
  return out;
})()`

const bigCanvas = (list) => list.some((s) => Number(String(s).split('x')[0]) > 120)
const bigImg = (list) => list.some((s) => Number(String(s).split('x')[0]) > 60)

/* ── 主流程 ───────────────────────────────────────────────────── */

async function main() {
  /* 夹具 */
  try {
    fs.rmSync(path.join(ROOT, '.verify', 'smoke'), { recursive: true, force: true })
  } catch {
    /* 清不掉就覆盖 */
  }
  writeSamples(SAMPLES_DIR)
  fs.mkdirSync(SHOTS, { recursive: true })

  const chromePath = CHROME_CANDIDATES.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
  if (!chromePath) {
    console.error('[smoke] 找不到 Chrome，可用 CHROME_PATH 环境变量指定；跳过浏览器冒烟。')
    process.exit(0)
  }

  log('启动服务 …')
  const server = startServer()
  await pollJson(`${BASE}/api/health`)
  console.log('  服务就绪')

  log('启动 headless Chrome …')
  // 干净 profile：上一次的 localStorage / 缓存会让"页签状态被继承"这类问题变难复现。
  // ⚠️ 别去 rmSync 上一轮的 profile（几百个文件会触发本机批量删除确认），
  //    直接用时间戳后缀拿一个新目录。
  const profile = path.join(ROOT, '.verify', 'chrome-profile-' + Date.now())
  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  let cdp = null
  try {
    const list = await pollJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
    const page = list.find((t) => t.type === 'page')
    assert.ok(page, 'Chrome 没有可用的 page target')
    cdp = await cdpConnect(page.webSocketDebuggerUrl)
    console.log('  CDP 已连接')

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')

    const consoleErrors = []
    const badResponses = []
    const loadFailures = []
    /**
     * 被"下载嗅探"盯上的请求。
     *
     * 下载管理器（迅雷 / IDM 等）按 **URL 路径的扩展名** 劫持请求：路径以 .zip/.exe/.iso
     * 这类结尾时，请求被它抢走、页面拿到空响应 —— 症状是"文件打不开 / 压缩包 0 个文件"，
     * 而且会莫名弹出下载窗口。所以本应用所有 URL 都**不带扩展名**。
     * 这条守则如果破了，本用例会直接红，不必等到用户在迅雷弹窗里发现。
     */
    const sniffable = []
    const SNIFF_RE =
      /\.(zip|rar|7z|tar|gz|tgz|bz2|xz|cab|iso|apk|exe|msi|dmg|pkg|deb|rpm|docx?|xlsx?|pptx?|pdf|mp4|mkv|avi)$/i
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') {
        consoleErrors.push(`[${p.type}] ${(p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
      }
    })
    cdp.on('Runtime.exceptionThrown', (p) => {
      consoleErrors.push(`[exception] ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`)
    })
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') consoleErrors.push(`[log] ${p.entry.text} ${p.entry.url || ''}`)
    })
    cdp.on('Network.requestWillBeSent', (p) => {
      try {
        const u = new URL(p.request.url)
        if (u.origin === BASE && SNIFF_RE.test(u.pathname)) sniffable.push(u.pathname)
      } catch {
        /* data:/blob: 之类忽略 */
      }
    })
    cdp.on('Network.responseReceived', (p) => {
      if (p.response?.status >= 400) badResponses.push(`${p.response.status} ${p.response.url}`)
    })
    cdp.on('Network.loadingFailed', (p) => {
      // ERR_ABORTED 是"主动取消"，不是失败：切换页面 / 组件重新发起请求时
      // 一定会出现，把它当错误只会制造噪音，掩盖真正的加载失败。
      if (p.errorText === 'net::ERR_ABORTED') return
      loadFailures.push(`${p.errorText} ${p.type || ''}`)
    })

    async function goto(url) {
      consoleErrors.length = 0
      badResponses.length = 0
      loadFailures.length = 0
      const loaded = cdp.once('Page.loadEventFired', 20000)
      await cdp.send('Page.navigate', { url })
      await loaded.catch(() => {})
    }

    async function evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false
      })
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
      }
      return r.result.value
    }

    /** 轮询到 pred 为真；超时则返回最后一次探测结果 */
    async function waitRender(pred, timeoutMs = 25000) {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        last = await evaluate(PROBE)
        if (last.errVisible) return last
        if (pred(last)) return last
        await sleep(400)
      }
      return last
    }

    async function screenshot(name) {
      try {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'))
      } catch (err) {
        console.error(`      （截图 ${name} 失败：${err.message}）`)
      }
    }

    const fileUrl = (file) =>
      `${BASE}/?path=${encodeURIComponent(file.split(path.sep).join('/'))}`

    /* ── 用例 ── */

    log('1) 页面本身（取消文件浏览后：不再有文件树，只有预览）')
    await goto(BASE + '/')
    await ok('前端能加载，预览组件脚本已注册', async () => {
      const ready = await evaluate(
        `!!(window.FlyfishFileViewerWebFull && customElements.get('flyfish-file-viewer'))`
      )
      assert.ok(ready, `预览组件没注册；console：${consoleErrors.slice(0, 5).join(' | ')}`)
    })
    await ok('没有 ?path= 时给出说明（而不是白屏，也不再列文件树）', async () => {
      const s = await evaluate(
        `(() => {
           const e = document.getElementById('empty');
           return {
             visible: !!(e && !e.classList.contains('hidden')),
             text: (e && e.innerText) || '',
             hasSidebar: !!document.getElementById('sidebar'),
             hasList: !!document.getElementById('list'),
             iframes: document.querySelectorAll('iframe').length
           };
         })()`
      )
      assert.equal(s.visible, true, '说明页没有出现')
      assert.match(s.text, /没有指定要预览的文件/, `说明文案不对：${s.text}`)
      assert.equal(s.hasSidebar, false, '不该再有文件浏览侧栏')
      assert.equal(s.hasList, false, '不该再有文件树')
      // 「取消页面嵌套」：应用内部不得再套 iframe
      assert.equal(s.iframes, 0, `页面里出现了 ${s.iframes} 个 iframe`)
    })
    await screenshot('01-no-path')

    /* PDF：最重的一条链路（pdf.js + worker + wasm + 字体） */
    let probe = null
    log('2) PDF 渲染')
    await goto(fileUrl(path.join(SAMPLES_DIR, 'sample.pdf')))
    probe = await waitRender((p) => bigCanvas(p.canvases))
    await ok('PDF 渲染出 canvas（说明 worker / wasm / 字体资产路径都对）', () => {
      assert.ok(!probe.errVisible, `界面报错了：${probe.errText}`)
      assert.ok(bigCanvas(probe.canvases), `没看到有尺寸的 canvas：${JSON.stringify(probe.canvases)}`)
    })
    await ok('PDF 链路没有资源加载失败', () => {
      assert.deepEqual(loadFailures, [], `加载失败：${loadFailures.join(' | ')}`)
    })
    await screenshot('02-pdf')

    /* 图片 */
    log('3) 图片渲染')
    await goto(fileUrl(path.join(SAMPLES_DIR, 'sample.png')))
    probe = await waitRender((p) => bigImg(p.imgs) || bigCanvas(p.canvases))
    await ok('PNG 渲染出 <img> 或 canvas', () => {
      assert.ok(!probe.errVisible, `界面报错了：${probe.errText}`)
      assert.ok(
        bigImg(probe.imgs) || bigCanvas(probe.canvases),
        `imgs=${JSON.stringify(probe.imgs)} canvases=${JSON.stringify(probe.canvases)}`
      )
    })
    await screenshot('03-png')

    /* SVG */
    log('4) SVG 渲染')
    await goto(fileUrl(path.join(SAMPLES_DIR, 'sample.svg')))
    probe = await waitRender((p) => bigImg(p.imgs) || bigCanvas(p.canvases))
    await ok('SVG 渲染出来了', () => {
      assert.ok(!probe.errVisible, `界面报错了：${probe.errText}`)
      assert.ok(
        bigImg(probe.imgs) || bigCanvas(probe.canvases),
        `imgs=${JSON.stringify(probe.imgs)} canvases=${JSON.stringify(probe.canvases)}`
      )
    })
    await screenshot('04-svg')

    /* 纯文本 */
    log('5) 文本渲染')
    await goto(fileUrl(path.join(SAMPLES_DIR, 'sample.txt')))
    probe = await waitRender((p) => p.text.includes(MARKERS.txt))
    await ok('TXT 的内容出现在 DOM 里（不是白屏）', () => {
      assert.ok(!probe.errVisible, `界面报错了：${probe.errText}`)
      assert.ok(
        probe.text.includes(MARKERS.txt),
        `没读到文本标记；实际文本前 200 字：${JSON.stringify(probe.text.slice(0, 200))}`
      )
    })
    await screenshot('05-txt')

    /* Markdown */
    log('6) Markdown 渲染')
    await goto(fileUrl(path.join(SAMPLES_DIR, 'sample.md')))
    probe = await waitRender((p) => p.text.includes(MARKERS.md))
    await ok('Markdown 的内容出现在 DOM 里', () => {
      assert.ok(!probe.errVisible, `界面报错了：${probe.errText}`)
      assert.ok(
        probe.text.includes(MARKERS.md),
        `没读到文本标记；实际文本前 200 字：${JSON.stringify(probe.text.slice(0, 200))}`
      )
    })
    await screenshot('06-markdown')

    /* 压缩包：走 libarchive worker + wasm，是"懒加载资产 + Worker"另一条独立链路 */
    log('7) ZIP 压缩包')
    await goto(fileUrl(path.join(SAMPLES_DIR, 'sample.zip')))
    probe = await waitRender(
      (p) => p.text.includes(MARKERS.zipEntry) || p.text.includes(MARKERS.zipDir)
    )
    await ok('ZIP 的包内条目出现在 DOM 里（归档真的被解开了）', () => {
      assert.ok(!probe.errVisible, `界面报错了：${probe.errText}`)
      assert.ok(
        probe.text.includes(MARKERS.zipEntry),
        `没读到包内条目名；实际文本前 300 字：${JSON.stringify(probe.text.slice(0, 300))}`
      )
    })
    await ok('ZIP 链路没有资源加载失败', () => {
      assert.deepEqual(loadFailures, [], `加载失败：${loadFailures.join(' | ')}`)
    })
    await screenshot('07-zip')

    /* 负例：不存在的路径必须给出明确错误，而不是白屏 */
    log('8) 负例：一个读不到的文件')
    await goto(`${BASE}/?path=${encodeURIComponent('/vol1/不存在的目录/没有这个文件.pdf')}`)
    await sleep(1500)
    const errState = await evaluate(
      `(() => { const e = document.getElementById('error'); return { visible: e && !e.classList.contains('hidden'), text: e ? e.innerText : '' } })()`
    )
    await ok('路径不存在时给出可读的错误提示（不是白屏）', () => {
      assert.ok(errState.visible, '错误面板没有出现')
      assert.match(errState.text, /打不开|不存在|权限/, `错误文案不对：${errState.text}`)
    })
    await screenshot('08-notfound')

    /* 全局守则：整轮跑下来，不能有任何"会被下载器嗅探"的地址 */
    log('9) 守住"URL 不带扩展名"这条规则')
    await ok('没有任何请求的路径以可下载扩展名结尾（否则会被迅雷/IDM 劫持）', () => {
      assert.deepEqual(
        [...new Set(sniffable)],
        [],
        `这些地址会被下载管理器抢走：${[...new Set(sniffable)].join(' 、 ')}`
      )
    })

    console.log(`\n[smoke] 截图目录：${path.relative(ROOT, SHOTS)}`)
  } finally {
    cdp?.close()
    chrome.kill()
    await server.stop()
    // profile 目录留给用户按需清理：一次删几百个文件会触发本机批量删除确认
  }
}

main()
  .then(() => {
    console.log(`\n[smoke] ${passed} 通过 / ${failures.length} 失败`)
    if (failures.length) process.exit(1)
  })
  .catch((err) => {
    console.error('\n[smoke] 运行失败：' + (err?.stack || err))
    process.exit(1)
  })
