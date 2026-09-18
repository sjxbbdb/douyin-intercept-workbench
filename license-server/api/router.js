'use strict'

// license-server/api/router.js
//
// 极简路由器。用 Node 内置 http，不引框架。
//
// ⚠️ 为什么不引 express：
//   1. 依赖白名单只有 `ws`（见 shared/术语与选型基准.md §3.2）
//   2. 本项目路由数量有限（约 20 条），且都是 JSON in / JSON out
//   3. 引入框架会给"服务端可被审计"增加不必要的黑盒

const { AppError } = require('../../shared/lib/errors')

const MAX_BODY_BYTES = 2 * 1024 * 1024 // 2 MB（protocol.md §3.2 REPORT_TOO_LARGE）

/**
 * 路由表。支持 `:param` 形式的路径参数。
 */
class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    const { regex, keys } = compilePattern(pattern)
    this.routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler })
    return this
  }

  get(p, h) { return this.add('GET', p, h) }
  post(p, h) { return this.add('POST', p, h) }
  put(p, h) { return this.add('PUT', p, h) }

  /** 匹配路由。返回 { handler, params } 或 null。 */
  match(method, pathname) {
    const m = method.toUpperCase()
    for (const r of this.routes) {
      if (r.method !== m) continue
      const hit = r.regex.exec(pathname)
      if (!hit) continue
      const params = {}
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(hit[i + 1]) })
      return { handler: r.handler, params, pattern: r.pattern }
    }
    return null
  }

  /** 该路径是否存在（用于区分 404 与 405）。 */
  hasPath(pathname) {
    return this.routes.some((r) => r.regex.test(pathname))
  }
}

function compilePattern(pattern) {
  const keys = []
  const escaped = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp(`^${escaped}$`), keys }
}

/**
 * 读取 JSON 请求体，并**保留原始字节**。
 *
 * ⚠️ 必须返回 raw：契约 §5.1 要求签名覆盖
 *    `sha256_hex(raw_body_bytes)`，即**原始字节的哈希**，
 *    而不是重新序列化后的对象。若用 JSON.stringify(parsed) 重算，
 *    客户端的空格、key 顺序、数字格式差异都会导致签名不一致。
 *
 * ⚠️ 体积必须限制：不限制的话一个超大 body 就能耗尽内存。
 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new AppError('REPORT_TOO_LARGE', '请求体超过 2 MB 上限'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      resolve({ raw, parsed: parseJsonObject(raw) })
    })
    req.on('error', (e) => reject(new AppError('SERVER_INTERNAL', `读取请求失败：${e.message}`)))
  })
}

/** 解析 JSON 对象。空体视为 {}。非对象或非法 JSON 抛错。 */
function parseJsonObject(raw) {
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new AppError('AUTH_INVALID_REQUEST', '请求体不是合法 JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('AUTH_INVALID_REQUEST', '请求体必须是 JSON 对象')
  }
  return parsed
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // 本地/内网服务，不缓存任何响应
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  res.end(body)
}

/**
 * 统一的错误响应。
 *
 * ⚠️ 只有 AppError（expose=true）才把 message 回给客户端。
 *    未预期的异常一律返回 SERVER_INTERNAL 且**不回显原始消息**——
 *    否则 SQL 错误、路径等内部信息会泄露出去。
 */
function sendError(res, err, log) {
  if (err instanceof AppError) {
    return sendJson(res, err.status, err.toEnvelope())
  }
  if (log) log.error('unhandled_error', { message: err && err.message, stack: err && err.stack })
  return sendJson(res, 500, {
    ok: false,
    code: 'SERVER_INTERNAL',
    message: '服务端内部错误',
  })
}

module.exports = { Router, readJsonBody, parseJsonObject, sendJson, sendError, MAX_BODY_BYTES }
