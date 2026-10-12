/**
 * 一次性诊断：ZIP 打开时到底发生了什么。
 * 抓全部 console（不限 error/warning）+ 全部网络请求（含 worker 脚本），
 * 不设断言，只打印事实。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeSamples } from './lib/samples.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// 端口按 pid 派生：避免上一轮残留进程占着固定端口，导致"新进程 bind 失败、
// 浏览器却一直在跟旧进程说话"这种看不见的污染（`ss` 在 Git Bash 下看不到 Windows 其它进程的监听）。
const PORT = 20000 + (process.pid % 4000)
const DEBUG_PORT = PORT + 5000
const BASE = `http://127.0.0.1:${PORT}`
const VOL1 = path.join(ROOT, '.verify', 'diag', 'vol1')
const SAMPLES = path.join(VOL1, '样例文件')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean).find((p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
})

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
      on(e, fn) {
        if (!listeners.has(e)) listeners.set(e, [])
        listeners.get(e).push(fn)
      },
      once(e, t = 15000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('timeout ' + e)), t)
          api.on(e, (p) => {
            clearTimeout(timer)
            res(p)
          })
        })
      },
      close() {
        try {
          ws.close()
        } catch {
          /* ignore */
        }
      }
    }
    ws.addEventListener('open', () => resolve(api))
    ws.addEventListener('error', () => reject(new Error('ws fail')))
    ws.addEventListener('message', (ev) => {
      let m
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString())
      } catch {
        return
      }
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) rej(new Error(m.error.message))
        else res(m.result)
      } else if (m.method) {
        for (const fn of listeners.get(m.method) || []) fn(m.params)
      }
    })
  })
}

async function pollJson(url, t = 20000) {
  const dl = Date.now() + t
  while (Date.now() < dl) {
    try {
      const r = await fetch(url)
      if (r.ok) return await r.json()
    } catch {
      /* retry */
    }
    await sleep(200)
  }
  throw new Error('poll timeout ' + url)
}

async function main() {
  try {
    fs.rmSync(path.join(ROOT, '.verify', 'diag'), { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  writeSamples(SAMPLES)

  const server = spawn(process.execPath, [process.env.DIAG_SERVER || path.join(ROOT, 'server', 'index.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), FNOS_VOL_ROOTS: VOL1, FNOS_PID_FILE: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const slog = []
  server.stdout.on('data', (d) => slog.push(String(d)))
  server.stderr.on('data', (d) => slog.push(String(d)))
  await pollJson(`${BASE}/api/health`)

  const profile = path.join(ROOT, '.verify', 'diag-profile-' + Date.now())
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      '--no-first-run',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  const list = await pollJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
  const page = list.find((t) => t.type === 'page')
  const cdp = await cdpConnect(page.webSocketDebuggerUrl)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Network.enable')
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true
  })

  const logs = []
  const reqs = []
  cdp.on('Runtime.consoleAPICalled', (p) => {
    logs.push(
      `[console.${p.type}] ` +
        (p.args || []).map((a) => a.value ?? a.description ?? a.type ?? '').join(' ').slice(0, 500)
    )
  })
  cdp.on('Runtime.exceptionThrown', (p) => {
    logs.push(`[exception] ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`)
  })
  cdp.on('Log.entryAdded', (p) => logs.push(`[log.${p.entry?.level}] ${p.entry?.text} ${p.entry?.url || ''}`))
  cdp.on('Network.requestWillBeSent', (p) => {
    if (p.type === 'Document' || p.type === 'Script' || p.type === 'Fetch' || p.type === 'XHR' || p.type === 'Other') {
      reqs.push(`REQ  ${p.type.padEnd(8)} ${p.request.url}`)
    }
    if (/\/api\/file/.test(p.request.url)) {
      reqs.push(`     ↳ 请求头: ${JSON.stringify(p.request.headers)}`)
    }
  })
  cdp.on('Network.responseReceived', (p) => {
    if (p.type === 'Script' || p.type === 'Fetch' || p.type === 'XHR' || p.type === 'Other' || p.type === 'Document') {
      reqs.push(`RES  ${String(p.response.status).padEnd(4)} ${p.type.padEnd(8)} ${p.response.url} (${p.response.headers['content-type'] || '?'})`)
    }
    if (/\/api\/file/.test(p.response.url)) {
      reqs.push(`     ↳ 响应头: ${JSON.stringify(p.response.headers)} statusText=${p.response.statusText}`)
    }
  })
  cdp.on('Network.loadingFailed', (p) => {
    reqs.push(`FAIL ${p.errorText} ${p.type} blockedReason=${p.blockedReason || ''}`)
  })

  const loaded = cdp.once('Page.loadEventFired', 20000)
  await cdp.send('Page.navigate', {
    url: `${BASE}/?path=${encodeURIComponent(path.join(SAMPLES, 'sample.zip').split(path.sep).join('/'))}`
  })
  await loaded.catch(() => {})

  console.log('--- 等待 22 秒，让归档链路充分尝试 ---')
  await sleep(22000)

  const probe = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const p = new URL(location.href).searchParams.get('path') || '';
      const out = { sw: [], entries: [], manual: null };
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        out.sw = regs.map(r => ({ scope: r.scope, active: r.active && r.active.scriptURL }));
      } catch (e) { out.sw = 'ERR ' + e.message; }
      out.entries = performance.getEntriesByType('resource')
        .filter(e => /api\\/file|api\\/probe|libarchive/.test(e.name) || /\\.zip/.test(e.name))
        .map(e => ({
          name: e.name.split('?')[0],
          initiator: e.initiatorType,
          status: e.responseStatus,
          transfer: e.transferSize,
          encoded: e.encodedBodySize,
          decoded: e.decodedBodySize
        }));
      try {
        const base = p.split('/').pop();
        const url = '/api/file/' + encodeURIComponent(base) + '?path=' + encodeURIComponent(p);
        const r = await fetch(url);
        const buf = await r.arrayBuffer();
        out.manual = { url: url.slice(0, 60), status: r.status, bytes: buf.byteLength, ct: r.headers.get('content-type') };
      } catch (e) { out.manual = 'ERR ' + e.message; }

      // 对照实验：同一份字节，只有 URL 路径后缀不同。
      // 若 ".zip" 结尾被劫持而 ".bin"/无后缀正常 ⇒ 是「按扩展名嗅探下载」的客户端软件干的。
      out.suffixTest = [];
      for (const suffix of ['sample.zip', 'sample.bin', 'noext', 'sample.zip?a=1']) {
        const [name, extra] = suffix.split('?');
        const u = '/api/file/' + name + '?path=' + encodeURIComponent(p) + (extra ? '&' + extra : '');
        try {
          const r = await fetch(u);
          const b = await r.arrayBuffer();
          out.suffixTest.push({ suffix, status: r.status, bytes: b.byteLength, ct: r.headers.get('content-type') });
        } catch (e) {
          out.suffixTest.push({ suffix, error: e.message });
        }
      }
      return out;
    })()`,
    returnByValue: true,
    awaitPromise: true
  })
  console.log('\n===== 页面侧事实（SW / 资源计时 / 亲自 fetch）=====')
  console.log(JSON.stringify(probe.result.value, null, 2))

  const textProbe = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const h = document.querySelector('flyfish-file-viewer');
      let text=''; const SKIP=new Set(['STYLE','SCRIPT','TEMPLATE','NOSCRIPT','LINK','META','TITLE']);
      const walk=(r)=>{for(const n of r.childNodes){if(n.nodeType===3){text+=n.nodeValue;continue}if(n.nodeType!==1)continue;if(SKIP.has(n.tagName))continue;if(n.shadowRoot)walk(n.shadowRoot);walk(n)}};
      if(h) walk(h.shadowRoot||h);
      return { text: text.slice(0,300) };
    })()`,
    returnByValue: true
  })
  console.log('\n===== 面板文本（前 300 字）=====')
  console.log(JSON.stringify(textProbe.result.value?.text))

  console.log('\n===== 网络请求（按发生顺序）=====')
  const interesting = reqs.filter((r) => /archive|libarchive|worker|wasm|\.zip|\/api\/file/i.test(r))
  console.log(interesting.length ? interesting.join('\n') : '(没有 archive/libarchive/zip 相关请求！)')

  console.log('\n===== 全部脚本请求 =====')
  console.log(reqs.filter((r) => r.includes('Script')).slice(0, 40).join('\n') || '(无)')

  console.log('\n===== console / log =====')
  console.log(logs.slice(0, 60).join('\n') || '(无输出)')

  console.log('\n===== 服务端日志 =====')
  console.log(slog.join('').slice(0, 3000))

  cdp.close()
  chrome.kill()
  server.kill()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
