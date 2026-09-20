'use strict';

const { selectorProfile } = require('./validation');

const DEFAULT_SELECTOR_PROFILE = Object.freeze({
  id: 'default-unverified',
  verified: false,
  verifiedAt: null,
  source: '未校准。请在真实页面中用设置页探测可见节点后保存。',
  commentNode: '',
  commentId: '',
  commentText: '',
  commentAuthor: '',
  replyInput: '',
  sendButton: '',
  replyButton: ''
});

function normalizeProfile(input) {
  const values = selectorProfile(input);
  return {
    ...DEFAULT_SELECTOR_PROFILE,
    ...values,
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim().slice(0, 100) : DEFAULT_SELECTOR_PROFILE.id,
    verified: input.verified === true,
    verifiedAt: input.verifiedAt || null,
    source: typeof input.source === 'string' ? input.source.slice(0, 500) : DEFAULT_SELECTOR_PROFILE.source
  };
}

function canAutoSend(profile, source = 'video') {
  return Boolean(profile && profile.verified && profile.replyInput && profile.sendButton && (source === 'live' || profile.replyButton));
}

module.exports = { DEFAULT_SELECTOR_PROFILE, normalizeProfile, canAutoSend };
