'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');

const errorLog = process.env.DOUYIN_AGENT_ERROR_LOG;
app.on('browser-window-created', (_event, window) => window.hide());
dialog.showErrorBox = (title, content) => {
  const safe = String(content || '').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]').replace(/password|token|secret|key/gi, '[REDACTED_FIELD]');
  if (errorLog) fs.appendFileSync(errorLog, `${JSON.stringify({ title, content: safe })}\n`, { encoding: 'utf8', mode: 0o600 });
};
require('../desktop/src/main.js');
