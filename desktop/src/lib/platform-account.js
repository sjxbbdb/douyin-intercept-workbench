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

const SIDECAR_PORT_START = 38000;
const SIDECAR_PORT_SPAN = 1200;

function baseSidecarPort(endpoint, workbenchUserId, platformAccountId) {
  const digest = Buffer.from(scopeDigest(endpoint, workbenchUserId, platformAccountId), 'hex');
  return SIDECAR_PORT_START + (digest.readUInt16BE(0) % SIDECAR_PORT_SPAN);
}

/**
 * Allocate a stable collision-free set for all known accounts in one user
 * scope. Sorting before linear probing means the same inputs always produce
 * the same ports, regardless of the order returned by the API.
 */
function allocateSidecarPorts(endpoint, workbenchUserId, platformAccountIds = []) {
  if (!Array.isArray(platformAccountIds)) throw new TypeError('platformAccountIds must be an array');
  const ids = [...new Set(platformAccountIds.map((value) => required(value, 'platformAccountId', 160)))].sort();
  const assigned = new Map();
  const occupied = new Set();
  for (const accountId of ids) {
    const initial = baseSidecarPort(endpoint, workbenchUserId, accountId);
    let port = initial;
    do {
      if (!occupied.has(port)) break;
      port = SIDECAR_PORT_START + ((port - SIDECAR_PORT_START + 1) % SIDECAR_PORT_SPAN);
    } while (port !== initial);
    if (occupied.has(port)) throw new Error('sidecar port range exhausted for workbench user');
    occupied.add(port);
    assigned.set(accountId, port);
  }
  return assigned;
}

function sidecarPort(endpoint, workbenchUserId, platformAccountId, platformAccountIds = null) {
  const accountId = platformAccountId == null || platformAccountId === ''
    ? 'unselected'
    : required(platformAccountId, 'platformAccountId', 160);
  if (platformAccountIds == null) return baseSidecarPort(endpoint, workbenchUserId, accountId);
  if (!Array.isArray(platformAccountIds)) throw new TypeError('platformAccountIds must be an array');
  const allocated = allocateSidecarPorts(endpoint, workbenchUserId, platformAccountIds.includes(accountId) ? platformAccountIds : [...platformAccountIds, accountId]);
  return allocated.get(accountId);
}

function platformAccountId(value) { return required(value, 'platformAccountId', 160); }

module.exports = { platformScope, platformAccountId, accountDataPath, accountDir, browserPartition, sidecarPort, allocateSidecarPorts };
