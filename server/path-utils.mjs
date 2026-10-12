/**
 * 路径相关的纯函数。
 *
 * 单独成文件的原因：server/index.mjs 一被 import 就会 listen 端口，
 * 没法在测试里引用；把"没有副作用"的逻辑抽出来，就能用
 * scripts/test-path-utils.mjs 覆盖住。
 *
 * 这些函数直接沿用 fnos-dwg-viewer 里已经踩过坑的版本 —— 授权目录冒号
 * 拼接、Windows 盘符、百分号重复编码这几个坑是飞牛应用共有的，不必重踩。
 */
import path from 'node:path'

/** Windows 盘符大小写不敏感，比较路径前先归一化；Linux 保持严格比较 */
export const normPath = (p) =>
  process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)

/** target 是否等于 root 或位于 root 之内（防止 /a/bc 被 /a/b 命中） */
export function isInside(target, root) {
  const t = normPath(target)
  const r = normPath(root)
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

/**
 * 解析「路径列表」形式的环境变量。
 *
 * 飞牛把用户在「授权目录」里勾选的**多个**目录用冒号拼成一个字符串
 * （和 PATH 一样），而 Docker / 手工部署习惯用逗号或分号。三种都认。
 *
 * 坑：Windows 盘符自带冒号（C:\data），所以切出来的"单字母段"要把
 * 冒号还回去，否则 D:\data 会被切成 "D" 和 "\data" 两段。
 */
export function splitEnvList(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []

  const out = []
  for (const chunk of text.split(/[;,\r\n]+/)) {
    const parts = chunk.split(':')
    let cur = ''
    for (const part of parts) {
      if (cur === '') {
        cur = part
        continue
      }
      // cur 是裸盘符："C" + "\data" → 合回 "C:\data"
      if (cur.length === 1 && /[a-zA-Z]/.test(cur)) {
        cur = `${cur}:${part}`
        continue
      }
      out.push(cur)
      cur = part
    }
    if (cur) out.push(cur)
  }

  const seen = new Set()
  const result = []
  for (const item of out) {
    const v = item.trim().replace(/[/\\]+$/, '')
    if (!v || seen.has(v)) continue
    seen.add(v)
    result.push(v)
  }
  return result
}

/**
 * 请求路径的兜底候选（按可信度从高到低）。
 *
 * 解决两类"用户看着明明打开了却读不到"的现实问题：
 *  1) 飞牛偶尔把整个「授权目录列表」当成路径传进来：/vol1/a:/vol1/b；
 *  2) 文件管理器偶发把已经百分号编码过的路径再传一次：
 *     /vol1/a/%E6%8A%A5%E5%91%8A.pdf。
 *
 * 这里只负责"猜"，是否真的采纳由调用方 stat + 白名单校验决定。
 */
export function recoverCandidates(raw) {
  const out = []
  const seen = new Set()
  const add = (v) => {
    if (typeof v !== 'string') return
    const t = v.trim()
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }

  const base = String(raw ?? '')
  add(base)

  /** 冒号分隔的每一段也当作候选 */
  const addColonSegments = (value) => {
    const segs = value.split(':').filter(Boolean)
    if (segs.length > 1) for (const s of segs) add(s)
  }
  addColonSegments(base)

  // 百分号编码：解码一次后再试（含解码后的冒号切段）
  for (const value of [...out]) {
    try {
      const decoded = decodeURIComponent(value)
      if (decoded === value) continue
      add(decoded)
      addColonSegments(decoded)
    } catch {
      /* 非法转义序列，跳过 */
    }
  }

  return out
}

/**
 * 从末尾逐级去掉路径段。
 *
 * 用于目录被改名 / 删除后的兜底：与其报"目录不存在"，不如退到最近一个
 * 真实存在的上级目录，前端拿到回传的真实路径后也会自动跟着纠正。
 */
export function parentCandidates(p, maxDepth = 8) {
  const out = []
  let cur = String(p).replace(/[/\\]+$/, '')
  for (let i = 0; i < maxDepth; i++) {
    const idx = Math.max(cur.lastIndexOf('/'), cur.lastIndexOf('\\'))
    if (idx <= 0) break
    cur = cur.slice(0, idx)
    out.push(cur)
  }
  return out
}

/** 应急模式（scoped）下给用户的"该授权哪个目录"提示：文件退到父目录，目录取自身 */
export function suggestAuthorizeDir(raw) {
  const cleaned = String(raw).replace(/\\/g, '/').replace(/\/+$/, '')
  if (!cleaned) return '/'
  if (path.extname(cleaned)) {
    const dir = cleaned.slice(0, cleaned.lastIndexOf('/'))
    return dir || '/'
  }
  return cleaned
}
