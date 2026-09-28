# -*- coding: utf-8 -*-
"""授权端下发的策略文件（2026-09-28）。

背景与本侧边界：
  · 策略内容（放行哪些公开状态、私信上限、话术长度）**由授权服务端签发**，
    本侧不签发、不伪造、也不接受调用方在 params 里自带的策略；
  · 但实测确认：直播公屏走 WebSocket，**没有平台回执**（连续抓包只看到埋点请求，
    没有带本次正文的 HTTP 请求）—— 台账状态只能是 unknown，队列状态最多到 sent_echoed。
    于是"只有 sent_confirmed 才允许私信"这条默认口径会让直播私信永远走不到。
    要打通它，只能由平台侧显式下发一条允许 sent_echoed 的策略。

本模块只做三件事：读文件、校验形状与完整性、给出可审计的身份。它不联网、不签名。

完整性（防"随手改一个 JSON 就能放开红线"）：
  · 文件必须带 policySha256：对【除该字段外的规范化 JSON】算 sha256；
  · 不一致 -> policy_integrity_failed；
  · 带 expiresAt 且已过期 -> policy_expired；
  · 身份字段与调用方给的 policyId/policyVersion 不一致 -> policy_ref_mismatch。
"""
import hashlib
import json
import os
import time

POLICY_FIELDS = ("policyId", "policyVersion", "knowledgeSetVersion", "allowPublicStates",
                 "maxPrivate", "minTextLength", "maxTextLength", "issuedAt", "expiresAt")
REQUIRED_FIELDS = ("policyId", "policyVersion", "allowPublicStates", "policySha256")


class PolicyFileError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


def _canonical(payload):
    body = {key: payload[key] for key in sorted(payload) if key in POLICY_FIELDS}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(payload):
    """规范化 JSON 的 sha256（十六进制，小写）。"""
    return hashlib.sha256(_canonical(payload)).hexdigest()


def load(path, now=None):
    """读取并校验策略文件；返回 {content, identity, sha256} 或抛 PolicyFileError。

    任何一步不通过都 fail-closed —— 调用方要么用内置保守默认值，要么把错误报给宿主，
    绝不"半信半疑地"用一半策略。
    """
    if not path:
        return None
    path = os.path.abspath(os.fspath(path))
    if not os.path.isfile(path):
        raise PolicyFileError("policy_file_missing", "policy file is not readable")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except Exception:
        raise PolicyFileError("policy_file_invalid", "policy file is not valid JSON")
    if not isinstance(payload, dict):
        raise PolicyFileError("policy_file_invalid", "policy file must be an object")
    missing = [key for key in REQUIRED_FIELDS if key not in payload]
    if missing:
        raise PolicyFileError("policy_file_invalid",
                              "policy file is missing: %s" % ",".join(sorted(missing)))
    states = payload.get("allowPublicStates")
    if not isinstance(states, list) or not states:
        raise PolicyFileError("policy_file_invalid", "allowPublicStates must be a non-empty list")
    expected = str(payload.get("policySha256") or "").strip().lower()
    actual = digest(payload)
    if expected != actual:
        raise PolicyFileError("policy_integrity_failed",
                              "policy hash does not match its content")
    stamp = time.time() if now is None else float(now)
    expires = payload.get("expiresAt")
    if expires is not None:
        try:
            expires = float(expires)
        except (TypeError, ValueError):
            raise PolicyFileError("policy_file_invalid", "expiresAt must be epoch seconds")
        if stamp > expires:
            raise PolicyFileError("policy_expired", "policy file has expired")
    content = {key: payload[key] for key in POLICY_FIELDS if key in payload and key != "policySha256"}
    identity = {"policyId": str(payload["policyId"]),
                "policyVersion": int(payload["policyVersion"]),
                "knowledgeSetVersion": (int(payload["knowledgeSetVersion"])
                                        if payload.get("knowledgeSetVersion") is not None else None)}
    return {"content": content, "identity": identity, "sha256": actual, "path": path}
