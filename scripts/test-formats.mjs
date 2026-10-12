/**
 * formats.mjs 的单元测试。
 *
 * 重点盯三件事：
 *   1) http 头要准（媒体类型错了浏览器直接拒绝播放，且报错看不出是头的问题）；
 *   2) fileTypes 里不能混进 optIn 分组 —— 那些 renderer 不在 Full 包里，
 *      声明了会在文件管理器里出现一个点了没反应的「打开方式」；
 *   3) 大小写 / 隐藏文件 / 无扩展名 这些边角不能抛异常。
 *
 * 用法：node scripts/test-formats.mjs
 */
import assert from 'node:assert/strict'

import {
  EXT_INDEX,
  FORMAT_GROUPS,
  OPEN_WITH_BUCKET_LIMIT,
  OPEN_WITH_BUCKETS,
  OPEN_WITH_EXTS,
  extInfo,
  mimeOf
} from '../server/formats.mjs'

const cases = []
const test = (name, fn) => cases.push([name, fn])

/* ── 分类 ─────────────────────────────────────────────────────── */

test('已知扩展名能查到分组', () => {
  assert.equal(extInfo('报告.docx').group, 'word')
  assert.equal(extInfo('sheet.XLSX').group, 'sheet', '大小写不敏感')
  assert.equal(extInfo('a.b.c.dwg').group, 'cad')
  assert.equal(extInfo('x.pdf').group, 'pdf')
})

test('optIn 分组要标出来', () => {
  assert.equal(extInfo('a.psd').optIn, true)
  assert.equal(extInfo('a.dcm').optIn, true)
  assert.equal(extInfo('a.docx').optIn, false)
})

test('未登记的扩展名不抛异常', () => {
  const r = extInfo('weird.zzz')
  assert.equal(r.previewable, false)
  assert.equal(r.group, '')
})

test('没有扩展名 / 点结尾 / 空字符串', () => {
  for (const name of ['README', '.gitignore', 'a.', '', null, undefined]) {
    assert.doesNotThrow(() => extInfo(name), `输入 ${JSON.stringify(name)}`)
    assert.equal(extInfo(name).previewable, false)
  }
})

test('隐藏文件不当成扩展名（.gitignore 不是 gitignore 类型）', () => {
  assert.equal(extInfo('.env').ext, '')
})

/* ── fileTypes（Open With） ───────────────────────────────────── */

test('OPEN_WITH_EXTS 不含任何 optIn 分组里的扩展名', () => {
  const optIn = new Set(FORMAT_GROUPS.filter((g) => g.optIn).flatMap((g) => g.exts))
  const leaked = OPEN_WITH_EXTS.filter((e) => optIn.has(e))
  assert.deepEqual(leaked, [], `不该出现在 fileTypes 里：${leaked.join(', ')}`)
})

test('OPEN_WITH_EXTS 无重复且已排序', () => {
  assert.equal(new Set(OPEN_WITH_EXTS).size, OPEN_WITH_EXTS.length)
  assert.deepEqual(OPEN_WITH_EXTS, [...OPEN_WITH_EXTS].sort())
})

test('OPEN_WITH_EXTS 覆盖到主要办公格式', () => {
  for (const e of ['docx', 'xlsx', 'pptx', 'pdf', 'png', 'mp4', 'zip', 'dwg', 'stl', 'md']) {
    assert.ok(OPEN_WITH_EXTS.includes(e), `fileTypes 缺少 ${e}`)
  }
})

test('每个非 optIn 分组都有扩展名', () => {
  for (const g of FORMAT_GROUPS.filter((x) => !x.optIn)) {
    assert.ok(g.exts.length > 0, `分组 ${g.key} 是空的`)
  }
})

/*
 * 「打开方式」分组。
 *
 * 这几条是安装能不能成功的判据 —— 超了 500 字符飞牛在装的过程中直接回滚，
 * 报的是「服务异常」，磁盘上什么都留不下，只有应用中心的 error.log 里有一句
 * value too long for type character varying(500)。所以宁可在这里红，别在 NAS 上红。
 */
test('OPEN_WITH_BUCKETS 每条都装得进 app_service.file_types(varchar 500)', () => {
  assert.ok(OPEN_WITH_BUCKETS.length > 0)
  for (const [i, b] of OPEN_WITH_BUCKETS.entries()) {
    const chars = JSON.stringify(b.exts).length
    assert.equal(chars, b.chars, `第 ${i + 1} 组的 chars 与实际序列化长度不符`)
    assert.ok(chars <= 500, `第 ${i + 1} 组 ${chars} 字符，超过飞牛的 500`)
    assert.ok(
      chars <= OPEN_WITH_BUCKET_LIMIT,
      `第 ${i + 1} 组 ${chars} 字符，超过装箱上限 ${OPEN_WITH_BUCKET_LIMIT}`
    )
    assert.ok(b.exts.length > 0, `第 ${i + 1} 组是空的`)
  }
})

test('OPEN_WITH_BUCKETS 互不重叠、并集等于 OPEN_WITH_EXTS', () => {
  const flat = OPEN_WITH_BUCKETS.flatMap((b) => b.exts)
  assert.equal(new Set(flat).size, flat.length, '有扩展名被分到了两组 —— 菜单会重复')
  assert.deepEqual(
    [...flat].sort(),
    [...OPEN_WITH_EXTS].sort(),
    '分组与格式表对不上（漏了或多出扩展名）'
  )
})

test('OPEN_WITH_BUCKETS 第一组就是最常用的那批（降级时损失最小）', () => {
  const first = OPEN_WITH_BUCKETS[0].exts
  for (const e of ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'csv', 'png', 'jpg', 'mp4']) {
    assert.ok(first.includes(e), `第一组里应该有 ${e}`)
  }
})

test('EXT_INDEX 里同一扩展名只归属一个分组', () => {
  const seen = new Map()
  for (const g of FORMAT_GROUPS) {
    for (const e of g.exts) {
      if (seen.has(e)) {
        assert.equal(seen.get(e), g.key, `${e} 同时出现在 ${seen.get(e)} 和 ${g.key}`)
      } else {
        seen.set(e, g.key)
      }
    }
  }
  assert.ok(seen.size > 200, `登记扩展名只有 ${seen.size} 个，表可能被改坏了`)
})

test('数字开头的扩展名不重复（3dm / 7z / 3gp）', () => {
  for (const e of ['3dm', '7z', '3gp']) {
    assert.ok(EXT_INDEX.has(e), `缺 ${e}`)
  }
})

/* ── MIME ─────────────────────────────────────────────────────── */

test('媒体类型必须给准（给错浏览器会直接拒绝播放）', () => {
  assert.equal(mimeOf('a.mp4'), 'video/mp4')
  assert.equal(mimeOf('a.webm'), 'video/webm')
  assert.equal(mimeOf('a.mp3'), 'audio/mpeg')
  assert.equal(mimeOf('a.png'), 'image/png')
  assert.equal(mimeOf('a.jpg'), 'image/jpeg')
  assert.equal(mimeOf('a.pdf'), 'application/pdf')
  assert.equal(mimeOf('a.wasm'), 'application/wasm')
  assert.equal(mimeOf('a.woff2'), 'font/woff2')
})

test('未知扩展名退到 octet-stream，不抛异常', () => {
  assert.equal(mimeOf('a.zzz'), 'application/octet-stream')
  assert.equal(mimeOf('noext'), 'application/octet-stream')
})

test('文本类退到 text/plain 并带 charset', () => {
  assert.equal(mimeOf('a.py'), 'text/plain; charset=utf-8')
  assert.equal(mimeOf('a.log'), 'text/plain; charset=utf-8')
  assert.equal(mimeOf('a.yml'), 'text/yaml; charset=utf-8')
})

/* ── 跑 ───────────────────────────────────────────────────────── */

let passed = 0
let failed = 0
for (const [name, fn] of cases) {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    console.error(`✗ ${name}\n  ${err.message}`)
  }
}

console.log(`[test:formats] ${passed} 通过 / ${failed} 失败（Open With ${OPEN_WITH_EXTS.length} 项）`)
process.exit(failed ? 1 : 0)
