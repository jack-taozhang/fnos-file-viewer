/**
 * 诊断用外层包装：只记录「服务端真正回了什么状态码」，不碰产品代码。
 * 通过 monkey-patch ServerResponse.writeHead 拿到真相（CDP 侧看到的状态可能是别的会话的）。
 */
import http from 'node:http'

const orig = http.ServerResponse.prototype.writeHead
http.ServerResponse.prototype.writeHead = function (status, ...rest) {
  const req = this.req || {}
  const q = String(req.url || '').split('?')[0]
  console.log(
    `[RES] ${status} ${req.method} ${q} range=${req.headers?.range || '-'} depth=${this.getHeader('content-length') || '-'}`
  )
  return orig.apply(this, [status, ...rest])
}

const origEnd = http.ServerResponse.prototype.end
http.ServerResponse.prototype.end = function (...args) {
  const req = this.req || {}
  if (/\/api\/file/.test(String(req.url || ''))) {
    console.log(`[END] status=${this.statusCode} ${req.method} ${String(req.url).split('?')[0]}`)
  }
  return origEnd.apply(this, args)
}

await import('../server/index.mjs')
