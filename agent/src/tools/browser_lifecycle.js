'use strict';

const capture = require('./_capture');

// 浏览器生命周期：采集类工具都需要一个由 sidecar 启动的专用 Chrome。
// 这两个动作都不碰平台内容（不发布任何东西），只管理那个浏览器进程。

function startRun(ctx) {
  const outcome = capture.invoke(ctx, 'launch', {});
  if (!outcome.ok) return outcome;
  return { ok: true, result: {
    ok: true,
    status: outcome.status,
    browser: outcome.result,
    note: '浏览器已就绪。窗口必须保持可见，被遮挡时点击与读取都会失效。'
  } };
}

function closeRun(ctx) {
  const outcome = capture.invoke(ctx, 'close', {});
  if (!outcome.ok) return outcome;
  return { ok: true, result: { ok: true, status: outcome.status, closed: outcome.result || true } };
}

module.exports = { startRun, closeRun };
