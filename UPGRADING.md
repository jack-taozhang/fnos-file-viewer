# 升级指南

本项目**包装**了一个第三方开源组件，升级路径取决于你是在升「包装层」还是在升「被包装的上游」。

---

## 1. 上游组件：file-viewer

预览能力（274 个扩展名 / 47 条链路）全部来自
[flyfish-dev/file-viewer](https://github.com/flyfish-dev/file-viewer)。

**当前锁定版本：`3.1.2`**（定义在 `scripts/prepare-vendor.mjs` 第 44 行的 `VERSION`）。

### 升级步骤

```bash
# 1) 改版本号（也可以不改文件、直接用环境变量试跑）
#    scripts/prepare-vendor.mjs:44   const VERSION = process.env.FILE_VIEWER_VERSION || '3.1.2'
FILE_VIEWER_VERSION=3.2.0 npm run vendor:force

# 2) 跑格式契约测试 —— 上游新增/改名扩展名时这里会红
npm test

# 3) 起本地服务冒烟
npm run e2e
npm run smoke

# 4) 打包
npm run fpk
```

### 关键点

- **`vendor/` 不入库**（225 MB 构建产物），由 `npm run vendor` 从上游 release 重新下载。
  所以 clone 之后第一件事就是 `npm run vendor`，否则应用是空的。
- **国内网络直连 GitHub 不稳**。`prepare-vendor.mjs` 里已经套了代理镜像；
  如果还拉不下来，可设 `LOCAL_TGZ=/path/to/file-viewer-3.2.0.tgz` 走本地包。
- `npm run vendor:slim` 会裁掉一部分体积大的可选解析器，出包更小但覆盖面变窄，
  按需选。
- 上游是纯前端产物，**没有运行时依赖** —— 应用 `server/` 只用 Node 内置模块。
  所以升级上游不会牵动任何服务端代码，改完直接重出包即可。

### 上游改名/删除扩展名时

`npm test`（`scripts/test-formats.mjs`）会对照本仓库维护的格式表，
列出与上游实际产物不一致的扩展名。**不要直接改测试让它变绿** ——
先判断上游是有意移除（跟着删）还是本仓库漏了新的（补上）。

---

## 2. 包装层（本仓库自己的代码）

- `server/index.mjs` —— 文件服务。零第三方依赖，只用 Node 内置模块。
- `web/` —— 手写静态页面（不是上游产物，是本仓库自己的 UI 外壳）。
- `scripts/build-fpk.mjs` —— 打包成飞牛 `.fpk`。

改动打包层时**不需要**动上游：先 `npm test` 确认格式契约没坏，再 `npm run fpk`。

---

## 3. 飞牛应用版本号

版本号在三处，必须同步，改一处就会让安装/升级判断失配：

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `fnos-package/manifest` | `version` |
| （若已发版）GitHub Release tag | `v1.0.x` |

`npm run verify:fpk` 会替你核对包内 manifest 与仓库版本是否一致。

---

## 4. 与思源侧的联动

本应用被 [siyuan-localfs](https://github.com/jack-taozhang/siyuan-localfs) 插件
通过思源反代的 `/localfs/fv/*` 同源通道借用，用来渲染嵌入块与页签预览。

- 通道前缀与本应用端口（8030）由 `siyuannote-fnos-app` 的
  `cmd/main` 与 `reverse-proxy.py` 决定 —— 改端口要**两边一起改**。
- 通道进来的请求，页面域名/资源路径被重写过；本应用**不要**依赖
  `location.hostname` 做判断（内网 / ZeroTier / 穿透三种走法下它各不相同）。
- 嵌入块与页签会往 iframe 注入样式来藏掉本应用自带的侧栏与顶栏
  （见 siyuan-localfs 的 `src/purify.js`）。**如果本应用改了 DOM 结构或 id
  （`#sidebar` / `#topbar` / `#app` / `#main` / `#stage`），净化会静默失效** ——
  这类改动必须同步通知 siyuan-localfs 一侧。