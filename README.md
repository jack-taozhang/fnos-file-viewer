# fnos-file-viewer

飞牛 fnOS（私有云 NAS）上的**原生文件预览应用** —— 不依赖 Docker。

在飞牛「文件管理」里双击文件就能直接预览：Word / Excel / PPT（含旧版 `doc` `xls` `ppt`）、
PDF / OFD、图片、音视频、压缩包、邮件、代码与结构化数据、CAD 图纸、3D 模型、思维导图……
**解析和渲染全部在浏览器本地完成，文件不上传、不出内网。**

预览能力来自 [flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer)（v3.1.2，
274 个扩展名 / 47 条预览链路）。本仓库是把它包成飞牛原生应用的那一层。

---

## 1. 它长什么样

**整页只有预览本身** —— 没有侧栏、没有顶栏、没有任何嵌套 iframe。

```
┌──────────────────────────────────────────────────────────────┐
│  ‹ 1/1 ›              − 125% +  ⟳ 0° ↻                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                                                        │  │
│  │             File Viewer PDF render OK                  │  │
│  │                                                        │  │
│  │          fnos-file-viewer smoke sample                 │  │
│  └────────────────────────────────────────────────────────┘  │
│      ┌──────────────────────────────────────────────┐        │
│      │ 搜索文档 搜索 ‹ › ✕ 0/0 − 1:1 ⇩ 打印 HTML ☀ │        │
│      └──────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

上面那些控件全部是**预览组件自带**的（按当前格式支持哪些操作动态出现），不是本应用加的。

本应用自己只贡献了一个「什么都没有」的容器，这是刻意的：

| 去掉的东西 | 为什么 |
|---|---|
| 文件浏览 / 目录树 | 应用已被收窄成纯粹的「打开方式」，再放一棵文件树就是在应用里复刻一个只读文件管理器，职责重叠 |
| 嵌套 iframe | 页面就是预览本身，不该在预览外面再套一层框架 |
| 顶栏（文件名 / 下载 / 重载 / 主题） | 本应用由**浏览器新标签页**打开，地址栏、刷新、下载、新标签页浏览器自带；文件名那点信息预览组件的工具条也有 |
| 桌面图标 | 只保留「文件管理器里双击 → 打开方式」这一条入口 |

唯一保留的应用自有 UI 是**出错时的卡片**（打不开 / 格式不支持 / 渲染失败），
上面有「仍然下载」和「看诊断信息」两个按钮 —— 那是预览失败时用户唯一的出路。

---

## 2. 快速开始

需要 **Node.js ≥ 20**（开发机用来跑脚本；飞牛上用的是系统自带的 `nodejs_v22`，不需要额外安装）。

```bash
# 1) 拉取预览组件（约 78 MB 下载，解包后 225 MB）
npm run vendor

# 2) 本地跑起来看看（默认 http://127.0.0.1:8030）
npm start

# 3) 跑测试
npm test          # 纯函数单测（路径解析 / 格式表）
npm run e2e       # 起服务打真实 HTTP，39 项
npm run smoke     # 起 headless Chrome 确认"真的渲染出来了"，12 项

# 4) 打包成 .fpk
npm run fpk
# → dist-package/fnos-file-viewer-1.0.3.fpk
```

装到飞牛：**应用中心 → 手动安装 → 选择那个 .fpk**。装完不需要任何配置。

### 只想快点试、不想要 225 MB？

```bash
npm run vendor:slim   # 去掉 drawio 资产 / CAD wasm / Typst wasm / design 资产，约 60 MB
npm run fpk:slim
```

代价是 `.drawio`、`.dwg/.dxf`、`.typ` 这些格式会渲染失败（界面会明确提示，不会静默白屏）。
**默认请用 full** —— 那是官方支持且经过验证的部署形态。

---

## 3. 目录结构

```
fnos-file-viewer/
├── server/                  运行期服务端（零第三方依赖）
│   ├── index.mjs            静态托管 + /api/*（列表 / 探测 / 取文件流）
│   ├── path-utils.mjs       路径解析的纯函数（有单测）
│   └── formats.mjs          扩展名 → 分组 / MIME（fileTypes 的唯一来源）
├── web/                     前端（手写静态文件，**没有构建步骤**）
│   ├── index.html
│   ├── app.js
│   └── app.css
├── vendor/                  file-viewer 的完整 dist（npm run vendor 生成，不入库）
│   └── dist/  →  挂到 /file-viewer/dist/
├── fnos-package/            FPK 包骨架
│   ├── manifest             appname / version / 端口 / 描述 / changelog
│   ├── config/privilege     run-as: root（全盘直读的关键）
│   ├── config/resource      {}（声明 data-share 会在设置里留一条删不掉的条目）
│   ├── cmd/                 10 个生命周期脚本（含自加的 fix-open-type）
│   ├── wizard/install       安装向导文案
│   └── app/ui/config        文件管理器「打开方式」（脚本生成；**无桌面图标**）
├── scripts/
│   ├── prepare-vendor.mjs   下载 / 校验 / 解包 file-viewer
│   ├── gen-ui-config.mjs    生成 app/ui/config
│   ├── make-icons.mjs       生成图标（纯 Node 画 + 手写 PNG 编码）
│   ├── build-fpk.mjs        组装并调用官方 fnpack
│   ├── e2e-local.mjs        本地端到端
│   ├── smoke-browser.mjs    CDP 真浏览器渲染冒烟
│   └── lib/                 tar.gz 读取器 / PNG 编码器 / 样例文件生成
└── .tools/fnpack.exe        官方打包器（首次打包自动下载）
```

---

## 4. 架构：一条文件流的两次跳转

```
飞牛文件管理（双击）
      │  http://<NAS>:8030/open?path=/vol1/1000/报告.pdf
      ▼
① 本应用前端（web/app.js）
      │  GET /api/probe?path=…        先问"这个文件到底能不能读"
      │  ↓ 200 {name, size, info,…}
      │  创建 <flyfish-file-viewer src="/api/file/报告.pdf?path=…">
      ▼
② file-viewer（浏览器内）
      │  GET /api/file/报告.pdf?path=…  （带 Range，可能分多次）
      │  ↓ 206/200 + 原始字节
      └─ 本地解析渲染（Worker / WASM / Canvas，全程不出内网）
```

服务端总共只有 5 个接口，全部围绕"把文件安全地喂给浏览器"：

| 接口 | 作用 |
| --- | --- |
| `GET /api/health` | 存活 + 版本（应用版本、预览组件版本） |
| `GET /api/config` | 浏览根、运行身份（uid / 是否 root）、资产是否就位 |
| `GET /api/list?path=` | 列目录（目录优先、按中文排序、附格式分类） |
| `GET /api/probe?path=` | 打开前预检：存在？是文件还是目录？什么格式？ |
| `GET /api/file/<名字>?path=[&dl=1]` | 文件流，**支持 Range**；`dl=1` 改成下载 |
| `GET /api/doctor` | 权限自检：逐级列出"到底哪一层进不去" |

静态路由两条：

| 前缀 | 来源 | 说明 |
| --- | --- | --- |
| `/file-viewer/dist/*` | `vendor/dist` | 预览组件本体 + renderers / vendor / wasm |
| 其它 | `web` | 本应用前端 |

---

## 5. 几个"看起来可以省、实际不能省"的设计

### 5.1 为什么必须整份 `dist/`，不能只抄入口 JS

`flyfish-file-viewer-web-full.iife.js` **只是外壳**。PDF、Word、Excel、PPT、CAD、Typst、
压缩包这些重型 renderer 是在命中文件类型时才去 `dist/renderers/*.iife.js` 取的，
Worker / WASM / 字体在 `dist/vendor/`、`dist/wasm/`。

少一个目录的后果不是"少几个格式"，而是打开时报一句**完全看不出是部署漏文件**的
资源加载错。所以 `prepare-vendor` 把整份 dist 原样落盘，并在 `/api/config`
里回显 `assets.viewerReady`，前端启动时自检，缺了会在界面上直接提示。

同时这也解释了路由为什么是 `/file-viewer/dist/`：组件用 `document.currentScript`
的地址推导资源基址，脚本在 `/file-viewer/dist/xxx.iife.js`，那 renderer 就去找
`/file-viewer/dist/renderers/`——和组件文档里的示例布局一致，不需要额外配置。

### 5.2 为什么 `/api/file` 必须支持 Range

PDF（pdf.js）、音视频、以及大文件的按需读取都会发 `Range` 请求。
回 200 整份内容"也能用"，但：

- 大文件会被整份读进内存（一个 4 GB 的 iso 能把服务进程撑爆）；
- 播放器拖不动进度条，用户看到的是"视频不能快进"；
- 部分 PDF 表现为"一片白"。

实现上用的是 `createReadStream(abs, { start, end })` —— 真正的分段读，不是"读完再切片"。
越界 / 无法解析的 Range 一律退回 200 整份，而不是回 416 空白。

### 5.3 为什么是 `run-as: root`，以及为什么代码不能"相信"它

`config/privilege` 里 `run-as: root` 让 `cmd/` 里的生命周期脚本以 root 执行，
`cmd/main` 起的 node 进程随之拿到 root 身份 —— 于是**进程本来就能读全部存储空间**，
不需要让用户在应用设置里配「可访问目录」，配合 `manifest` 的
`disable_authorization_path=true`，那个设置项直接不显示。装完即用。

代价要说清楚：**应用对整台 NAS 有完全读权限**。只适合自用 / 内网手工安装。

但代码里**权限判定只看运行期真实身份，绝不看包里的声明**：

```js
const IS_ROOT = process.platform !== 'win32' && process.getuid?.() === 0
const UNRESTRICTED = !SCOPED_MODE           // 默认即全盘直读
function isAllowed(abs) { if (UNRESTRICTED) return true; /* …白名单… */ }
```

因为包身份会骗人：飞牛对 `run-as: root` 的限制主要针对**发布到官方应用中心**
（仅合作企业），手动安装是否放行取决于系统版本。一旦系统不放行，而代码却因为
"包里写着 root"而放弃白名单，结果就是**用户读不到文件、还看不到任何提示**。
所以默认走 root，同时留一个应急开关（`FNOS_ACCESS_MODE=scoped` 退回白名单），
排障接口 `/api/doctor` 会如实报出 `uid` / `runsAsRoot` / `accessMode`。

### 5.4 ★ 为什么应用里**没有**文件浏览（附：为什么它曾经有过）

早期版本左侧确实有一棵文件树，顶层直接列 `/vol1`、`/vol2`…（用 `rootLabel()` 把显示名换成
「存储空间 1」，因为用户不认 `/vol1` 这种名字）。**现在整棵删掉了。**

删掉的理由不是"不好用"，而是**职责重叠**：应用已经收窄成纯粹的「打开方式」，
入口只有文件管理器里双击这一条；再放一棵文件树，就等于在应用里复刻一个只读的文件管理器。
而且用户已经有文件管理器了，那才是这个职责的正主。

> 如果哪天又想加回来，路径规划的关键约束记录在这里：**顶层必须直接列挂载点**
> （别去读 `/proc/mounts` + sysfs 自行判断"哪个算外接盘 / 远程挂载" ——
> 卷怎么切本来就是系统的事，自己判一套会随系统版本变，只要少判一类用户就会发现
> "我的文件夹莫名其妙不见了"）。直接列挂载点永远和系统一致，且不需要维护。

### 5.5 为什么**不**按后缀过滤（这条随文件浏览一起去掉了）

原来文件列表是不按后缀过滤的：本应用是通用预览器，预览组件认 274 个扩展名，
由我们来筛只会把能看的文件藏起来，所以什么文件都显示，只在界面上打个格式徽标。

现在已经没有文件列表了 —— 用户双击什么文件，应用就打开什么文件，**连"筛"这个动作都不存在了**。
真正需要"过滤"的场景交给飞牛自己的文件管理器。

### 5.6 前端没有构建步骤

`web/` 就是三个手写文件，直接由服务端托管。没有 Vite、没有 `node_modules`、
没有"源码改了忘了 build"这类问题。代价是没有框架和类型检查 ——
对这个体量（拿到一个文件路径 + 挂载一个预览组件 + 三种覆盖层）来说是划算的。

### 5.7 ★★ 文件 URL 的**路径里绝不能出现扩展名**

这一条是踩过坑才写下来的，而且**看起来完全无害**：

```js
// ✗ 不要这样：路径以 .zip 结尾
`/api/file/${encodeURIComponent(name)}?path=${p}`
// ✓ 要这样：扩展名只留在 query，路径是固定的 /api/file
`/api/file?${new URLSearchParams({ path: p })}`
```

原因是**下载管理器（迅雷、IDM 这类）按 URL 路径的扩展名嗅探请求**。路径以
`.zip` / `.exe` / `.iso` 这类结尾时，请求会在到达服务端之前被它劫持，页面拿到一个
**空响应**，同时还会弹出下载窗口。症状是"压缩包点开是 0 个文件"、"点 zip 就跳去迅雷"，
而服务端日志里**一切正常**（那种请求根本没到服务端）。

实测证据（同一份字节、同一个服务端，只改 URL 后缀，本机装着迅雷）：

| 请求 | 结果 |
| --- | --- |
| `/api/file/sample.zip?path=…` | **204、0 字节**（被劫持） |
| `/api/file/sample.zip?a=1&path=…` | **204、0 字节**（看的是**路径**，加 query 没用） |
| `/api/file/sample.bin?path=…` | 200、555 字节 |
| `/api/file/noext?path=…` | 200、555 字节 |
| `/api/probe?path=…sample.zip` | 200（扩展名只在 query 里就没事） |

所以本应用**所有**自己拼的 URL 都不带扩展名（不只是压缩包 —— 任何可下载扩展名都会被嗅探）。
文件名不丢：预览靠元素的 `filename` 属性，下载靠服务端 `Content-Disposition`
（中文名走 RFC 5987 的 `filename*`）。

冒烟测试里有一条守则用例盯着它：整轮跑下来，**任何**请求路径以可下载扩展名结尾就红。
这一条破掉时，本机（装了迅雷）会立刻暴露，不用等用户反馈。

排查这类问题的两个脚本（都在 `scripts/`）：

- `diag-zip.mjs` —— 起服务 + headless Chrome，打印**全部**网络请求与 console，
  并做上面那张表的**后缀对照实验**，一次跑完就能定性"是服务端的问题还是被劫持了"。
- `diag-server-wrapper.mjs` —— 一个**外层包装**，通过 monkey-patch 记录**服务端真正回了什么状态码**。
  为什么需要它：CDP 看到的状态可能来自别的会话/是页面里合成的，
  只有服务端自己的记录才是真相（这次就是靠它证明"服务端全程 200，那个 204 不是它发的"）。

---

## 6. 验证

```bash
npm test      # 37 项   路径解析与格式表的纯函数单测
npm run e2e   # 43 项   起真服务打 HTTP
npm run smoke # 12 项   起 headless Chrome，断言"真的渲染出来了"
npm run verify:fpk  # 8 项  解包产物、按安装布局起服务、翻 manifest
```

几个刻意写进去的判据：

- **E2E 里 `renderer 分片能取到` 不只看状态码。** 静态路由挂错目录时，SPA 兜底会
  回 200 + `index.html`，只断言 200 会得到**假绿**。所以同时看内容类型和体积。
- **冒烟测试的判据是 DOM 里真的有东西**（canvas 有尺寸 / 文本节点里读到标记），
  而不是"请求都成功"。资产路径挂错时，"失败请求数 = 0"恰恰也是 0。
- **DOM 探针必须递归穿过 shadow root**，并且**跳过 `<style>`/`<script>`**：
  组件把样式注入在 shadow root 里，直接读 `textContent` 会把整份 CSS 当成"渲染内容"，
  真正的文档内容被挤到几千字之后，于是"文本没渲染出来"变成假警报。
- **`net::ERR_ABORTED` 不算加载失败**（切换页面时必然出现），
  把它当错误只会制造噪音、掩盖真问题。
- **守则用例：整轮不许出现"路径以可下载扩展名结尾"的请求**（§5.7）。
  这条守则如果不写下来，回归时只会表现为"用户说 zip 又打不开了"。
- **ZIP 用例是"归档真的被解开了"**：拿一个真 CRC32 + 真中央目录的 ZIP
  （`scripts/lib/zip.mjs` 手写生成，内含中文目录名），断言包内条目名出现在 DOM 里。
  这也顺带覆盖了 libarchive 的 worker + wasm 资产路径。
- 冒烟测试每个用例都存一张截图到 `.verify/screenshots/`，便于人工复核。

---

## 7. 排障

| 现象 | 怎么办 |
| --- | --- |
| 界面提示「预览组件没有部署完整」 | `vendor/dist` 缺失。重跑 `npm run vendor` 后重新打包装载 |
| 文件能列出，点开报「打不开」 | 点错误面板里的「看诊断信息」；或直接 `curl http://<NAS>:8030/api/doctor` |
| 双击文件不出现「用文件预览打开」 | 应用要处于**运行中**；`app/ui/config` 的 `fileTypes` 需覆盖该扩展名 |
| **装了但读不到文件** | `/api/config` 看 `runsAsRoot` 是否为 true。若为 false，说明系统没放行 root——改完 `privilege` 必须**停止再启动**应用 |
| **点开压缩包显示「0 个文件」，或一点 zip 就弹出迅雷/下载器** | 被下载管理器按扩展名劫持了，见 §5.7。先确认应用版本 ≥ 1.0.2（1.0.1 的预览地址以 `.zip` 结尾）。想立刻验证是不是这个原因：浏览器控制台 `fetch('/api/file/sample.bin?path=<某个zip的真实路径>')` 能拿到字节、而 `…/sample.zip` 拿到 0 字节，就是它 |
| **双击文件后嵌在飞牛桌面窗口里打开（不是浏览器新标签页）** | 服务还是 `iframe` 型 —— `cmd/fix-open-type` 没跑成。见 §7.2；手查：`su - postgres -c "psql -d appcenter -c \"select service_name,type from app_service where app_id=(select id from app where app_name='fnos-file-viewer')\""` 应为 `url` |
| **桌面上还留着一个点不开的「文件预览」空图标** | 同理，`trim_sac.entry` / `user_desktop_entry` 没清。见 §7.2；也确认 manifest 里 `desktop_applaunchname` 的**值是空的**（fnpack 会无条件写出这个键，值空才是对的） |
| **日志在哪** | `$TRIM_PKGVAR/app.log`；应用中心那条"启动失败"提示会指出路径 |
| 改了设置，应用变成「已停用」 | 检查 `cmd/config_init` + `cmd/config_callback` 是否都在（它们负责重启） |
| **安装报「服务异常」，装完目录里什么都没有** | 应用中心写数据库失败导致整体回滚，界面只给这一句话。真话在 `/var/log/trim_app_center/error.log`（`msg="save data error" …`）与同目录 `info.log`（`msg=rollback`）。本仓库已知的唯一原因是 `fileTypes` 超 500 字符，见下方 §7.1 |
| 打包报「应用包不符合系统要求」 | 一定得用官方 `fnpack build`（本仓库 `npm run fpk` 已封装）；手工 `tar` 打包会缺 `cmd/` 脚本、`app/` 也不会变成 `app.tgz` |
| 改了服务端文件但行为没变 | 分不清"补丁生效"还是"旧进程还在跑" ⇒ `npm start` 时看启动日志里的版本号；真机上重启应用再看 `/api/health` |

### 7.1 为什么「打开方式」被拆成 4 条服务

飞牛数据库里 `app_service.file_types` 是 **`varchar(500)`** —— 一条服务最多声明
约 75 个扩展名。225 个扩展名序列化后有 1400 多字符，**装到写服务表那一步会整体回滚**，
界面只报一句「服务异常」，磁盘上什么都不会留下。

更阴的是它**还会留下一个孤儿进程**：安装过程中 `cmd/main` 已经用 `setsid` 把服务
拉起来了，回滚只删目录、不管进程，于是那个「cwd 已被删除」的 node 还占着 8030
端口，**下一次安装必失败**。清理：

```bash
PID=$(ss -ltnpH "sport = :8030" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ -n "$PID" ] && kill -TERM "$PID"
```

所以 `OPEN_WITH_BUCKETS`（`server/formats.mjs`）把扩展名按优先级分成 4 组，
每组 ≤480 字符、**组间互不重叠**。拆多条服务是设计内的做法，不是绕过：

- `app_service.app_id` 上没有唯一约束，飞牛自己的应用就是 `.main` + `.open` 多条；
- `app` 表收集并集的那一列是 `file_types text[]`，**没有长度上限**；
- 文件管理器按**扩展名**取列表，菜单只按 `entryKey` 去重 —— 组间不重叠就不会重复。

`npm run fpk` 会把这三条（每条 ≤500、组间不重叠、并集等于格式表）全部自检一遍。

### 7.2 ★★ 为什么装完还要改数据库（`cmd/fix-open-type`）

**应用中心对第三方包只会建 `iframe` 型服务** —— 而 `iframe` 型就是"嵌在飞牛桌面窗口里"。
我们要的是**用浏览器新标签页打开**，这就得让服务变成 `url` 型。

这不是配置问题，是**应用中心的硬编码**。证据（在 NAS 上实测）：

- `/usr/trim/bin/trim_app_center` 二进制里，`iframe` 只作为**常量**出现两次，
  和 `hidden` / `kernel` / `docker` 并排；**整个二进制里根本没有 `url` 类型常量**。
- 但**飞牛前端**（`/usr/trim/www/assets/index-*.js`）是按这个字段分流的：

  ```js
  E1 = function(e){ return e.URL = `url`, e.Iframe = `iframe`, e }({})
  // 入口映射：
  type: e.iframe ? `iframe` : `url`
  // 启动器：
  if (e.url && !e.iframe) {
    n?.params && (e.url = ee(e.url, n?.params))
    window.open(e.url, `_blank`, `noopener`)
    return null          // ← 不占用桌面窗口
  }
  isDisplay: !e.hiddenDesktopIcon
  ```

  ⇒ **服务行 `type === 'url'` ⇒ 浏览器打开；`'iframe'` ⇒ 嵌进桌面窗口。**

所以 `cmd/fix-open-type` 在安装 / 改设置 / 升级之后各跑一次，**同时改两个库**：

| 库 | 表 | 改什么 |
| --- | --- | --- |
| `appcenter` | `app_service` | `type = 'url'` |
| `appcenter` | `app_shortcut` / `app_open` | 删掉（桌面图标关联） |
| `trim_sac` | `entry` | `open_type = 'url'` |
| `trim_sac` | `user_desktop_entry` | 标 `is_deleted` |

**两个库都要改**，只改一个不生效 —— 这是踩过的坑：删了 `appcenter.app_shortcut` 之后
桌面图标**还在**，因为前端桌面列表读的是 `appcgi.sac.entry.v1.getUserDesktop`，
数据源是 `trim_sac.user_desktop_entry` + `trim_sac.entry`。

> 这个脚本是**幂等**的，且**任何一步失败都不让安装失败**（记警告 + `exit 0`）。
> 系统版本变了导致表结构不认，最坏结果也只是"回到 iframe 型入口"，不会把应用装坏。
>
> 为什么不用 `app/ui/config` 直接声明？因为那个文件的字段最终是写进同一批表，
> 而写表的是应用中心自己 —— 它只会写 `iframe`。


---

## 8. 升级预览组件

改一个地方就够了：

```bash
FILE_VIEWER_VERSION=3.1.3 npm run vendor:force
```

或者把 `scripts/prepare-vendor.mjs` 里的 `VERSION` 改掉。下载时会校验 npm 给出的
sha512，解包结果记在 `vendor/VERSION.json`。升级后跑一遍 `npm run e2e && npm run smoke`。

---

## 9. 许可与合规（请务必读）

本应用**打包并再分发**了第三方组件，各部分的许可不同：

| 部分 | 许可 |
| --- | --- |
| 本仓库的代码（`server/` `web/` `scripts/` `fnos-package/`） | Apache-2.0 |
| file-viewer 本体（`@file-viewer/*`） | Apache-2.0 |
| **DWG / DWF / DWFX 运行时**（`@flyfish-dev/cad-viewer`、`dwf-viewer`） | **AGPL-3.0-only** |
| **二进制 `.ppt` 引擎**（`@file-viewer/ppt`） | 独立许可，且渲染时带**可见水印** |

具体影响：

- **CAD**：`dist/renderers/cad.iife.js` 与 `dist/wasm/cad/` 属于 AGPL-3.0-only。
  如果你的使用/分发场景不能接受 AGPL，用 `npm run vendor:slim`（会去掉 CAD 资产），
  或者自建一个不装 `@file-viewer/renderer-cad` 的 dist。
- **二进制 `.ppt`**：渲染出来是带水印的。去掉水印需要商业授权。
  注意 `.pptx` 走的是另一条链路，不受影响。
- **二进制 PPT 引擎要求 Web Crypto（SHA-256）** ⇒ 必须在安全上下文里跑
  （HTTPS 或 localhost）。本应用部署在 `http://<NAS>:8030` 上，
  局域网 IP **不是**安全上下文，二进制 `.ppt` 可能因此不可用；`.pptx` 不受影响。

上游许可原文见 `vendor/dist/` 与 [file-viewer 的 LICENSE](https://github.com/flyfish-dev/file-viewer/blob/main/LICENSE)。
把本应用分发给第三方之前，请自行确认上述条款在你的场景下成立。
