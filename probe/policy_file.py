# -*- coding: utf-8 -*-
"""授权端下发的【签名】策略（2026-09-28 第二版）。

评审意见（2026-09-28）：
  「#51 改为授权端签名/JWS 或认证 HTTP 策略，下发内容必须绑定租户、账号、设备和 policyRef；
    未完成前继续只允许 sent_confirmed。」

本模块只做【本侧能独立完成】的那一半，另一半（授权端签名 / 认证 HTTP 下发）不在这里假装：

  · 只接受 JWS 信封（protected / payload / signature，alg=HS256）。上一版那种
    "普通 JSON 自带 policySha256" 一律拒绝（policy_signature_required）——
    自算哈希只能证明文件没被改坏，证明不了是谁签的；
  · 签名必须绑定本机的四个身份：tenantId（租户）、accountScope（账号）、
    deviceId（设备）、policyRef（策略引用）。任何一项对不上都 fail-closed；
  · 🔴 在授权端的签名/认证下发真正落地之前，放行状态**只允许 sent_confirmed**：
    payload 里想放开 sent_echoed 一律 policy_state_not_allowed_yet；
  · 本侧【不签名】。签名是授权端的职责（测试与授权端共用同一套 JWS 规则）。
"""
import base64
import hashlib
import hmac
import json
import os
import time
import uuid

POLICY_FIELDS = ("policyId", "policyVersion", "knowledgeSetVersion", "allowPublicStates",
                 "maxPrivate", "minTextLength", "maxTextLength", "issuedAt", "expiresAt",
                 "tenantId", "accountScope", "deviceId", "policyRef")
REQUIRED_FIELDS = ("policyId", "policyVersion", "allowPublicStates",
                   "tenantId", "accountScope", "deviceId", "policyRef")
# 🔴 未完成前只允许这一个状态（评审 2026-09-28）。
ALLOWED_STATES_FOR_NOW = ("sent_confirmed",)


class PolicyFileError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


def _canonical(payload):
    body = {key: payload[key] for key in sorted(payload)
            if key in POLICY_FIELDS and key != "policySha256"}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(payload):
    """规范化 JSON 的 sha256（十六进制小写）—— 只用于台账留痕，不当作签名。"""
    return hashlib.sha256(_canonical(payload)).hexdigest()


def _b64e(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(value):
    text = str(value or "")
    pad = "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(text + pad)
    except Exception:
        raise PolicyFileError("policy_file_invalid", "policy envelope is not base64url")


def sign(payload, secret, kid, alg="HS256"):
    """测试 / 授权端用的签名工具（本侧生产流程不调用它）。

    与 verify 共用同一套规则：protected.payload 的 HMAC-SHA256，base64url 无填充。
    """
    header = {"alg": alg, "kid": str(kid), "typ": "JWT"}
    protected = _b64e(json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    body = _b64e(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                            separators=(",", ":")).encode("utf-8"))
    key = secret.encode("utf-8") if isinstance(secret, str) else bytes(secret)
    signature = hmac.new(key, ("%s.%s" % (protected, body)).encode("ascii"), hashlib.sha256).digest()
    return {"protected": protected, "payload": body, "signature": _b64e(signature)}


def load_keys(path):
    """读授权端预置的验签密钥：{"kid": ..., "secretBase64": ...} 或 {"keys": {kid: b64}}。"""
    if not path:
        raise PolicyFileError("policy_key_missing", "no policy verification key configured")
    path = os.path.abspath(os.fspath(path))
    if not os.path.isfile(path):
        raise PolicyFileError("policy_key_missing", "policy verification key is not readable")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except Exception:
        raise PolicyFileError("policy_key_invalid", "policy verification key is not valid JSON")
    keys = {}
    if isinstance(raw, dict) and isinstance(raw.get("keys"), dict):
        for kid, secret in raw["keys"].items():
            keys[str(kid)] = _decode_secret(secret)
    elif isinstance(raw, dict) and raw.get("kid"):
        keys[str(raw["kid"])] = _decode_secret(raw.get("secretBase64") or raw.get("secret"))
    if not keys:
        raise PolicyFileError("policy_key_invalid", "policy verification key file has no usable key")
    return keys


def _decode_secret(value):
    if not value:
        raise PolicyFileError("policy_key_invalid", "policy key secret is empty")
    try:
        return base64.b64decode(str(value))
    except Exception:
        raise PolicyFileError("policy_key_invalid", "policy key secret is not base64")


def device_id(state_dir):
    """本机设备标识：首次使用时生成并落在 state-dir 里（授权端下发的策略要绑定它）。"""
    path = os.path.join(os.path.abspath(os.fspath(state_dir)), "device.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            current = json.load(handle).get("deviceId")
        if current:
            return str(current)
    except Exception:
        pass
    value = uuid.uuid4().hex
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"deviceId": value}, handle, ensure_ascii=False, indent=1)
    except Exception:
        pass
    return value


def verify(envelope, keys, account_scope=None, device=None, now=None, tenant=None):
    """校验签名与四个绑定；返回 {content, identity, sha256, keyId, tenantId, policyRef, deviceId}。"""
    if not isinstance(envelope, dict) or not {"protected", "payload", "signature"} <= set(envelope):
        # 上一版那种"自带哈希的普通 JSON"：自算哈希不是签名，一律拒绝。
        raise PolicyFileError("policy_signature_required",
                              "policy must be a signed JWS envelope (protected/payload/signature)")
    try:
        header = json.loads(_b64d(envelope["protected"]).decode("utf-8"))
    except PolicyFileError:
        raise
    except Exception:
        raise PolicyFileError("policy_file_invalid", "policy protected header is not JSON")
    if not isinstance(header, dict):
        raise PolicyFileError("policy_file_invalid", "policy protected header must be an object")
    alg = str(header.get("alg") or "")
    if alg != "HS256":
        raise PolicyFileError("policy_alg_unsupported", "unsupported policy signature algorithm: %s" % (alg or "?"))
    key_id = str(header.get("kid") or "")
    secret = (keys or {}).get(key_id)
    if not secret:
        raise PolicyFileError("policy_key_unknown", "policy was signed with an unknown key id")
    expected = hmac.new(bytes(secret),
                        ("%s.%s" % (envelope["protected"], envelope["payload"])).encode("ascii"),
                        hashlib.sha256).digest()
    if not hmac.compare_digest(expected, _b64d(envelope["signature"])):
        raise PolicyFileError("policy_signature_invalid", "policy signature does not verify")
    try:
        payload = json.loads(_b64d(envelope["payload"]).decode("utf-8"))
    except PolicyFileError:
        raise
    except Exception:
        raise PolicyFileError("policy_file_invalid", "policy payload is not JSON")
    if not isinstance(payload, dict):
        raise PolicyFileError("policy_file_invalid", "policy payload must be an object")
    missing = [key for key in REQUIRED_FIELDS if not str(payload.get(key) or "").strip()]
    if missing:
        raise PolicyFileError("policy_file_invalid",
                              "policy payload is missing: %s" % ",".join(sorted(missing)))
    states = payload.get("allowPublicStates")
    if not isinstance(states, list) or not states:
        raise PolicyFileError("policy_file_invalid", "allowPublicStates must be a non-empty list")
    extra = [str(item) for item in states if str(item) not in ALLOWED_STATES_FOR_NOW]
    if extra:
        # 🔴 授权端签名/认证下发做完之前，只有 sent_confirmed 允许放行。
        raise PolicyFileError("policy_state_not_allowed_yet",
                              "allowPublicStates may only contain sent_confirmed for now: %s"
                              % ",".join(sorted(extra)))
    for label, wanted, got in (("accountScope", account_scope, payload.get("accountScope")),
                               ("deviceId", device, payload.get("deviceId")),
                               ("tenantId", tenant, payload.get("tenantId"))):
        if wanted is None:
            continue
        if str(wanted) != str(got):
            raise PolicyFileError("policy_binding_mismatch",
                                  "policy %s does not match this account/device/tenant" % label)
    stamp = time.time() if now is None else float(now)
    expires = payload.get("expiresAt")
    if expires is not None:
        try:
            expires = float(expires)
        except (TypeError, ValueError):
            raise PolicyFileError("policy_file_invalid", "expiresAt must be epoch seconds")
        if stamp > expires:
            raise PolicyFileError("policy_expired", "policy has expired")
    content = {key: payload[key] for key in POLICY_FIELDS if key in payload and key != "policySha256"}
    identity = {"policyId": str(payload["policyId"]),
                "policyVersion": int(payload["policyVersion"]),
                "knowledgeSetVersion": (int(payload["knowledgeSetVersion"])
                                        if payload.get("knowledgeSetVersion") is not None else None)}
    return {"content": content, "identity": identity, "sha256": digest(payload),
            "keyId": key_id, "tenantId": str(payload["tenantId"]),
            "policyRef": str(payload["policyRef"]), "deviceId": str(payload["deviceId"])}


def load(path, keys=None, account_scope=None, device=None, now=None, tenant=None):
    """读取并校验【签名】策略文件；返回 verify() 的结果，任何一步不过都抛 PolicyFileError。"""
    if not path:
        return None
    path = os.path.abspath(os.fspath(path))
    if not os.path.isfile(path):
        raise PolicyFileError("policy_file_missing", "policy file is not readable")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            envelope = json.load(handle)
    except Exception:
        raise PolicyFileError("policy_file_invalid", "policy file is not valid JSON")
    result = verify(envelope, keys, account_scope=account_scope, device=device, now=now, tenant=tenant)
    result["path"] = path
    return result
