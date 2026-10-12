/**
 * 生成应用图标（纯 Node，无第三方依赖）
 *
 * 需要四个文件，且必须是 8 位 RGBA PNG：
 *   fnos-package/ICON.PNG              64×64   （应用中心列表）
 *   fnos-package/ICON_256.PNG          256×256 （安装包图标）
 *   fnos-package/app/ui/images/icon_64.png   64×64   （桌面图标 1x）
 *   fnos-package/app/ui/images/icon_256.png  256×256 （桌面图标 2x）
 *
 * 为什么自己画而不是塞一张静态图：图标本来就该跟应用一起版本管理，
 * 而 PNG 编码本身只是 zlib + CRC，几十行就够 —— 为一张图去装 sharp / canvas
 * 这种带原生扩展的依赖不划算（它们在 Windows 上装起来还经常失败）。
 *
 * 用法：npm run icons
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { encodePng } from './lib/png.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/* ── 图形基元（都用 0..1 的归一化坐标） ───────────────────────── */

function inRoundRect(x, y, rx, ry, rw, rh, r) {
  const x2 = rx + rw
  const y2 = ry + rh
  if (x < rx || y < ry || x > x2 || y > y2) return false
  // 到"圆角圆心矩形"的距离：只在四角处非零
  const dx = Math.max(rx + r - x, 0, x - (x2 - r))
  const dy = Math.max(ry + r - y, 0, y - (y2 - r))
  return dx * dx + dy * dy <= r * r
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const neg = d1 < 0 || d2 < 0 || d3 < 0
  const pos = d1 > 0 || d2 > 0 || d3 > 0
  return !(neg && pos)
}

const lerp = (a, b, t) => a + (b - a) * t
const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16)
]

const BG_TOP = hex('#3f82e0')
const BG_BOTTOM = hex('#1b4a95')
const PAGE = hex('#ffffff')
const FOLD = hex('#c9dcf7')
const BAR = hex('#8fb4e8')

/** 取一个点的颜色（返回 [r,g,b,a]，a 为 0..1） */
function sample(x, y) {
  // 圆角方形底
  if (!inRoundRect(x, y, 0, 0, 1, 1, 0.225)) return [0, 0, 0, 0]

  const t = Math.min(1, Math.max(0, (y - 0.06) / 0.9))
  let r = lerp(BG_TOP[0], BG_BOTTOM[0], t)
  let g = lerp(BG_TOP[1], BG_BOTTOM[1], t)
  let b = lerp(BG_TOP[2], BG_BOTTOM[2], t)

  // 文档纸面（右上角被折角切掉一块）
  const PX = 0.265
  const PY = 0.185
  const PW = 0.47
  const PH = 0.635
  const PR = 0.05
  const FX = PX + PW // 0.735
  const FY = PY // 0.185
  const FS = 0.19 // 折角边长
  const folded = inTriangle(x, y, FX - FS, FY, FX, FY + FS, FX, FY)

  if (inRoundRect(x, y, PX, PY, PW, PH, PR) && !folded) {
    r = PAGE[0]
    g = PAGE[1]
    b = PAGE[2]

    // 文档上的三条文字线
    const bars = [
      [0.335, 0.415, 0.665, 0.452],
      [0.335, 0.505, 0.665, 0.542],
      [0.335, 0.595, 0.545, 0.632]
    ]
    for (const [bx, by, bx2, by2] of bars) {
      if (inRoundRect(x, y, bx, by, bx2 - bx, by2 - by, 0.014)) {
        r = BAR[0]
        g = BAR[1]
        b = BAR[2]
        break
      }
    }
    return [r, g, b, 1]
  }

  // 折角本身
  if (folded && inRoundRect(x, y, PX, PY, PW, PH, PR)) {
    return [FOLD[0], FOLD[1], FOLD[2], 1]
  }

  return [r, g, b, 1]
}

/* ── 渲染（超采样抗锯齿） ─────────────────────────────────────── */

const SS = 3

function render(size) {
  const out = Buffer.alloc(size * size * 4)
  const step = 1 / (size * SS)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // 按预乘 alpha 累加，最后再还原，避免边缘出现深色描边
      let ar = 0
      let ag = 0
      let ab = 0
      let aa = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step
          const y = (py * SS + sy + 0.5) * step
          const [r, g, b, a] = sample(x, y)
          ar += r * a
          ag += g * a
          ab += b * a
          aa += a
        }
      }
      const n = SS * SS
      const a = aa / n
      const i = (py * size + px) * 4
      if (a <= 0) {
        out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0
      } else {
        out[i] = Math.round(ar / aa)
        out[i + 1] = Math.round(ag / aa)
        out[i + 2] = Math.round(ab / aa)
        out[i + 3] = Math.round(a * 255)
      }
    }
  }
  return encodePng(size, size, out)
}

/* ── 输出 ─────────────────────────────────────────────────────── */

const PNG_64 = render(64)
const PNG_256 = render(256)

const outputs = [
  ['fnos-package/ICON.PNG', PNG_64],
  ['fnos-package/ICON_256.PNG', PNG_256],
  ['fnos-package/app/ui/images/icon_64.png', PNG_64],
  ['fnos-package/app/ui/images/icon_256.png', PNG_256]
]

for (const [rel, buf] of outputs) {
  const target = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, buf)
  console.log(`[icons] ${rel}（${buf.length} 字节）`)
}
