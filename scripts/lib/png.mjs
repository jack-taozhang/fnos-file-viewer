/**
 * 最小 PNG 编码器（8 位 RGBA，无第三方依赖）。
 *
 * PNG 的"编码"部分本来就只是 zlib + CRC32，为一张图去装 sharp / canvas
 * 这类带原生扩展的依赖不划算（在 Windows 上装起来还经常失败）。
 * 图标生成与测试夹具共用这一份，避免 CRC 表在两个文件里各抄一遍。
 */
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/**
 * @param {number} w
 * @param {number} h
 * @param {Buffer} rgba 长度必须是 w*h*4
 * @returns {Buffer} PNG 文件内容
 */
export function encodePng(w, h, rgba) {
  if (rgba.length !== w * h * 4) {
    throw new Error(`rgba 长度应为 ${w * h * 4}，实际 ${rgba.length}`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每行前面加一个 filter 字节（0 = None）
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** 造一张可直接看的测试图：渐变底 + 斜条纹，方便肉眼确认渲染出来了 */
export function makeSamplePng(size = 240) {
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const t = y / (size - 1)
      const stripe = ((x + y) % 48) < 12
      buf[i] = Math.round(60 + 150 * t + (stripe ? 40 : 0))
      buf[i + 1] = Math.round(120 + 60 * (1 - t))
      buf[i + 2] = Math.round(220 - 90 * t)
      buf[i + 3] = 255
    }
  }
  return encodePng(size, size, buf)
}
