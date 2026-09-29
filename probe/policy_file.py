# -*- coding: utf-8 -*-
"""授权端下发的【非对称签名】策略（2026-09-28 第三版）。

评审意见（2026-09-28，第二轮）：
  「虽然已改成 JWS/HS256、账号/设备字段绑定，并限制只允许 sent_confirmed，但验签密钥是
    客户端本地文件里的共享 HMAC secret，客户端可自行签发伪造策略。应改成授权端私钥 +
    客户端公钥验签（如 Ed25519）。另外租户没有绑定到当前授权会话，policyRef 没有自动写入
    冻结计划，策略缓存不会感知过期/轮换，且策略放行前仍缺少服务端台账存在性校验。」

本模块负责【验签与绑定】这一层，按上面的意见重做：

  · 只接受 **RS256**（RSA PKCS#1 v1.5 + SHA-256）的 JWS 信封：客户端只有【公钥】，
    私钥留在授权端 —— 共享密钥（HS256/384/512）一律拒绝（policy_alg_unsupported），
    因为那等于客户端能自己签一份策略；
  · 签名必须绑定五个身份：tenantId（租户）、accountScope（账号）、deviceId（设备）、
    policyRef（策略引用）、authorizationSession（当前授权会话，由宿主透传）；
  · 🔴 授权端把签名与认证下发全部做完之前，allowPublicStates 只允许 sent_confirmed；
  · 本侧只验签，不签名：sign() 只是授权端与测试共用同一套 RS256 规则的工具。

仍然【没有】在这里做成的事（不假装）：授权端的密钥分发、认证 HTTP 下发通道、
服务端台账存在性校验的接线 —— 后者在 sidecar 里以**必须由宿主注册**的 seam 形式出现，
没接线就不放行任何策略。
"""
import base64
import hashlib
import json
import os
import time
import uuid

POLICY_FIELDS = ("policyId", "policyVersion", "knowledgeSetVersion", "allowPublicStates",
                 "maxPrivate", "minTextLength", "maxTextLength", "issuedAt", "expiresAt",
                 "tenantId", "accountScope", "deviceId", "policyRef", "authorizationSession")
REQUIRED_FIELDS = ("policyId", "policyVersion", "allowPublicStates", "tenantId",
                   "accountScope", "deviceId", "policyRef", "authorizationSession")
# 🔴 未完成前只允许这一个状态（评审 2026-09-28）。
ALLOWED_STATES_FOR_NOW = ("sent_confirmed",)
# 支持的签名算法：只有非对称。共享密钥算法在这里是【安全缺陷】，不是"可选项"。
SUPPORTED_ALGS = ("RS256",)
SHARED_SECRET_ALGS = ("HS256", "HS384", "HS512")
SHA256_DIGEST_INFO = bytes.fromhex("3031300d060960864801650304020105000420")


class PolicyFileError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = str(code)
        self.message = str(message)


def _b64e(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(value):
    text = str(value or "")
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except Exception:
        raise PolicyFileError("policy_file_invalid", "policy envelope is not base64url")


def _int_from_b64(value):
    raw = _b64d(value)
    if not raw:
        raise PolicyFileError("policy_key_invalid", "empty key component")
    return int.from_bytes(raw, "big")


def _canonical(payload):
    body = {key: payload[key] for key in sorted(payload) if key in POLICY_FIELDS}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest(payload):
    """规范化 JSON 的 sha256 —— 只用于台账留痕，不当作签名。"""
    return hashlib.sha256(_canonical(payload)).hexdigest()


def _digest_info(message):
    return SHA256_DIGEST_INFO + hashlib.sha256(message).digest()


def sign(payload, private, kid, alg="RS256"):
    """授权端 / 测试用的签名工具（本侧生产流程不调用）。

    private: {"n": b64u, "e": b64u, "d": b64u} —— 私钥只存在于授权端与测试夹具。
    """
    if alg not in SUPPORTED_ALGS:
        raise PolicyFileError("policy_alg_unsupported", "unsupported signing algorithm: %s" % alg)
    header = {"alg": alg, "kid": str(kid), "typ": "JWT"}
    protected = _b64e(json.dumps(header, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    body = _b64e(json.dumps(payload, ensure_ascii=False, sort_keys=True,
                            separators=(",", ":")).encode("utf-8"))
    n = _int_from_b64(private["n"])
    d = _int_from_b64(private["d"])
    digest_info = _digest_info(("%s.%s" % (protected, body)).encode("ascii"))
    size = (n.bit_length() + 7) // 8
    padded = b"\x00\x01" + b"\xff" * (size - len(digest_info) - 3) + b"\x00" + digest_info
    signature = pow(int.from_bytes(padded, "big"), d, n)
    return {"protected": protected, "payload": body,
            "signature": _b64e(signature.to_bytes(size, "big"))}


def load_keys(path):
    """读授权端预置的【公钥】文件：{"keys": {kid: {"kty":"RSA","n":...,"e":...}}} 或单键形式。"""
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
        for kid, entry in raw["keys"].items():
            keys[str(kid)] = _normalise_jwk(entry)
    elif isinstance(raw, dict) and raw.get("kid"):
        keys[str(raw["kid"])] = _normalise_jwk(raw)
    if not keys:
        raise PolicyFileError("policy_key_invalid", "policy verification key file has no usable key")
    return keys


def _normalise_jwk(entry):
    if not isinstance(entry, dict):
        raise PolicyFileError("policy_key_invalid", "policy key entry must be an object")
    if str(entry.get("kty") or "").upper() != "RSA":
        # 共享密钥（oct）在这里是安全缺陷：客户端能拿它自己签一份策略。
        raise PolicyFileError("policy_key_invalid",
                              "policy verification key must be an RSA public key (kty=RSA)")
    n, e = entry.get("n"), entry.get("e")
    if not n or not e:
        raise PolicyFileError("policy_key_invalid", "policy key is missing n/e")
    return {"kty": "RSA", "n": str(n), "e": str(e)}


def device_id(state_dir):
    """本机设备标识：首次使用时生成并落在 state-dir 里（策略要绑定它）。"""
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


def verify(envelope, keys, account_scope=None, device=None, tenant=None,
           auth_session=None, now=None):
    """校验非对称签名与五个绑定；返回 {content, identity, sha256, keyId, ...}。"""
    if not isinstance(envelope, dict) or not {"protected", "payload", "signature"} <= set(envelope):
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
    if alg in SHARED_SECRET_ALGS:
        raise PolicyFileError("policy_alg_unsupported",
                              "shared-secret signatures are not accepted: the client holds the "
                              "same secret and could forge a policy")
    if alg not in SUPPORTED_ALGS:
        raise PolicyFileError("policy_alg_unsupported",
                              "unsupported policy signature algorithm: %s" % (alg or "?"))
    key_id = str(header.get("kid") or "")
    jwk = (keys or {}).get(key_id)
    if not jwk:
        raise PolicyFileError("policy_key_unknown", "policy was signed with an unknown key id")
    n, exponent = _int_from_b64(jwk["n"]), _int_from_b64(jwk["e"])
    signature = _b64d(envelope["signature"])
    size = (n.bit_length() + 7) // 8
    if len(signature) != size:
        raise PolicyFileError("policy_signature_invalid", "policy signature length is wrong")
    decoded = pow(int.from_bytes(signature, "big"), exponent, n).to_bytes(size, "big")
    tail = _digest_info(("%s.%s" % (envelope["protected"], envelope["payload"])).encode("ascii"))
    middle = decoded[2:len(decoded) - len(tail) - 1]
    if not (decoded.startswith(b"\x00\x01") and decoded.endswith(tail)
            and middle and set(middle) == {0xFF}
            and decoded[len(decoded) - len(tail) - 1] == 0):
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
        raise PolicyFileError("policy_state_not_allowed_yet",
                              "allowPublicStates may only contain sent_confirmed for now: %s"
                              % ",".join(sorted(extra)))
    for label, wanted, got in (("accountScope", account_scope, payload.get("accountScope")),
                               ("deviceId", device, payload.get("deviceId")),
                               ("tenantId", tenant, payload.get("tenantId")),
                               ("authorizationSession", auth_session,
                                payload.get("authorizationSession"))):
        if wanted is None:
            raise PolicyFileError("policy_binding_missing",
                                  "this run has no %s to bind the policy to" % label)
        if str(wanted) != str(got):
            raise PolicyFileError("policy_binding_mismatch",
                                  "policy %s does not match this account/device/tenant/session" % label)
    stamp = time.time() if now is None else float(now)
    expires = payload.get("expiresAt")
    if expires is not None:
        try:
            expires = float(expires)
        except (TypeError, ValueError):
            raise PolicyFileError("policy_file_invalid", "expiresAt must be epoch seconds")
        if stamp > expires:
            raise PolicyFileError("policy_expired", "policy has expired")
    content = {key: payload[key] for key in POLICY_FIELDS if key in payload}
    identity = {"policyId": str(payload["policyId"]),
                "policyVersion": int(payload["policyVersion"]),
                "knowledgeSetVersion": (int(payload["knowledgeSetVersion"])
                                        if payload.get("knowledgeSetVersion") is not None else None)}
    return {"content": content, "identity": identity, "sha256": digest(payload), "keyId": key_id,
            "tenantId": str(payload["tenantId"]), "policyRef": str(payload["policyRef"]),
            "deviceId": str(payload["deviceId"]),
            "authorizationSession": str(payload["authorizationSession"]),
            "expiresAt": payload.get("expiresAt")}


def load(path, keys=None, account_scope=None, device=None, tenant=None,
         auth_session=None, now=None):
    """读取并校验【非对称签名】策略文件；任何一步不过都抛 PolicyFileError。"""
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
    result = verify(envelope, keys, account_scope=account_scope, device=device, tenant=tenant,
                    auth_session=auth_session, now=now)
    result["path"] = path
    return result
