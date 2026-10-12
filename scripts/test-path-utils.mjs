/**
 * path-utils 的单元测试。
 *
 * 这些函数踩过的坑（授权目录冒号拼接、Windows 盘符被切坏、百分号重复编码）
 * 都是"表面看授权了、实际一条都读不到"那类极难排查的 bug，
 * 所以抽成纯函数并锁在这里。
 *
 * 用法：node scripts/test-path-utils.mjs
 */
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  isInside,
  normPath,
  parentCandidates,
  recoverCandidates,
  splitEnvList,
  suggestAuthorizeDir
} from '../server/path-utils.mjs'

let passed = 0
const cases = []
const test = (name, fn) => cases.push([name, fn])

/* ── splitEnvList ─────────────────────────────────────────────── */

test('冒号拼接的多个目录要拆开（飞牛就是这么传的）', () => {
  assert.deepEqual(splitEnvList('/vol1/1000/a:/vol1/1000/b'), ['/vol1/1000/a', '/vol1/1000/b'])
})

test('逗号 / 分号 / 换行 也认', () => {
  assert.deepEqual(splitEnvList('/a,/b;/c\n/d'), ['/a', '/b', '/c', '/d'])
})

test('Windows 盘符的冒号不能被当成分隔符', () => {
  const out = splitEnvList('C:\\data\\a;D:\\data\\b')
  assert.deepEqual(out, ['C:\\data\\a', 'D:\\data\\b'])
})

test('Windows 盘符 + 冒号分隔 同时出现', () => {
  const out = splitEnvList('C:\\a:D:\\b')
  assert.deepEqual(out, ['C:\\a', 'D:\\b'])
})

test('去重、去尾斜杠、丢空段', () => {
  assert.deepEqual(splitEnvList('/a/:/a:,: '), ['/a'])
})

test('空输入返回空数组', () => {
  assert.deepEqual(splitEnvList(''), [])
  assert.deepEqual(splitEnvList(null), [])
  assert.deepEqual(splitEnvList(undefined), [])
})

/* ── isInside ─────────────────────────────────────────────────── */

test('同路径算在内', () => {
  assert.equal(isInside('/vol1/1000', '/vol1/1000'), true)
})

test('子路径算在内', () => {
  assert.equal(isInside('/vol1/1000/a.pdf', '/vol1/1000'), true)
})

test('前缀相同但不是子目录不算在内（/a/bc vs /a/b）', () => {
  assert.equal(isInside('/a/bc', '/a/b'), false)
})

test('父目录不算在内', () => {
  assert.equal(isInside('/vol1', '/vol1/1000'), false)
})

/* ── recoverCandidates ────────────────────────────────────────── */

test('原样保留', () => {
  assert.deepEqual(recoverCandidates('/vol1/a.pdf'), ['/vol1/a.pdf'])
})

test('冒号整串会额外切出每一段', () => {
  const out = recoverCandidates('/vol1/a:/vol1/b')
  assert.ok(out.includes('/vol1/a'))
  assert.ok(out.includes('/vol1/b'))
})

test('百分号重复编码会解一次', () => {
  const out = recoverCandidates('/vol1/%E6%8A%A5%E5%91%8A.pdf')
  assert.ok(out.includes('/vol1/报告.pdf'))
})

test('非法转义序列不会抛异常', () => {
  assert.doesNotThrow(() => recoverCandidates('/vol1/%E4%B8'))
})

/* ── parentCandidates ─────────────────────────────────────────── */

test('逐级上溯', () => {
  assert.deepEqual(parentCandidates('/a/b/c'), ['/a/b', '/a'])
})

test('带上尾斜杠也能处理', () => {
  assert.deepEqual(parentCandidates('/a/b/c/'), ['/a/b', '/a'])
})

/* ── suggestAuthorizeDir ──────────────────────────────────────── */

test('文件退到父目录', () => {
  assert.equal(suggestAuthorizeDir('/vol1/1000/报告.pdf'), '/vol1/1000')
})

test('目录取自身', () => {
  assert.equal(suggestAuthorizeDir('/vol1/1000'), '/vol1/1000')
})

test('根目录边界', () => {
  assert.equal(suggestAuthorizeDir('/'), '/')
})

/* ── normPath ─────────────────────────────────────────────────── */

test('normPath 得到绝对路径（Windows 上还会统一小写，便于比较）', () => {
  const expected =
    process.platform === 'win32'
      ? path.resolve('/a/../b').toLowerCase()
      : path.resolve('/a/../b')
  assert.equal(normPath('/a/../b'), expected)
})

/* ── 跑 ───────────────────────────────────────────────────────── */

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

console.log(`[test:path-utils] ${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
