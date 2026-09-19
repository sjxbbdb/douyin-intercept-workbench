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
    tasks: [{ id: 'task-existing', url: 'https://www.douyin.com/video/existing', source: 'video', contactMode: 'comment', decisionMode: 'rule', businessContext: '旧业务', targetCustomer: '旧客户', keywords: ['旧词'], excludeKeywords: ['旧排除'], replyTemplate: '旧模板', replyInstructions: '旧要求', mode: 'manual', intervalMs: 1111, dailyLimit: 7, maxActions: 8, status: 'paused' }],
    leads: [], events: [], logs: [], pending: [], selectorProfile: {}, browser: { connected: false, collector: 'closed', matchCount: 0 },
    ...overrides
  };
}

async function newFixture({ state = makeState(), searchVideos = [] } = {}) {
  // Functions cannot survive a data URL. The page receives a small callable
  // mock through a generated prelude instead.
  const mockPrelude = `
    let __state = ${jsonScript(state)};
    const __calls = { save: [], login: [], refresh: 0, search: [] };
    const __listeners = [];
    window.agentApi = {
      getState: async () => structuredClone(__state),
      login: async (value) => { __calls.login.push(value); return __state.license; },
      logout: async () => ({ state: 'unauthorized' }),
      refreshLicense: async () => { __calls.refresh += 1; return structuredClone(__state.license); },
      getEndpoint: async () => ({ apiEndpoint: 'http://127.0.0.1:18080' }), setEndpoint: async () => ({}), getLedger: async () => [],
      saveTask: async (value) => { __calls.save.push(value); return value; }, setTaskStatus: async () => ({}), deleteTask: async () => ({}), confirmAction: async () => ({}), retryDraft: async () => ({}), redeem: async () => ({}), openTarget: async () => ({}),
      searchTargets: async (value) => { __calls.search.push(value); return { videos: ${jsonScript(searchVideos)} }; }, closeTarget: async () => ({}), probeSelectors: async () => ({}), saveSelectors: async () => ({}),
      onState: (callback) => { __listeners.push(callback); return () => {}; }
    };
    window.__fixture = { get state() { return structuredClone(__state); }, calls: __calls, push(next) { __state = structuredClone(Object.assign({}, __state, structuredClone(next))); __listeners.forEach((listener) => listener(structuredClone(__state))); }, listeners: __listeners };
  `;
  // The production page CSP intentionally blocks inline scripts; this test
  // replaces that policy in its own data URL so the injected fixture remains
  // controlled and cannot alter production CSP.
  const html = indexSource.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/i, '').replace(/<link[^>]+styles\.css[^>]*>/i, `<style>${styleSource}</style>`).replace('<script src="./app.js"></script>', `<script>${mockPrelude}</script><script>${rendererSource}</script>`);
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: true } });
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
    await openNew(fixture); await setValue(fixture, '[name="url"]', 'https://www.douyin.com/video/save'); await setValue(fixture, '[name="replyTemplate"]', '保留内容');
    await fixture.get('void (window.agentApi.saveTask = async () => { throw new Error("网络失败") })');
    await fixture.get('document.querySelector("#task-form").requestSubmit()'); await sleep(35);
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), true); assert.equal(await text(fixture, '[name="replyTemplate"]'), '保留内容');
    await fixture.get('void (window.agentApi.saveTask = async (task) => { window.__fixture.calls.save.push(task); return task })');
    await fixture.get('document.querySelector("#task-form").requestSubmit()'); await sleep(35);
    await emit(fixture, { tasks: [makeState().tasks[0], { id: 'task-new', url: 'https://www.douyin.com/video/save' }] });
    assert.equal(await fixture.get('!!document.querySelector("#task-form")'), false, 'confirmed successful save may return to list');
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
    await testUnauthorizedDoesNotLeakDraft(); console.log('PASS unauthorized transition clears visible draft');
    await testAccountRoundTrip(); console.log('PASS A-B-A account isolation clears draft');
  } finally { app.quit(); }
}

  main().catch((error) => { console.error(`FAIL task editor fixture (${rendererHead ? 'git HEAD desktop/src/renderer/app.js' : rendererPath})`); console.error(error.stack || error); app.quit(); process.exitCode = 1; });
