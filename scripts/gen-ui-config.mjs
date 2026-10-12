/**
 * 生成 fnos-package/app/ui/config
 *
 * 这里只声明一件东西：文件管理器（含飞牛桌面双击 / 右键）的
 * 「用文件预览打开」入口 —— 带 fileTypes 的那几条服务。
 *
 * ★ 不再声明 `.main`（桌面图标）：本应用只作为文件的"打开方式"存在，
 *   不占飞牛桌面的应用位。详见下面 type/workbench 的说明。
 *
 * 为什么要生成而不是手写：fileTypes 有两百多个扩展名，和 server/formats.mjs
 * 里的格式表必须永远一致 —— 手写就会出现"表里加了新格式，但双击还是打不开"
 * 这种只在真机上才发现的偏差。所以这里以 formats.mjs 为唯一来源。
 *
 * 用法：node scripts/gen-ui-config.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { OPEN_WITH_BUCKETS, OPEN_WITH_EXTS } from '../server/formats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const APP_NAME = 'fnos-file-viewer'
const DISPLAY_NAME = '文件预览'
const PORT = '8030'

/*
 * ★★ 入口的 type / workbench 为什么是这两个值（真机实证，别随手改）
 *
 * 飞牛前端把服务项映射成任务时写得很直白：
 *     if (e.url && !e.iframe) { window.open(e.url, `_blank`, `noopener`); return null }
 * 也就是说 —— **`url` 型入口 = 用浏览器打开**，`microApp`/iframe 型才走桌面内嵌。
 * 而且用户那句"取消页面嵌套"就是这个属性：只用 `url` 型，就不存在嵌在客户端里的外壳。
 *
 * 编译期唯一产出 `url` 型的路径是 appview 页的 `?url=` 临时窗口，而它就长这样：
 *     { appName: `appview.iframe`, type: TEMPORARY, iframe: !0, url: e }
 *   ⇒ `iframe: true` 对应 app 表的 **`workbench` 列**（不是 `no_display`）；
 *     要拿到 `url` 型，`workbench` 必须为 false，同时 `type: "url"`。
 * 佐证：飞牛自带的 `trim.docs.preview` 就是 `type=url` + `workbench=f` + 带 fileTypes，
 * 双击 Office 文件时**另开浏览器页**而不是嵌在文件管理器里。
 *
 * 但应用中心对第三方包只会按 `manifest` 的 type 建服务（payload 的 type 编译期写死），
 * 所以**配不出 url 型** —— 见 README「应用中心装不出 url 型入口」一节：
 * 装完由 `cmd/install_callback` / `cmd/config_callback` 把服务行改过来。
 */

/*
 * 为什么要生成多条 .open 服务：
 * app_service.file_types 是 varchar(500)，一条服务放不下 200 多个扩展名
 * （放不下就安装回滚，报「服务异常」）。拆成若干条互不重叠的服务即可，
 * 详见 server/formats.mjs 里 OPEN_WITH_BUCKETS 的注释。
 *
 * 服务名：第一条叫 .open（老名字，保持向后兼容），之后 .open2、.open3…
 * 标题一律相同 —— 任一文件只会命中其中一条，用户看到的永远是
 * 一个「用文件预览打开」。
 */
const openServices = {}
OPEN_WITH_BUCKETS.forEach((bucket, i) => {
  openServices[`${APP_NAME}.open${i === 0 ? '' : i + 1}`] = {
    title: `用${DISPLAY_NAME}打开`,
    icon: 'images/icon_{0}.png',
    // ★ url 型 = 用浏览器打开（见文件头部说明），不是 iframe 内嵌
    type: 'url',
    protocol: 'http',
    port: PORT,
    url: '/open',
    allUsers: true,
    fileTypes: bucket.exts,
    // 只作为"打开方式"出现，不占一个桌面图标位
    noDisplay: true
  }
})

/* 只留"打开方式"，不再有 .main（桌面图标 / 应用中心主入口） */
const out = { '.url': { ...openServices } }

const target = path.join(ROOT, 'fnos-package', 'app', 'ui', 'config')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n')

const detail = OPEN_WITH_BUCKETS.map((b, i) => `open${i === 0 ? '' : i + 1}=${b.exts.length}项/${b.chars}字符`).join(' ')
console.log(
  `[ui-config] 已写入 ${path.relative(ROOT, target)}：` +
    `${OPEN_WITH_EXTS.length} 个扩展名 → ${OPEN_WITH_BUCKETS.length} 条打开方式服务（${detail}）`
)

// 兜底复核：app_service.file_types 是 varchar(500)，写超了安装会回滚
const DB_LIMIT = 500
for (const [i, b] of OPEN_WITH_BUCKETS.entries()) {
  if (b.chars > DB_LIMIT) {
    console.error(
      `[ui-config] ✗ 第 ${i + 1} 组序列化后 ${b.chars} 字符，超过飞牛数据库的 ${DB_LIMIT}，安装会失败`
    )
    process.exit(1)
  }
}
const total = OPEN_WITH_BUCKETS.reduce((n, b) => n + b.exts.length, 0)
if (total !== OPEN_WITH_EXTS.length) {
  console.error(`[ui-config] ✗ 分组后共 ${total} 项，与格式表的 ${OPEN_WITH_EXTS.length} 项对不上`)
  process.exit(1)
}
