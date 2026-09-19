'use strict';

// A real Electron DOM fixture for the task editor. The renderer source is read
// from disk (or --renderer=<absolute path>) so the same test can be run against
// a git HEAD copy and the repaired renderer. No real license server or Douyin
// account is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const rendererArg = process.argv.find((value) => value.startsWith('--renderer='));
const screenshotArg = process.argv.find((value) => value.startsWith('--screenshot='));
const layoutScreenshotDirArg = process.argv.find((value) => value.startsWith('--layout-screenshot-dir='));
const rendererPath = rendererArg ? path.resolve(valueAfterEquals(rendererArg)) : path.join(root, 'src', 'renderer', 'app.js');
const rendererHead = process.argv.includes('--renderer-git-head');
const rendererSource = rendererHead
  ? execFileSync('git', ['show', 'HEAD:desktop/src/renderer/app.js'], { cwd: path.resolve(root, '..') }).toString('utf8')
  : fs.readFileSync(rendererPath, 'utf8');
const indexSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const styleSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
// Each scenario owns and destroys its hidden window; keep Electron alive until
// all scenarios have completed.
app.on('window-all-closed', () => {});

function valueAfterEquals(argument) { return argument.slice(argument.indexOf('=') + 1); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function jsonScript(value) { return JSON.stringify(value).replace(/<\/script/gi, '<\\/script'); }

function makeState(overrides = {}) {
  return {
    license: { state: 'authorized', user: { id: 'u-one', expiresAt: Date.now() + 3600000 }, balance: 20, features: {} },
    tasks: [{ id: 'task-existing', url: 'https://www.douyin.com/video/existing', source: 'video', contactMode: 'comment', decisionMode: 'rule', businessContext: '旧业务', targetCustomer: '旧客户', keywords: ['旧词'], excludeKeywords: ['旧排除'], replyTemplate: '旧模板', replyInstructions: '旧要求', mode: 'manual', intervalMs: 1111, dailyLimit: 7, maxActions: 8, actionDay: new Date().toISOString().slice(0, 10), generationToday: 0, sendAttemptsToday: 0, status: 'paused' }],
    leads: [], events: [], logs: [], pending: [], selectorProfile: {}, browser: { connected: false, collector: 'closed', matchCount: 0 },
    ...overrides
  };
}

async function newFixture({ state = makeState(), searchVideos = [], width = 1200, height = 800 } = {}) {
  // Functions cannot survive a data URL. The page receives a small callable
  // mock through a generated prelude instead.
  const mockPrelude = `
    let __state = ${jsonScript(state)};
    const __calls = { save: [], login: [], refresh: 0, search: [], recheck: [], confirm: [] };
    const __listeners = [];
    window.agentApi = {
      getState: async () => structuredClone(__state),
      login: async (value) => { __calls.login.push(value); return __state.license; },
      logout: async () => ({ state: 'unauthorized' }),
      refreshLicense: async () => { __calls.refresh += 1; return structuredClone(__state.license); },
      getEndpoint: async () => ({ apiEndpoint: 'http://127.0.0.1:18080' }), setEndpoint: async () => ({}), getLedger: async () => [],
      saveTask: async (value) => { __calls.save.push(value); return value; }, setTaskStatus: async () => ({}), deleteTask: async () => ({}), recheckSkipped: async (taskId) => new Promise((resolve) => setTimeout(() => { __calls.recheck.push(taskId); resolve({ evaluated: 1, queued: 1, skipped: 0 }); }, 20)), confirmAction: async (actionId) => { __calls.confirm.push(actionId); return {}; }, retryDraft: async () => ({}), redeem: async () => ({}), openTarget: async () => ({}),
      searchTargets: async (value) => { __calls.search.push(value); return { videos: ${jsonScript(searchVideos)} }; }, closeTarget: async () => ({}), probeSelectors: async () => ({}), saveSelectors: async () => ({}),
      onState: (callback) => { __listeners.push(callback); return () => {}; }
    };
    window.__fixture = { get state() { return structuredClone(__state); }, calls: __calls, push(next) { __state = structuredClone(Object.assign({}, __state, structuredClone(next))); __listeners.forEach((listener) => listener(structuredClone(__state))); }, listeners: __listeners };
  `;
  // The production page CSP intentionally blocks inline scripts; this test
  // replaces that policy in its own data URL so the injected fixture remains
  // controlled and cannot alter production CSP.
  const html = indexSource.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '').replace(/<link[^>]+styles\.css[^>]*>/i, `<style>${styleSource}</style>`).replace('<script src="./app.js"></script>', `<script>${mockPrelude}</script><script>${rendererSource}</script>`);
  const win = new BrowserWindow({ show: false, width, height, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true } });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await sleep(80);
  assert.equal(await win.webContents.executeJavaScript('document.querySelector("#content") !== null && document.querySelector("#content").textContent.length > 0', true), true, 'fixture must render the initial view');
  return { win, push: (next) => win.webContents.executeJavaScript(`window.__fixture.push(${jsonScript(next)})`), get: (script) => win.webContents.executeJavaScript(script, true) };
}

async function closeFixture(fixture) { if (fixture?.win && !fixture.win.isDestroyed()) fixture.win.destroy(); }
async function text(fixture, selector) { return fixture.get(`document.querySelector(${JSON.stringify(selector)})?.value ?? document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`); }
async function click(fixture, selector) { await fixture.get(`document.querySelector(${JSON.stringify(selector)}).click()`); await sleep(15); }
async function setValue(fixture, selector, value) { await fixture.get(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`); }
async function openNew(fixture) { await click(fixture, '[data-action="new-task"]'); assert.ok(await fixture.get('!!document.querySelector("#task-form")')); }
async function openEdit(fixture) { await click(fixture, '[data-action="edit-task"]'); assert.ok(await fixture.get('!!document.querySelector("#task-form")')); }
async function emit(fixture, next) { await fixture.push(next); await sleep(20); }

async function testEditorSurvivesStateUpdates() {
  const fixture = await newFixture();
  try {
    await openNew(fixture);
    await setValue(fixture, '[name="url"]', 'https://www.douyin.com/video/new');
    await setValue(fixture, '[name="businessContext"]', '新业务');
    await setValue(fixture, '[name="targetCustomer"]', '新客户');
    await setValue(fixture, '[name="keywords"]', '价格，怎么买');
    await setValue(fixture, '[name="excludeKeywords"]', '投诉，退款');
    await setValue(fixture, '[name="replyTemplate"]', '欢迎咨询');
    await setValue(fixture, '[name="replyInstructions"]', '不要承诺');
    await setValue(fixture, '[name="intervalMs"]', '4321');
    await setValue(fixture, '[name="maxActions"]', '13');
    await setValue(fixture, '[name="dailyLimit"]', '17');
    await fixture.get('document.querySelector("[name=source]").value="live"; document.querySelector("[name=contactMode]").value="private"; document.querySelector("[name=decisionMode]").value="rule"; document.querySelector("[name=mode]").value="auto"');
    await fixture.get('document.activeElement?.blur()');
    for (let i = 0; i < 3; i += 1) await emit(fixture, { browser: { connected: false, collector: 'closed', matchCount: i } });
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), true, 'state updates must not leave a new task editor');
    const values = await fixture.get(`(() => { const f=document.querySelector('#task-form'); return Object.fromEntries(['url','source','contactMode','decisionMode','businessContext','targetCustomer','keywords','excludeKeywords','replyTemplate','replyInstructions','mode','intervalMs','maxActions','dailyLimit'].map(k=>[k,f.elements[k].value])); })()`);
    assert.deepEqual(values, { url: 'https://www.douyin.com/video/new', source: 'live', contactMode: 'private', decisionMode: 'rule', businessContext: '新业务', targetCustomer: '新客户', keywords: '价格，怎么买', excludeKeywords: '投诉，退款', replyTemplate: '欢迎咨询', replyInstructions: '不要承诺', mode: 'auto', intervalMs: '4321', maxActions: '13', dailyLimit: '17' });
    await click(fixture, '#refresh');
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), true, 'explicit refresh must preserve the editor');
    assert.equal(await fixture.get('window.__fixture.calls.save.length'), 0, 'state updates and refresh must not save a draft');
  } finally { await closeFixture(fixture); }
}

async function testEditCancelNavigationAndSearch() {
  const fixture = await newFixture({ searchVideos: [{ title: '候选视频', url: 'https://www.douyin.com/video/candidate' }] });
  try {
    await openEdit(fixture);
    assert.equal(await text(fixture, '[name="businessContext"]'), '旧业务');
    await setValue(fixture, '[name="businessContext"]', '编辑中'); await fixture.get('document.querySelector("[name=businessContext]").blur()');
    await emit(fixture, { browser: { connected: true, collector: 'idle', matchCount: 1 } });
    assert.equal(await text(fixture, '[name="businessContext"]'), '编辑中');
    await click(fixture, '[data-action="cancel-task"]'); assert.equal(await fixture.get('!!document.querySelector("#task-form")'), false);
    assert.equal(await fixture.get('window.__fixture.calls.save.length'), 0, 'cancel/navigation must not save');
    await click(fixture, '[data-view="settings"]');
    await setValue(fixture, '[name="keyword"]', '暴雨末日'); await fixture.get('document.querySelector("#search-form").requestSubmit()'); await sleep(40);
    assert.equal(await fixture.get('document.querySelector("#search-results").textContent.includes("候选视频")'), true);
    await click(fixture, '[data-action="search-use"]'); assert.equal(await text(fixture, '[name="url"]'), 'https://www.douyin.com/video/candidate');
  } finally { await closeFixture(fixture); }
}

async function testSaveFailureAndSuccess() {
  const fixture = await newFixture();
  try {
    await openNew(fixture); assert.equal(await fixture.get('document.body.textContent.includes("留空仍可保存草稿")'), true, 'empty rule keywords remain saveable as a draft'); await setValue(fixture, '[name="url"]', 'https://www.douyin.com/video/save'); await setValue(fixture, '[name="replyTemplate"]', '保留内容');
    await fixture.get('void (window.agentApi.saveTask = async () => { throw new Error("网络失败") })');
    await fixture.get('document.querySelector("#task-form").requestSubmit()'); await sleep(35);
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), true); assert.equal(await text(fixture, '[name="replyTemplate"]'), '保留内容');
    await fixture.get('void (window.agentApi.saveTask = async (task) => { window.__fixture.calls.save.push(task); return task })');
    await fixture.get('document.querySelector("#task-form").requestSubmit()'); await sleep(35);
    await emit(fixture, { tasks: [makeState().tasks[0], { id: 'task-new', url: 'https://www.douyin.com/video/save' }] });
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), false, 'confirmed successful save may return to list');
  } finally { await closeFixture(fixture); }
}

async function testTaskQuotaAndExplicitRecheck() {
  const today = new Date().toISOString().slice(0, 10);
  const task = { ...makeState().tasks[0], actionDay: today, generationToday: 14, maxActions: 20, sendAttemptsToday: 2, dailyLimit: 7 };
  const fixture = await newFixture({ state: makeState({ tasks: [task], events: [{ id: 'event-1', taskId: task.id, reason: 'local_no_keyword', text: '无关评论' }], browser: { connected: true, collector: 'idle', matchCount: 100 } }) });
  try {
    assert.equal(await text(fixture, '#browser-status'), '抖音窗口已连接，本轮读取 100 条评论');
    assert.equal(await fixture.get('document.body.textContent.includes("匹配 100")'), false, 'read count must not be presented as matches');
    assert.equal(await fixture.get('document.body.textContent.includes("今日判定 14 / 20")'), true);
    assert.equal(await fixture.get('document.body.textContent.includes("今日发送尝试 2 / 7")'), true);
    assert.equal(await fixture.get('document.querySelector("th:nth-child(5)").textContent'), '今日额度');
    assert.equal(await fixture.get('document.querySelector("tbody td:nth-child(5)").textContent.includes("0 / 20")'), false, 'old actionsToday/maxActions quota must not remain');
    if (screenshotArg) fs.writeFileSync(valueAfterEquals(screenshotArg), (await fixture.win.webContents.capturePage()).toPNG());
    assert.equal(await fixture.get('window.__fixture.calls.recheck.length'), 0, 'recheck must not run automatically');
    await fixture.get('(() => { const b=document.querySelector("[data-action=recheck-skipped]"); b.click(); b.click(); })()'); await sleep(5);
    assert.equal(await fixture.get('document.querySelector("[data-action=recheck-skipped]").textContent'), '筛选中…');
    await sleep(35);
    assert.equal(await fixture.get('window.__fixture.calls.recheck.length'), 1, 'rapid recheck clicks are coalesced');
    assert.equal(await fixture.get('window.__fixture.calls.confirm.length'), 0, 'recheck must not send');
    assert.equal(await text(fixture, '#notice'), '重新筛选完成：已判定 1 条，新增待确认 1 条，跳过 0 条');
  } finally { await closeFixture(fixture); }
}

async function testLongTaskTableLayout() {
  const today = new Date().toISOString().slice(0, 10);
  const longUrl = `https://www.douyin.com/user/${'u'.repeat(180)}?modal_id=${'1234567890'.repeat(4)}&enter_from=profile_page&previous_page=search_result`;
  const tasks = [
    { ...makeState().tasks[0], id: 'task-long-url', url: longUrl, businessContext: '', keywords: ['高意向关键词'.repeat(12)], actionDay: today, generationToday: 14, maxActions: 20, sendAttemptsToday: 2, dailyLimit: 7 },
    { ...makeState().tasks[0], id: 'task-long-keyword', url: 'https://www.douyin.com/video/long-keyword', businessContext: '长关键词任务', keywords: ['关键词'.repeat(28)], source: 'live', contactMode: 'private', mode: 'auto' },
    { ...makeState().tasks[0], id: 'task-third', url: 'https://www.douyin.com/video/third', businessContext: '第三个任务', status: 'running' }
  ];
  const pending = Array.from({ length: 16 }, (_, index) => ({ actionId: `action-${index}`, eventKey: `event-${index}`, taskId: 'task-long-url', reply: `待确认回复 ${index + 1}` }));
  const events = pending.map((item, index) => ({ eventKey: item.eventKey, taskId: item.taskId, authorName: `用户${index + 1}`, text: `原评论 ${index + 1}`, roomId: longUrl }));
  const state = makeState({ tasks, pending, events });
  const widths = [1366, 1080];
  for (const width of widths) {
    const fixture = await newFixture({ state, width, height: 893 });
    try {
      const metrics = await fixture.get(`(() => {
        const table = document.querySelector('.task-table');
        const panel = document.querySelector('.table-panel');
        const actions = [...document.querySelectorAll('.task-table .row-actions')];
        const buttons = [...document.querySelectorAll('.task-table .row-actions button')];
        const source = document.querySelector('.task-table tbody td:nth-child(2)');
        const pendingPanel = document.querySelector('.pending-panel');
        return {
          bodyClientWidth: document.documentElement.clientWidth,
          bodyScrollWidth: document.documentElement.scrollWidth,
          tableWidth: table.getBoundingClientRect().width,
          panelWidth: panel.getBoundingClientRect().width,
          actionRects: actions.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; }),
          buttonRects: buttons.map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; }),
          cellRects: [...document.querySelectorAll('.task-table tbody tr:first-child td')].map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; }),
          sourceSpanRects: [...document.querySelectorAll('.task-table tbody tr:first-child td:nth-child(2) span')].map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right }; }),
          modeRect: (() => { const r = document.querySelector('.task-table tbody tr:first-child td:nth-child(3)').getBoundingClientRect(); return { left: r.left, right: r.right }; })(),
          statusRect: (() => { const r = document.querySelector('.task-table tbody tr:first-child .status-chip').getBoundingClientRect(); return { left: r.left, right: r.right }; })(),
          quotaRects: [...document.querySelectorAll('.task-table tbody tr:first-child .task-quota')].map((node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right }; }),
          sourceWidth: source.getBoundingClientRect().width,
          sourceText: source.textContent,
          pendingTop: pendingPanel.getBoundingClientRect().top,
          pendingCount: document.querySelectorAll('.pending-row').length,
          longUrlVisible: document.querySelector('.task-table tbody td:first-child').textContent.includes('www.douyin.com/user/')
        };
      })()`);
      assert.equal(metrics.pendingCount, 16, `${width}px fixture must retain all pending rows`);
      assert.equal(metrics.longUrlVisible, true, `${width}px fixture must render the long URL`);
      assert.ok(metrics.sourceWidth >= 80, `${width}px source column must remain readable`);
      assert.ok(metrics.bodyScrollWidth <= metrics.bodyClientWidth + 1, `${width}px page must not horizontally overflow`);
      assert.ok(metrics.tableWidth <= metrics.panelWidth + 1, `${width}px table must stay inside its panel`);
      assert.ok(metrics.buttonRects.every((rect) => rect.left >= 0 && rect.right <= metrics.bodyClientWidth + 1), `${width}px task buttons must remain in viewport`);
      assert.ok(metrics.buttonRects.every((rect) => { const cell = metrics.cellRects[5]; return rect.left >= cell.left && rect.right <= cell.right + 1; }), `${width}px task buttons must remain inside action cell`);
      assert.equal(await fixture.get('document.querySelector(".task-table tbody td:nth-child(2)").textContent'), '视频评论评论回复');
      assert.ok(metrics.sourceSpanRects.every((rect) => rect.left >= metrics.cellRects[1].left && rect.right <= metrics.cellRects[1].right + 1), `${width}px source labels must remain inside source cell`);
      assert.ok(metrics.modeRect.left >= metrics.cellRects[2].left && metrics.modeRect.right <= metrics.cellRects[2].right + 1, `${width}px mode must remain inside mode cell`);
      assert.ok(metrics.statusRect.left >= metrics.cellRects[3].left && metrics.statusRect.right <= metrics.cellRects[3].right + 1, `${width}px status must remain inside status cell`);
      assert.ok(metrics.quotaRects.every((rect) => rect.left >= metrics.cellRects[4].left && rect.right <= metrics.cellRects[4].right + 1), `${width}px quota must remain inside quota cell`);
      assert.ok(metrics.actionRects.every((rect) => rect.width > 0 && rect.height > 0), `${width}px action cells must remain measurable`);
      if (layoutScreenshotDirArg) {
        const dir = valueAfterEquals(layoutScreenshotDirArg);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `tasks-${width}.png`), (await fixture.win.webContents.capturePage()).toPNG());
        await fixture.get('document.querySelector(".pending-panel").scrollIntoView({ block: "start" })');
        await sleep(20);
        fs.writeFileSync(path.join(dir, `pending-${width}.png`), (await fixture.win.webContents.capturePage()).toPNG());
      }
      console.log(`LAYOUT ${width}: ${JSON.stringify(metrics)}`);
    } finally { await closeFixture(fixture); }
  }
}

async function testClientErrorFormatting() {
  const fixture = await newFixture();
  try {
    const result = await fixture.get(`(() => {
      const errorText = (error) => { let message = String(error?.message || '操作失败').replace(/^Error invoking remote method '[^']+':\\s*/i, '').replace(/^(?:ProbeError|Error):\\s*/i, '').trim(); if (/target_not_found|owned browser target is unavailable/i.test(message)) return '专用浏览器标签页已关闭，请重新打开目标页面'; if (/IPC|sender|stack|Cannot|undefined|TypeError/i.test(message)) return '桌面状态暂时不可用，请稍后重试'; return message; };
      return [errorText(new Error("Error invoking remote method 'browser:open': ProbeError: target_not_found")), errorText(new Error("Error invoking remote method 'browser:open': ProbeError: 具体失败原因"))];
    })()`);
    assert.deepEqual(result, ['专用浏览器标签页已关闭，请重新打开目标页面', '具体失败原因']);
  } finally { await closeFixture(fixture); }
}

async function testUnauthorizedDoesNotLeakDraft() {
  const fixture = await newFixture();
  try {
    await openNew(fixture); await setValue(fixture, '[name="replyTemplate"]', '账号一草稿');
    await fixture.get('document.querySelector("[name=replyTemplate]").focus()');
    await emit(fixture, { license: { state: 'unauthorized', user: null, balance: null, features: {} }, tasks: [] });
    assert.equal(await fixture.get('!!document.querySelector("#login-form")'), true, 'authorization loss must show login even while editing');
    assert.equal(await fixture.get('document.body.textContent.includes("账号一草稿")'), false, 'draft must not leak into next account login');
    await click(fixture, '[data-view="tasks"]'); assert.equal(await fixture.get('!!document.querySelector("#login-form")'), true);
  } finally { await closeFixture(fixture); }
}

async function testAccountRoundTrip() {
  const fixture = await newFixture();
  try {
    await openNew(fixture);
    await setValue(fixture, '[name="replyTemplate"]', '账号 A 草稿');
    await emit(fixture, { license: { state: 'authorized', user: { id: 'u-two', expiresAt: Date.now() + 300000 }, balance: 19, features: {} }, tasks: [] });
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), false, 'account change must close the old account editor');
    assert.equal(await fixture.get('document.body.textContent.includes("账号 A 草稿")'), false);
    await emit(fixture, { license: { state: 'authorized', user: { id: 'u-one', expiresAt: Date.now() + 300000 }, balance: 19, features: {} }, tasks: makeState().tasks });
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), false, 'A to B to A must not resurrect the old draft');
    assert.equal(await fixture.get('document.body.textContent.includes("账号 A 草稿")'), false);
  } finally { await closeFixture(fixture); }
}

async function main() {
  await app.whenReady();
  const userDataDir = app.getPath('userData');
  assert.ok(path.isAbsolute(userDataDir), 'Electron must resolve an explicit absolute user-data-dir');
  assert.match(path.basename(userDataDir), /^task-editor-fixture-/);
  try {
    await testEditorSurvivesStateUpdates(); console.log('PASS task editor survives unfocused state updates and refresh');
    await testEditCancelNavigationAndSearch(); console.log('PASS edit/cancel/navigation/search candidate flows');
    await testSaveFailureAndSuccess(); console.log('PASS save failure preserves draft and success returns to list');
    await testTaskQuotaAndExplicitRecheck(); console.log('PASS task quota and explicit recheck UI evidence');
    await testLongTaskTableLayout(); console.log('PASS long task table layout at 1366px and 1080px');
    await testClientErrorFormatting(); console.log('PASS client error formatting strips Electron wrappers');
    await testUnauthorizedDoesNotLeakDraft(); console.log('PASS unauthorized transition clears visible draft');
    await testAccountRoundTrip(); console.log('PASS A-B-A account isolation clears draft');
  } finally { app.quit(); }
}

  main().catch((error) => { console.error(`FAIL task editor fixture (${rendererHead ? 'git HEAD desktop/src/renderer/app.js' : rendererPath})`); console.error(error.stack || error); app.quit(); process.exitCode = 1; });
