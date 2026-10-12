/* fnos-file-viewer 前端逻辑
 *
 * 职责边界（刻意收得很窄）：只做「拿到 ?path= 指定的那个文件 + 交给预览组件」。
 *
 *   · 没有文件浏览 / 目录树 —— 本应用是纯粹的"打开方式"，不承担文件管理职责。
 *   · 没有 iframe 嵌套 —— 页面就是预览本身，整页没有任何嵌入式框架。
 *   · 没有顶栏 —— 本应用由浏览器新标签页打开（url 型入口），地址栏/刷新/下载
 *     浏览器自己就有；文件名那点信息预览组件的工具栏也会显示。整页只剩预览。
 *
 * 真正的渲染全部由 file-viewer（<flyfish-file-viewer>）负责 ——
 * 我们不去猜某个格式能不能渲染，只把文件 URL 递过去。
 */
(() => {
  'use strict'

  const VIEWER_TAG = 'flyfish-file-viewer'
  const THEME_KEY = 'fnos-file-viewer:theme'

  const el = (id) => document.getElementById(id)
  const dom = {
    viewerHost: el('viewer-host'),
    empty: el('empty'),
    emptyHint: el('empty-hint'),
    error: el('error'),
    errTitle: el('err-title'),
    errMsg: el('err-msg'),
    errPath: el('err-path'),
    errDoctor: el('err-doctor'),
    loading: el('loading'),
    btnErrDownload: el('btn-err-download'),
    btnErrDoctor: el('btn-err-doctor')
  }

  const state = {
    filePath: '',
    fileName: '',
    config: null,
    theme: 'light'
  }

  /* ── 小工具 ─────────────────────────────────────────────────── */

  /**
   * 预览流地址。
   *
   * ★★ 这里刻意**不把文件名放进 URL 路径**（`/api/file?path=…` 而不是 `/api/file/x.zip?path=…`）。
   *
   * 原因：下载管理器（迅雷 / IDM 这类）是**按 URL 路径的扩展名嗅探**的。只要路径以
   * `.zip` / `.exe` / `.iso` 结尾，请求就会被它劫持 —— 页面拿到一个空响应，
   * 表现为"打不开 / 0 个文件"，同时还会弹出下载窗口。
   * 实测（同一份字节，只改 URL 后缀）：
   *   /api/file/sample.zip?suffix → 204、0 字节      ← 被劫持
   *   /api/file/sample.bin?suffix → 200、555 字节
   *   /api/file/noext?suffix      → 200、555 字节
   *   /api/probe?path=…zip        → 200（扩展名只在 query 里就没事）
   * 所以：扩展名只保留在 query。这条对**所有格式**都适用（不是只有压缩包），
   * 因为任何可下载扩展名都会被嗅探。
   */
  function streamUrl(p) {
    return `/api/file?${new URLSearchParams({ path: p }).toString()}`
  }

  /**
   * 下载地址。顶栏的下载按钮已经去掉，但**错误卡片上的「仍然下载」还在用** ——
   * 预览失败时它是用户唯一的出路，所以这个函数必须留着。
   *
   * 同样不带扩展名：文件名由服务端的 `Content-Disposition` 给出，
   * 浏览器/下载器拿到的名字不会丢，但不会被"路径嗅探"提前抢走。
   */
  function downloadUrl(p) {
    return `/api/file?${new URLSearchParams({ path: p, dl: '1' }).toString()}`
  }

  async function api(pathname, params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : ''
    const res = await fetch(pathname + q, { headers: { Accept: 'application/json' } })
    let body = null
    try {
      body = await res.json()
    } catch {
      throw Object.assign(new Error(`服务返回了非 JSON 内容（HTTP ${res.status}）`), { code: 'BAD_RESPONSE' })
    }
    if (!res.ok) {
      throw Object.assign(new Error(body?.error || `请求失败（HTTP ${res.status}）`), {
        code: body?.code || 'HTTP_' + res.status,
        status: res.status,
        extra: body
      })
    }
    return body
  }

  /* ── 界面状态 ───────────────────────────────────────────────── */

  const OVERLAYS = ['viewer', 'empty', 'error', 'loading']

  function showOnly(which) {
    for (const name of OVERLAYS) {
      const node =
        name === 'viewer' ? dom.viewerHost : name === 'empty' ? dom.empty : name === 'error' ? dom.error : dom.loading
      if (!node) continue
      if (name === 'viewer') {
        node.style.visibility = which === 'viewer' ? 'visible' : 'hidden'
      } else {
        node.classList.toggle('hidden', which !== name)
      }
    }
  }

  function showError(title, msg, filePath, doctor) {
    dom.errTitle.textContent = title
    dom.errMsg.textContent = msg || ''
    dom.errPath.textContent = filePath || ''
    dom.errDoctor.textContent = doctor || ''
    dom.errDoctor.classList.add('hidden')
    showOnly('error')
  }

  function applyTheme(theme) {
    state.theme = theme === 'dark' ? 'dark' : 'light'
    document.documentElement.dataset.theme = state.theme
    try { localStorage.setItem(THEME_KEY, state.theme) } catch { /* ignore */ }
    const node = dom.viewerHost.querySelector(VIEWER_TAG)
    if (node) node.setAttribute('theme', state.theme)
  }

  /** 按后端给的结构化错误，翻成人话 */
  function explain(err, filePath) {
    const code = err?.code || ''
    const extra = err?.extra || {}
    if (code === 'NOT_FOUND') return '这个文件不存在，或者已经被移动 / 删除了。'
    if (code === 'PERMISSION_DENIED') {
      return `进程读不到它（${extra.path || filePath}）。当前身份：${extra.whoami || '未知'}。`
    }
    if (code === 'OUT_OF_SCOPE') return '这个路径不在应用允许访问的范围内。'
    return err?.message || String(err)
  }

  /* ── 预览组件 ───────────────────────────────────────────────── */

  function mountViewer(url, name) {
    dom.viewerHost.textContent = ''
    const node = document.createElement(VIEWER_TAG)
    node.setAttribute('src', url)
    node.setAttribute('filename', name)
    node.setAttribute('locale', 'zh-CN')
    node.setAttribute('theme', state.theme)
    node.setAttribute('toolbar-position', 'bottom-right')
    node.style.display = 'block'
    node.style.width = '100%'
    node.style.height = '100%'
    dom.viewerHost.appendChild(node)
    return node
  }

  async function openFile(filePath) {
    showOnly('loading')

    let info
    try {
      // 'exact' 语义：路径不存在就报错，不要兜底成上级目录
      info = await api('/api/probe', { path: filePath })
    } catch (err) {
      showError('打不开这个文件', explain(err, filePath), filePath, JSON.stringify(err.extra || {}, null, 2))
      return
    }

    if (info.isDir) {
      showError(
        '这是一个文件夹',
        '本应用只用来预览文件。请指定一个具体文件（在文件管理里双击文件即可）。',
        info.path,
        ''
      )
      return
    }

    state.filePath = info.path
    state.fileName = info.name

    const info2 = info.info || {}
    syncUrl(info.path)

    // 交给预览组件。失败（组件没部署、或渲染器内部报错）时给出明确指引，
    // 而不是留一块白板让用户猜。
    mountViewer(streamUrl(info.path), info.name)
    showOnly('viewer')

    const onError = () => {
      showError(
        '预览组件没能渲染这个文件',
        info2.previewable
          ? '这个格式在支持列表里，但渲染失败了。可能是文件损坏、加密，或浏览器缺字体。可以点「仍然下载」用本地软件打开。'
          : `扩展名 .${info2.ext || '?'} 不在预览组件登记的格式里${info2.optIn ? '（属于需要额外安装的组件，本应用未包含）' : ''}。可以直接下载后用本地软件打开。`,
        info.path,
        ''
      )
    }
    // 组件把渲染失败抛成 unhandledrejection，这里兜住它
    state._onViewerError = onError
  }

  /** 让地址栏可分享 / 可刷新（不带扩展名，理由同 streamUrl） */
  function syncUrl(filePath) {
    const next = '/open?' + new URLSearchParams({ path: filePath }).toString()
    if (location.pathname + location.search !== next) {
      try { history.replaceState(null, '', next) } catch { /* ignore */ }
    }
  }

  /* ── 事件 ───────────────────────────────────────────────────── */

  dom.btnErrDownload.addEventListener('click', () => {
    if (state.filePath) location.href = downloadUrl(state.filePath)
  })
  dom.btnErrDoctor.addEventListener('click', async () => {
    if (!dom.errDoctor.classList.contains('hidden')) {
      dom.errDoctor.classList.add('hidden')
      return
    }
    dom.errDoctor.textContent = '正在收集诊断信息…'
    dom.errDoctor.classList.remove('hidden')
    try {
      const info = await api('/api/doctor')
      dom.errDoctor.textContent = JSON.stringify(info, null, 2)
    } catch (err) {
      dom.errDoctor.textContent = '诊断信息拿不到：' + (err?.message || err)
    }
  })

  window.addEventListener('unhandledrejection', (ev) => {
    const fn = state._onViewerError
    if (fn) {
      state._onViewerError = null
      fn()
    }
  })

  /* ── 启动 ───────────────────────────────────────────────────── */

  async function boot() {
    try {
      state.theme = localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
    } catch {
      state.theme = 'light'
    }
    applyTheme(state.theme)

    try {
      state.config = await api('/api/config')
    } catch (err) {
      showError('应用服务没起来', err.message || String(err), '', '')
      return
    }

    if (!state.config.assets?.viewerReady) {
      dom.emptyHint.textContent = '⚠ 预览组件没有部署完整（/file-viewer/dist 缺失）。请重新安装完整安装包。'
    } else if (state.config.viewer) {
      dom.emptyHint.textContent = `预览组件 file-viewer v${state.config.viewer} · 应用 v${state.config.version}`
    }

    if (!window.customElements || !customElements.get(VIEWER_TAG)) {
      dom.emptyHint.textContent = '⚠ 预览组件的脚本没有加载成功（/file-viewer/dist/flyfish-file-viewer-web-full.iife.js）。请确认安装包完整。'
    }

    // 飞牛以 ?path= 传文件；/open?path= 是我们自己 syncUrl 出来的同一种形状
    const incoming = new URLSearchParams(location.search).get('path')
    if (!incoming) {
      showOnly('empty')
      return
    }

    await openFile(incoming)
  }

  boot()
})()
