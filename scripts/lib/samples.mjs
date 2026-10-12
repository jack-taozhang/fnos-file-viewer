/**
 * 生成冒烟测试用的真实样例文件。
 *
 * 为什么不能拿几个字节的假文件去测：预览组件的 renderer 会真的去解析内容，
 * 假文件只会得到"解析失败"，那样测出来的是"错误处理路径"，
 * 而不是"这个格式到底能不能在浏览器里渲染出来" —— 而后者才是要验的东西。
 *
 * 这里手写的 PDF 是**结构完整**的（正确的 xref 偏移与对象图），
 * pdf.js 能正常打开并渲染出文字，所以它同时也是"重型 renderer + worker +
 * wasm 资产路径全通"的最强证据。
 *
 * 用法：由 smoke-browser.mjs 调用，不单独执行。
 */
import fs from 'node:fs'
import path from 'node:path'

import { makeSamplePng } from './png.mjs'
import { makeZip } from './zip.mjs'

/** 造一个最小但完全合法的单页 PDF（内容用 ASCII，避免编码干扰字节偏移） */
export function makeSamplePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 260] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null, // 占位：内容流
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]

  const stream = [
    'BT',
    '/F1 18 Tf',
    '40 190 Td',
    '(File Viewer PDF render OK) Tj',
    '0 -34 Td',
    '/F1 12 Tf',
    '(fnos-file-viewer smoke sample) Tj',
    'ET'
  ].join('\n')
  objects[3] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`

  let pdf = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefStart = Buffer.byteLength(pdf, 'latin1')
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += String(off).padStart(10, '0') + ' 00000 n \n'
  }
  pdf += xref
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

export function makeSampleSvg() {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
  <rect width="320" height="200" fill="#1b4a95"/>
  <circle cx="90" cy="100" r="52" fill="#3f82e0"/>
  <rect x="160" y="66" width="130" height="14" rx="7" fill="#c9dcf7"/>
  <rect x="160" y="94" width="100" height="14" rx="7" fill="#c9dcf7"/>
  <rect x="160" y="122" width="70" height="14" rx="7" fill="#c9dcf7"/>
</svg>
`,
    'utf8'
  )
}

export const MARKERS = {
  txt: 'FNOS-FILE-VIEWER-TEXT-MARKER',
  md: 'FNOS-FILE-VIEWER-MARKDOWN-MARKER',
  zipEntry: 'FNOS-ZIP-ENTRY-MARKER.txt',
  zipDir: '内层目录'
}

/**
 * 结构完整的 ZIP（真 CRC32 + 中央目录）。
 * 里面刻意放中文目录名和中文文件名 —— 归档预览最容易在编码上出问题。
 */
export function makeSampleZip() {
  return makeZip([
    [MARKERS.zipDir, null],
    [`${MARKERS.zipDir}/${MARKERS.zipEntry}`, 'ZIP entry content: 中文内容测试\n'],
    [`${MARKERS.zipDir}/nested.txt`, 'nested file\n'],
    ['readme.md', '# zip sample\n']
  ])
}

/**
 * 把样例写到 dir 下，返回 [{ name, file, expect }]
 * expect 说明该用什么证据判定"真的渲染出来了"。
 */
export function writeSamples(dir) {
  fs.mkdirSync(dir, { recursive: true })

  const files = [
    ['sample.pdf', makeSamplePdf()],
    ['sample.png', makeSamplePng(240)],
    ['sample.svg', makeSampleSvg()],
    [
      'sample.txt',
      Buffer.from(
        `${MARKERS.txt}\n\n第一行中文：文件预览。\n第二行：abcdefg 0123456789\n`,
        'utf8'
      )
    ],
    [
      'sample.md',
      Buffer.from(
        `# ${MARKERS.md}\n\n- 列表项一\n- 列表项二\n\n\`\`\`js\nconsole.log('hi')\n\`\`\`\n`,
        'utf8'
      )
    ],
    ['sample.zip', makeSampleZip()]
  ]

  const written = []
  for (const [name, buf] of files) {
    const p = path.join(dir, name)
    fs.writeFileSync(p, buf)
    written.push({ name, file: p, bytes: buf.length })
  }
  return written
}
