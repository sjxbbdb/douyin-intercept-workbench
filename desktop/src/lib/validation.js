'use strict';

const ALLOWED_SOURCE = new Set(['video', 'live']);
const ALLOWED_CONTACT = new Set(['comment', 'private']);
const ALLOWED_MODE = new Set(['manual', 'auto']);
const ALLOWED_STATUS = new Set(['paused', 'running', 'stopped', 'needs_calibration', 'license_required', 'offline']);

function text(value, name, max = 2000) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const result = value.trim();
  if (!result || result.length > max) throw new TypeError(`${name} is empty or too long`);
  return result;
}

function optionalText(value, name, max = 2000) {
  if (value == null || value === '') return '';
  return text(value, name, max);
}

function stringList(value, name, maxItems = 50) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new TypeError(`${name} must be a short list`);
  return value.map((item, index) => text(item, `${name}[${index}]`, 120));
}

function targetUrl(value) {
  const url = new URL(text(value, 'url', 2048));
  const allowedHosts = new Set(['douyin.com', 'www.douyin.com', 'live.douyin.com', 'v.douyin.com']);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts.has(url.hostname)) {
    throw new TypeError('url must be an https douyin.com URL on a supported host');
  }
  if (url.hostname === 'douyin.com') url.hostname = 'www.douyin.com';
  return url.href;
}

function taskInput(input) {
  if (!input || typeof input !== 'object') throw new TypeError('task must be an object');
  const result = {
    id: optionalText(input.id, 'id', 80),
    url: targetUrl(input.url),
    source: ALLOWED_SOURCE.has(input.source) ? input.source : 'video',
    contactMode: ALLOWED_CONTACT.has(input.contactMode) ? input.contactMode : 'comment',
    businessContext: optionalText(input.businessContext, 'businessContext', 1000),
    targetCustomer: optionalText(input.targetCustomer, 'targetCustomer', 1000),
    keywords: stringList(input.keywords, 'keywords'),
    excludeKeywords: stringList(input.excludeKeywords, 'excludeKeywords'),
    replyTemplate: text(input.replyTemplate || '', 'replyTemplate', 1000),
    replyInstructions: optionalText(input.replyInstructions, 'replyInstructions', 2000),
    mode: ALLOWED_MODE.has(input.mode) ? input.mode : 'manual',
    intervalMs: Number.isInteger(input.intervalMs) && input.intervalMs >= 0 ? input.intervalMs : 0,
    dailyLimit: Number.isInteger(input.dailyLimit) && input.dailyLimit >= 0 ? input.dailyLimit : 0,
    maxActions: Number.isInteger(input.maxActions) && input.maxActions >= 0 ? input.maxActions : 0,
    status: ALLOWED_STATUS.has(input.status) ? input.status : 'paused',
    selectorProfileId: optionalText(input.selectorProfileId, 'selectorProfileId', 100) || 'default-unverified'
  };
  if (result.mode === 'auto' && (!result.intervalMs || !result.dailyLimit || !result.maxActions)) {
    throw new TypeError('auto tasks require positive local interval and action limits');
  }
  return result;
}

function selectorProfile(input) {
  if (!input || typeof input !== 'object') throw new TypeError('selector profile must be an object');
  const result = {};
  for (const key of ['commentNode', 'commentId', 'commentText', 'commentAuthor', 'replyInput', 'sendButton', 'replyButton']) {
    const value = input[key] == null ? '' : optionalText(input[key], key, 500);
    result[key] = value;
  }
  return result;
}

function safeIdempotencyKey(value) {
  const result = text(value, 'idempotencyKey', 120);
  if (!/^[a-zA-Z0-9._:-]+$/.test(result)) throw new TypeError('invalid idempotencyKey');
  return result;
}

module.exports = { ALLOWED_SOURCE, ALLOWED_CONTACT, ALLOWED_MODE, ALLOWED_STATUS, targetUrl, taskInput, selectorProfile, safeIdempotencyKey, text };
