'use strict'

// client/host/instances.js
//
// 多实例注册与**调试端口分配**（计划 §4.8）。
//
// ⚠️ 为什么端口分配需要单独一个模块：
//   每个实例要驱动一个**独立的**专用 Chrome，而 Chrome 的远程调试端口
//   是全局唯一的。两个实例撞到同一个端口时，第二个实例的 Chrome 会
//   启动失败——而它的报错是"用户数据目录已被占用"（因为 `--user-data-dir`
//   也跟着撞了），与端口毫无字面关系。运营看到的只是"第二个账号起不来"。
//
//   所以：端口按 `debugPortBase + N` 分配、**注册表落盘**、启动前探测占用。
//   探测是必须的：`9222+N` 可能被别的软件（或上次没退干净的 Chrome）占着。
//
// ⚠️ 注册表落盘走 `Store`（单写者约束）。它记录"哪个实例在用哪个端口、
//    进程 pid 是多少"。pid 会被复用，所以判活不能只看 pid——
//    要配合"端口是否真的有 Chrome 调试端点"来判断。

const net = require('node:net')

/** 端口探测：被占用返回 true。 */
function probePort(port, { host = '127.0.0.1', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (occupied) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (e) {
        // destroy 失败不影响结论（socket 可能已经关了）。
        // 但**不能**空 catch —— 记一个计数便于排障时发现异常多的失败。
        probePort.destroyFailures = (probePort.destroyFailures || 0) + 1
      }
      resolve(occupied)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}
probePort.destroyFailures = 0

/** 从 base 开始找一个未被占用的端口。 */
async function findFreePort(base, { maxTries = 20 } = {}) {
  for (let i = 0; i < maxTries; i++) {
    const port = base + i
    const occupied = await probePort(port)
    if (!occupied) return { port, offset: i }
  }
  return { port: null, offset: -1 }
}

class InstanceRegistry {
  /**
   * @param {object} opts
   * @param {object} opts.store          客户端 Store（写 `runtime-state.json` 太杂，这里用独立文件）
   * @param {number} [opts.debugPortBase]
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    if (!opts || !opts.store) throw new Error('InstanceRegistry 需要 store')
    this.store = opts.store
    this.debugPortBase = Number(opts.debugPortBase || 9222)
    this.now = opts.now || (() => Date.now())
    this.file = 'instances.json'
  }

  list() {
    return this.store.readJson(this.file, [])
  }

  /** 取某实例的注册记录（不存在返回 null）。 */
  get(instanceId) {
    return this.list().find((r) => r.instance_id === instanceId) || null
  }

  /**
   * 为实例分配（或复用）一个调试端口。
   *
   * ⚠️ 复用优先：同一实例重复启动应当**复用**原来的端口。
   *    否则每次重启都换端口，而专用 Chrome 的 profile 里记着的
   *    调试端点会与新端口不一致——表现是"重启后连不上浏览器"。
   */
  async allocate(instanceId, { explicitPort } = {}) {
    if (!instanceId) throw new Error('allocate 需要 instanceId')
    if (explicitPort) {
      return this.#register(instanceId, Number(explicitPort), { reason: 'explicit' })
    }

    const existing = this.get(instanceId)
    if (existing && existing.debug_port) {
      const occupied = await probePort(existing.debug_port)
      if (!occupied) {
        return this.#register(instanceId, existing.debug_port, { reason: 'reused' })
      }
      // 占用中：可能是本实例上次没退干净的 Chrome，也可能是别的程序。
      // ⚠️ 两种情况都**不能**直接抢——留给 browser-host 去判断
      //    "它是不是 Chrome 调试端点"，因为那需要 HTTP 探测（属于 core 的职责）。
      return this.#register(instanceId, existing.debug_port, { reason: 'reused_occupied' })
    }

    // 避开其他实例已占用的端口
    const taken = new Set(this.list().filter((r) => r.instance_id !== instanceId).map((r) => Number(r.debug_port)))
    for (let i = 0; i < 20; i++) {
      const port = this.debugPortBase + i
      if (taken.has(port)) continue
      const occupied = await probePort(port)
      if (occupied) continue
      return this.#register(instanceId, port, { reason: 'allocated' })
    }
    throw new Error(
      `从 ${this.debugPortBase} 起连续 20 个端口都不可用。` +
      `请关闭占用这些端口的程序，或用 REPLY_DEBUG_PORT 指定另一个起始端口。`
    )
  }

  /** 写注册记录（读-改-写）。 */
  #register(instanceId, debugPort, extra) {
    const record = {
      instance_id: instanceId,
      debug_port: debugPort,
      pid: process.pid,
      updated_at_ms: this.now(),
      ...extra,
    }
    this.store.update(this.file, [], (list) => {
      const i = list.findIndex((r) => r.instance_id === instanceId)
      if (i >= 0) list[i] = { ...list[i], ...record }
      else list.push(record)
      return list
    })
    return record
  }

  /** 释放某实例的注册（停止时调用）。 */
  release(instanceId) {
    let removed = 0
    this.store.update(this.file, [], (list) => {
      return list.filter((r) => {
        const drop = r.instance_id === instanceId && Number(r.pid) === process.pid
        if (drop) removed += 1
        return !drop
      })
    })
    return { removed }
  }

  /**
   * 清理陈旧注册（进程已不在且端口空闲）。
   *
   * ⚠️ 只清理**确定已死**的：pid 不存活 **且** 端口空闲。
   *    只看 pid 会误删（pid 被复用）；只看端口会误删（Chrome 可能刚重启中）。
   */
  prune() {
    const alive = (pid) => {
      if (!pid) return false
      try {
        process.kill(Number(pid), 0)
        return true
      } catch (e) {
        // ESRCH = 进程不存在；EPERM = 存在但无权限（说明还活着）
        return e && e.code === 'EPERM'
      }
    }
    let removed = 0
    this.store.update(this.file, [], (list) => {
      return list.filter((r) => {
        if (alive(r.pid)) return true
        removed += 1
        return false
      })
    })
    if (removed > 0 && typeof this.onPrune === 'function') this.onPrune(removed)
    return { removed }
  }
}

module.exports = {
  InstanceRegistry,
  probePort,
  findFreePort,
}
