// client/platform/selectors.js
//
// ⚠️⚠️ 本文件是【未验证骨架】，不是已验证结论 ⚠️⚠️
//
// 全部选择器均来自 legacy/ 旧代码与 shared/已知陷阱与平台知识.md，
// 属于"候选定义"。**尚未在真实抖音页面上验证**（P2 验证门 G-4 未执行）。
//
// 使用要求：
//   1. lastVerifiedAt = 离线 fixture 验证（已做，可复跑）；liveVerifiedAt = 真机验证（未做）。
//      ⚠️ 禁止把 liveVerifiedAt 填成日期来"看起来完成"——违反 AGENTS.md §6 完成定义。
//   2. P2 G-4 验证通过后，逐条回填 liveVerifiedAt（YYYY-MM-DD）与 verifiedBy。
//   3. confidence 为 low 的条目（如模糊 class 匹配）改版后最易失效，
//      验证时应优先确认真实容器结构，而非直接采信模糊匹配。
//   4. 这是全项目【唯一】允许出现抖音选择器字符串的地方。其他文件出现
//      data-e2e 等选择器视为缺陷（AGENTS.md §3）。
'use strict'

module.exports = {
  commentList: {
    key: 'commentList',
    name: '视频评论区列表容器',
    channel: 'comment',
    candidates: ['[data-e2e="comment-list"]'],
    match: 'first-visible',
    required: true,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'high',
    fixture: 'video-page-desktop-01.html',
    notes: '⚠️ 页面可能同时存在隐藏与可见两套（legacy reply_worker.js:78,100,150）；必须用 rect 非零的那个',
  },
  commentItem: {
    key: 'commentItem',
    name: '评论项',
    channel: 'comment',
    candidates: ['[data-e2e="comment-item"]'],
    match: 'all',
    required: true,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'high',
    fixture: 'video-page-desktop-01.html',
    notes: 'legacy reply_worker.js:78,100',
  },
  commentContent: {
    key: 'commentContent',
    name: '评论正文节点',
    channel: 'comment',
    candidates: ['[data-e2e="comment-content"]'],
    match: 'first',
    required: false,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'high',
    fixture: 'video-page-desktop-01.html',
    notes: 'legacy reply_worker.js:326（兜底1 点击正文用）',
  },
  replyButton: {
    key: 'replyButton',
    name: '回复按钮',
    channel: 'comment',
    candidates: ['button', '[role="button"]', 'a', 'div', 'span'],
    match: 'first',
    required: true,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'medium',
    fixture: 'video-page-desktop-01.html',
    notes: '⚠️ 判据是去空白后 innerText 严格等于「回复」；须排除弹幕（legacy reply_worker.js:83-92,338）',
  },
  inlineEditor: {
    key: 'inlineEditor',
    name: '内联回复编辑器',
    channel: 'comment',
    candidates: ['[contenteditable=true]'],
    match: 'first',
    required: true,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'high',
    fixture: 'video-page-desktop-01.html',
    notes: '⚠️ 必须在含「回复中」的 comment-item 内查找（legacy reply_worker.js:305）',
  },
  danmakuRow: {
    key: 'danmakuRow',
    name: '直播弹幕行',
    channel: 'live_danmaku',
    candidates: ['[class*="danmaku"]', '[class*="chatroom"]'],
    match: 'all',
    required: true,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'low',
    fixture: 'live-room-desktop-01.html',
    notes: '⚠️ legacy live_dom_collector.js:349-357 是 7 个模糊匹配；模糊选择器标 low',
  },
  noteDetail: {
    key: 'noteDetail',
    name: '图文帖容器',
    channel: 'comment',
    candidates: ['.note-detail-container'],
    match: 'first',
    required: false,
    lastVerifiedAt: '2026-09-18',  // 离线 fixture 回归验证日期（可自动复跑：node test/run.js L3）
    liveVerifiedAt: null,          // ⚠️ 未经【真机】验证：P2 验证门 G-4 完成后回填
    verifiedBy: null,              // ⚠️ 真机验证人：P2 G-4 完成后回填
    confidence: 'high',
    fixture: 'note-page-desktop-01.html',
    notes: 'legacy reply_worker.js:178 用于判定 note_post_panel_unsupported',
  },
}
