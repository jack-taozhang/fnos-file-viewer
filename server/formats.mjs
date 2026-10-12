/**
 * 格式表：扩展名 → 分组 / MIME。
 *
 * 依据 file-viewer 官方「Supported Formats」矩阵（274 个扩展名 / 47 条预览链路）
 * 整理。分组只服务于两件事：
 *   1) UI 上给文件打个分类标记（图标 / 徽标）；
 *   2) 生成 FPK 包 app/ui/config 里的 fileTypes（文件管理器「打开方式」入口）。
 *
 * ⚠️ 这里的表**不参与"能不能渲染"的决策** —— 能不能渲染由 file-viewer 自己说了算。
 *    表只用来做展示与 fileTypes 声明，所以漏一两个扩展名不会导致功能缺失。
 *
 * `optIn: true` 的分组是官方明确"按需安装、不随 Full 包分发"的（Adobe 设计文件、
 * DICOM、数字签名容器、二进制检查）。本应用部署的是 web-full（= preset-all 兼容
 * 基线），没有装这些 renderer，所以它们**不会**进 fileTypes，界面上也不会标成
 * "可预览"，免得用户双击后看到一句看不懂的报错。
 */

/** 分组定义；顺序即界面上展示/排序的优先级 */
export const FORMAT_GROUPS = [
  {
    key: 'word',
    label: 'Word 文档',
    exts: ['docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'rtf', 'odt', 'wpd', 'wp', 'wp5', 'wp6', 'hwp', 'hwpx', 'fb2']
  },
  {
    key: 'sheet',
    label: '表格',
    exts: ['xlsx', 'xlsm', 'xlsb', 'xls', 'xla', 'xlam', 'csv', 'tsv', 'ods', 'fods', 'dbf', 'numbers']
  },
  {
    key: 'slides',
    label: '演示文稿',
    exts: ['pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'ppt', 'pot', 'odp', 'key']
  },
  { key: 'pages', label: 'Pages 文档', exts: ['pages'] },
  { key: 'pdf', label: 'PDF / 版式文档', exts: ['pdf', 'ofd', 'typ', 'typst', 'xps'] },
  {
    key: 'image',
    label: '图片',
    exts: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'ico', 'heic', 'heif', 'avif', 'tif', 'tiff']
  },
  {
    key: 'video',
    label: '视频',
    exts: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm3u8', 'flv', 'wmv', 'mpg', 'mpeg', '3gp']
  },
  { key: 'audio', label: '音频', exts: ['mp3', 'wav', 'ogg', 'oga', 'flac', 'aac', 'm4a', 'opus', 'wma', 'mid', 'midi'] },
  { key: 'font', label: '字体', exts: ['ttf', 'otf', 'woff', 'woff2', 'eot'] },
  {
    key: 'cad',
    label: 'CAD / 工程图',
    exts: ['dwg', 'dxf', 'dwf', 'dwfx', 'gds', 'oas', 'oasis', 'olb', 'dra']
  },
  {
    key: 'model3d',
    label: '3D 模型',
    exts: ['gltf', 'glb', 'obj', 'stl', 'ply', 'step', 'stp', 'iges', 'igs', 'ifc', '3dm', 'brep']
  },
  { key: 'geo', label: '地理数据', exts: ['geojson', 'kml', 'gpx', 'shp'] },
  {
    key: 'diagram',
    label: '图表 / 思维导图',
    exts: ['xmind', 'drawio', 'dio', 'excalidraw', 'mermaid', 'mmd', 'plantuml', 'puml']
  },
  {
    key: 'archive',
    label: '压缩包',
    exts: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso', 'apk', 'cbz', 'cbr']
  },
  { key: 'email', label: '邮件', exts: ['eml', 'msg', 'mbox'] },
  { key: 'ebook', label: '电子书', exts: ['epub', 'mobi', 'azw3'] },
  {
    key: 'text',
    label: '文本 / 代码 / 数据',
    exts: [
      'txt', 'log', 'md', 'markdown', 'rst', 'adoc',
      'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'properties',
      'xml', 'html', 'htm', 'xhtml', 'css', 'less', 'scss', 'sass',
      'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte',
      'py', 'pyw', 'java', 'kt', 'kts', 'scala', 'groovy', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh',
      'cs', 'go', 'rs', 'rb', 'php', 'swift', 'm', 'mm', 'lua', 'pl', 'r', 'jl', 'dart',
      'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql',
      'diff', 'patch', 'bundle', 'lock', 'gitignore', 'editorconfig',
      'ipynb', 'rq', 'sparql',
      'sqlite', 'sqlite3', 'db', 'parquet', 'avro', 'orc', 'wasm', 'wat', 'proto', 'thrift'
    ]
  },
  {
    key: 'design',
    label: 'Adobe 设计文件',
    optIn: true,
    exts: ['psd', 'psb', 'pdd', 'psdt', 'ai', 'ait', 'eps', 'ps', 'idml', 'icml', 'idms', 'inx', 'xd', 'indd', 'indt', 'fla', 'xfl', 'ase', 'aco', 'abr', 'csh', 'pat', 'grd', 'asl']
  },
  { key: 'dicom', label: '医学影像', optIn: true, exts: ['dcm', 'dicom'] },
  {
    key: 'signature',
    label: '数字签名容器',
    optIn: true,
    exts: ['p7m', 'p7s', 'p7b', 'p7c', 'pkcs7', 'cms', 'cmsc', 'tsq', 'tsr', 'tst', 'tsd', 'asics', 'scs', 'asice', 'sce', 'ers', 'asc', 'sig', 'pgp', 'gpg', 'jws']
  },
  { key: 'binary', label: '二进制', optIn: true, exts: ['bin', 'hex', 'elf', 'exe', 'dll', 'class', 'macho'] }
]

/** 扩展名（小写、不带点）→ { group, label } */
export const EXT_INDEX = (() => {
  const map = new Map()
  for (const g of FORMAT_GROUPS) {
    for (const e of g.exts) {
      if (!map.has(e)) map.set(e, { group: g.key, label: g.label, optIn: Boolean(g.optIn) })
    }
  }
  return map
})()

/**
 * 声明给飞牛文件管理器的「用 XX 打开」扩展名。
 *
 * 只包含 Full 包真正带了 renderer 的分组 —— 声明了却渲染不出来，
 * 用户只会觉得"这个应用有毛病"。排序只为让产物稳定（便于 diff）。
 */
export const OPEN_WITH_EXTS = FORMAT_GROUPS.filter((g) => !g.optIn)
  .flatMap((g) => g.exts)
  .filter((e, i, arr) => arr.indexOf(e) === i)
  .sort()

/**
 * 「打开方式」的扩展名要拆成几组。**这是飞牛数据库的硬约束，不是我们想拆。**
 *
 * 应用中心会把 app/ui/config 里**每个** .url 项的 fileTypes 写进
 * `app_service.file_types`，而那一列是 `character varying(500)`。实测：
 * 一次超过 500 字符，安装直接回滚，日志里只有一句
 *   save data error … ERROR: value too long for type character varying(500)
 * 界面上的表现是「服务异常」，且**目录已经删掉、进程还活着占着端口**。
 *
 * 为什么拆成多条服务是正规做法而不是绕过：
 *   · `app_service.app_id` 不唯一（飞牛自己的 trim.docs / 每个应用的
 *     .main + .open 都是多条）；
 *   · `app` 表里收集并集的 `file_types` 是 `text[]`，**没有长度上限** ——
 *     表结构本身就在假设"单个应用的扩展名总数远大于单列 500"；
 *   · 文件管理器查的是**按扩展名**取的列表（defaultByExt[ext]、
 *     supported[ext]），只要各组**互不重叠**，任一文件仍然只匹配到一条，
 *     「打开方式」菜单不会出现重复项。
 *
 * 装箱顺序 = FORMAT_GROUPS 的声明顺序，也就是优先级顺序：第一组装最重要的
 * 格式（办公 / PDF / 图片 / 音视频），长尾在后。这样万一哪天飞牛只认第一条
 * 服务，用户拿到的也是最有价值的那批扩展名。
 */
export const OPEN_WITH_BUCKET_LIMIT = 480

export const OPEN_WITH_BUCKETS = (() => {
  const ordered = FORMAT_GROUPS.filter((g) => !g.optIn).flatMap((g) => g.exts)
  const seen = new Set()
  const buckets = []
  let cur = []

  for (const ext of ordered) {
    if (seen.has(ext)) continue
    seen.add(ext)
    const trial = [...cur, ext]
    if (JSON.stringify(trial).length > OPEN_WITH_BUCKET_LIMIT) {
      buckets.push(cur)
      cur = [ext]
    } else {
      cur = trial
    }
  }
  if (cur.length) buckets.push(cur)

  return buckets.map((exts) => ({
    exts: [...exts].sort(),
    chars: JSON.stringify([...exts].sort()).length
  }))
})()

/** 界面上要标记成"可预览"的扩展名集合（同上，刻意不含 optIn 分组） */
export const PREVIEWABLE = new Set(OPEN_WITH_EXTS)

export function extOf(name) {
  const s = String(name || '')
  const i = s.lastIndexOf('.')
  if (i <= 0 || i === s.length - 1) return ''
  return s.slice(i + 1).toLowerCase()
}

/** 给前端用的分类信息；未登记的扩展名返回 null（前端显示为"未知类型"，仍可尝试打开） */
export function extInfo(name) {
  const e = extOf(name)
  if (!e) return { ext: '', group: '', label: '', optIn: false, previewable: false }
  const hit = EXT_INDEX.get(e)
  return {
    ext: e,
    group: hit?.group || '',
    label: hit?.label || '',
    optIn: Boolean(hit?.optIn),
    previewable: PREVIEWABLE.has(e)
  }
}

/**
 * 扩展名 → Content-Type。
 *
 * 为什么要认真写：一部分 renderer 除了看 URL/文件名后缀，也会参考响应头
 * 里的 Content-Type（尤其是 <video>/<audio>/<img> 这些原生解码路径，
 * 头不对浏览器会直接拒绝播放）。所以媒体类型必须给准。
 */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonc': 'application/json; charset=utf-8',
  '.json5': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.ofd': 'application/ofd',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.cab': 'application/vnd.ms-cab-compressed',
  '.iso': 'application/x-iso9660-image',
  '.apk': 'application/vnd.android.package-archive',
  '.epub': 'application/epub+zip',
  '.dwg': 'application/acad',
  '.dxf': 'application/dxf',
  '.dwf': 'model/vnd.dwf',
  '.dwfx': 'model/vnd.dwfx+xps',
  '.xps': 'application/vnd.ms-xpsdocument',
  '.step': 'model/step',
  '.stp': 'model/step',
  '.iges': 'model/iges',
  '.igs': 'model/iges',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.gltf': 'model/gltf+json',
  '.glb': 'model/gltf-binary',
  '.ply': 'application/octet-stream',
  '.ifc': 'application/x-step',
  '.3dm': 'model/vnd.3dm',
  '.eml': 'message/rfc822',
  '.mbox': 'application/mbox',
  '.msg': 'application/vnd.ms-outlook',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odp': 'application/vnd.oasis.opendocument.presentation'
}

/** 绝大多数文本类扩展名都归到 text/plain —— 与其在表里堆上百行，不如按后缀兜底判定 */
const TEXT_LIKE = new Set(
  FORMAT_GROUPS.find((g) => g.key === 'text').exts.concat(['lock', 'gitignore', 'editorconfig'])
)

export function mimeOf(name) {
  const e = extOf(name)
  if (!e) return 'application/octet-stream'
  const hit = MIME['.' + e]
  if (hit) return hit
  if (TEXT_LIKE.has(e)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}
