'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function required(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function optional(value, fallback) { return typeof value === 'string' && value.trim() ? value.trim() : fallback; }

function platformScope({ workbenchUserId = 'guest', platformAccountId = null } = {}) {
  const userId = optional(workbenchUserId, 'guest');
  const accountId = optional(platformAccountId, 'unselected');
  return { workbenchUserId: userId, platformAccountId: accountId, runtimeAccountId: `${userId}:${accountId}` };
}

function scopeDigest(endpoint, workbenchUserId, platformAccountId) {
  const scope = platformScope({ workbenchUserId, platformAccountId });
  return crypto.createHash('sha256').update(`${String(endpoint || '')}:${scope.workbenchUserId}:${scope.platformAccountId}`).digest('hex');
}

function accountDataPath(userDataPath, endpoint, workbenchUserId, platformAccountId) {
  const digest = scopeDigest(endpoint, workbenchUserId, platformAccountId).slice(0, 32);
  return path.join(userDataPath, 'accounts', digest, 'agent-data.json');
}

function accountDir(userDataPath, endpoint, workbenchUserId, platformAccountId) {
  return path.dirname(accountDataPath(userDataPath, endpoint, workbenchUserId, platformAccountId));
}

function browserPartition(endpoint, workbenchUserId, platformAccountId) {
  return `persist:douyin-${scopeDigest(endpoint, workbenchUserId, platformAccountId).slice(0, 32)}`;
}

function sidecarPort(endpoint, workbenchUserId, platformAccountId) {
  const digest = Buffer.from(scopeDigest(endpoint, workbenchUserId, platformAccountId), 'hex');
  return 38000 + (digest.readUInt16BE(0) % 1200);
}

function platformAccountId(value) { return required(value, 'platformAccountId', 160); }

module.exports = { platformScope, platformAccountId, accountDataPath, accountDir, browserPartition, sidecarPort };
