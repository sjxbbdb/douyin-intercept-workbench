# -*- coding: utf-8 -*-
"""授权端下发的【签名】策略：验签 + 四个绑定 + 只允许 sent_confirmed（2026-09-28 第二版）。

评审意见（2026-09-28）：
  「#51 改为授权端签名/JWS 或认证 HTTP 策略，下发内容必须绑定租户、账号、设备和 policyRef；
    未完成前继续只允许 sent_confirmed。」

本文件钉住这些事：
  1) 只接受 JWS 信封（HS256）；上一版"普通 JSON 自带哈希"一律拒绝 —— 自算哈希证明不了是谁签的；
  2) 签名必须绑定本机租户 tenantId / 账号 accountScope / 设备 deviceId / 策略引用 policyRef，
     任何一项对不上都 fail-closed；
  3) 授权端的签名/认证下发落地之前，放行状态【只允许 sent_confirmed】；
  4) 策略没通过校验时，sidecar 不执行它、退回内置默认，并在响应里明说 policyRejected
     （不是静默降级）；
  5) 本侧不签名：sign() 只是与授权端共用同一套 JWS 规则的测试工具。
"""
import base64
import json
import os
import pathlib
import sys
import tempfile
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import policy_file  # noqa: E402
import sidecar  # noqa: E402

SECRET = base64.b64encode(b"unit-test-shared-secret").decode("ascii")
KID = "authorized-key-1"
ACCOUNT = "a" * 32
DEVICE = "d" * 32
TENANT = "tenant-1"
POLICY_REF = "policy-ref-1"


def payload(**overrides):
    body = {"policyId": "dy-intercept", "policyVersion": 3, "knowledgeSetVersion": 7,
            "allowPublicStates": ["sent_confirmed"],
            "maxPrivate": 20, "minTextLength": 2, "maxTextLength": 500,
            "tenantId": TENANT, "accountScope": ACCOUNT, "deviceId": DEVICE,
            "policyRef": POLICY_REF}
    body.update(overrides)
    return body


def envelope(**overrides):
    return policy_file.sign(payload(**overrides), "unit-test-shared-secret", KID)


class PolicySignatureTests(unittest.TestCase):
    def _write(self, body, td, name="policy.json"):
        path = os.path.join(td, name)
        with open(path, "w", encoding="utf-8") as handle:
            if isinstance(body, str):
                handle.write(body)
            else:
                json.dump(body, handle, ensure_ascii=False)
        return path

    def _keys(self, td, kid=KID, secret=SECRET):
        return policy_file.load_keys(self._write({"kid": kid, "secretBase64": secret}, td, "key.json"))

    def _load(self, td, body, **kwargs):
        keys = kwargs.pop("keys", None) or self._keys(td)
        return policy_file.load(self._write(body, td), keys=keys, account_scope=ACCOUNT,
                                device=DEVICE, tenant=TENANT, **kwargs)

    def test_no_path_means_no_policy(self):
        self.assertIsNone(policy_file.load(None))
        self.assertIsNone(policy_file.load(""))

    def test_a_properly_signed_policy_binds_tenant_account_device_and_ref(self):
        with tempfile.TemporaryDirectory() as td:
            loaded = self._load(td, envelope())
        self.assertEqual(loaded["identity"], {"policyId": "dy-intercept", "policyVersion": 3,
                                              "knowledgeSetVersion": 7})
        self.assertEqual(loaded["keyId"], KID)
        self.assertEqual(loaded["tenantId"], TENANT)
        self.assertEqual(loaded["policyRef"], POLICY_REF)
        self.assertEqual(loaded["deviceId"], DEVICE)
        self.assertEqual(loaded["content"]["allowPublicStates"], ["sent_confirmed"])

    def test_a_plain_json_policy_is_refused(self):
        """上一版那种"自带 policySha256 的普通 JSON"：自算哈希不是签名。"""
        body = payload()
        body["policySha256"] = policy_file.digest(body)
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, body)
        self.assertEqual(raised.exception.code, "policy_signature_required")

    def test_a_tampered_payload_breaks_the_signature(self):
        good = envelope()
        raw = good["payload"]
        body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8"))
        body["maxPrivate"] = 999
        tampered = dict(good)
        tampered["payload"] = base64.urlsafe_b64encode(json.dumps(
            body, ensure_ascii=False, sort_keys=True,
            separators=(",", ":")).encode("utf-8")).rstrip(b"=").decode("ascii")
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, tampered)
        self.assertEqual(raised.exception.code, "policy_signature_invalid")

    def test_an_unknown_key_id_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, policy_file.sign(payload(), "unit-test-shared-secret", "other-key"))
        self.assertEqual(raised.exception.code, "policy_key_unknown")

    def test_an_unsupported_algorithm_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, policy_file.sign(payload(), "unit-test-shared-secret", KID, alg="none"))
        self.assertEqual(raised.exception.code, "policy_alg_unsupported")

    def test_bindings_must_match_this_account_device_and_tenant(self):
        cases = [{"accountScope": "b" * 32}, {"deviceId": "e" * 32}, {"tenantId": "tenant-2"}]
        for override in cases:
            with tempfile.TemporaryDirectory() as td:
                with self.assertRaises(policy_file.PolicyFileError) as raised:
                    self._load(td, envelope(**override))
            self.assertEqual(raised.exception.code, "policy_binding_mismatch", repr(override))

    def test_a_missing_binding_is_refused(self):
        body = payload()
        del body["deviceId"]
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, policy_file.sign(body, "unit-test-shared-secret", KID))
        self.assertEqual(raised.exception.code, "policy_file_invalid")

    def test_sent_echoed_is_still_not_allowed(self):
        """🔴 评审要求：授权端签名/认证下发做完之前，只允许 sent_confirmed。"""
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, envelope(allowPublicStates=["sent_confirmed", "sent_echoed"]))
        self.assertEqual(raised.exception.code, "policy_state_not_allowed_yet")

    def test_an_expired_policy_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, envelope(expiresAt=1000), now=2000)
        self.assertEqual(raised.exception.code, "policy_expired")

    def test_bad_shapes_are_refused(self):
        cases = [("{not json", "policy_file_invalid"),
                 (json.dumps([1, 2, 3]), "policy_signature_required"),
                 (json.dumps({"protected": "x"}), "policy_signature_required")]
        for body, code in cases:
            with tempfile.TemporaryDirectory() as td:
                with self.assertRaises(policy_file.PolicyFileError) as raised:
                    self._load(td, body)
            self.assertEqual(raised.exception.code, code, str(body)[:40])

    def test_a_missing_file_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                policy_file.load(os.path.join(td, "no-such.json"), keys={KID: b"x"})
        self.assertEqual(raised.exception.code, "policy_file_missing")

    def test_key_file_shapes(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(self._keys(td), {KID: base64.b64decode(SECRET)})
            mapped = self._write({"keys": {KID: SECRET}}, td, "keys.json")
            self.assertEqual(policy_file.load_keys(mapped), {KID: base64.b64decode(SECRET)})
            broken = self._write({"kid": KID, "secretBase64": ""}, td, "broken.json")
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                policy_file.load_keys(broken)
            self.assertEqual(raised.exception.code, "policy_key_invalid")
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                policy_file.load_keys(os.path.join(td, "missing.json"))
            self.assertEqual(raised.exception.code, "policy_key_missing")

    def test_device_id_is_stable_and_persisted(self):
        with tempfile.TemporaryDirectory() as td:
            first = policy_file.device_id(td)
            second = policy_file.device_id(td)
            self.assertEqual(first, second)
            self.assertTrue(os.path.isfile(os.path.join(td, "device.json")))


class SidecarPolicyWiringTests(unittest.TestCase):
    def _instance(self, td, policy_path=None, policy_key_path=None):
        return sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19291,
                               policy_path=policy_path, policy_key_path=policy_key_path)

    def _signed_files(self, td, body=None):
        state = os.path.join(td, "state")
        os.makedirs(state, exist_ok=True)
        device = policy_file.device_id(state)
        instance = self._instance(td)
        account = instance.account_scope
        payload_body = {"policyId": "dy-intercept", "policyVersion": 3, "allowPublicStates": ["sent_confirmed"],
                        "tenantId": TENANT, "accountScope": account, "deviceId": device,
                        "policyRef": POLICY_REF}
        payload_body.update(body or {})
        policy_path = os.path.join(td, "policy.json")
        with open(policy_path, "w", encoding="utf-8") as handle:
            json.dump(policy_file.sign(payload_body, "unit-test-shared-secret", KID), handle,
                      ensure_ascii=False)
        key_path = os.path.join(td, "key.json")
        with open(key_path, "w", encoding="utf-8") as handle:
            json.dump({"kid": KID, "secretBase64": SECRET}, handle, ensure_ascii=False)
        return policy_path, key_path, account, device

    def _event(self, recorded_state, send_id, via_state_column=False):
        if via_state_column:
            return {"state": recorded_state, "detail": {"sendId": send_id}}
        return {"detail": {"recordedState": recorded_state, "sendId": send_id}}

    def test_without_a_policy_file_nothing_changes(self):
        with tempfile.TemporaryDirectory() as td:
            instance = self._instance(td)
            self.assertIsNone(instance._server_policy())
            self.assertIsNone(sidecar._policy_public_echo(
                instance._server_policy(), self._event("sent_echoed", "s1"), "s1"))
            self.assertEqual(instance._policy_status()["policySource"], "builtin_default")

    def test_a_signed_policy_is_used_and_reported(self):
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, _account, _device = self._signed_files(td)
            instance = self._instance(td, policy_path=policy_path, policy_key_path=key_path)
            loaded = instance._server_policy()
            self.assertIsNotNone(loaded, instance._policy_status())
            status = instance._policy_status()
        self.assertEqual(status["policySource"], "server_signed_file")
        self.assertEqual(status["policyKeyId"], KID)
        self.assertEqual(status["policyRef"], POLICY_REF)
        self.assertIsNone(status["policyRejected"])

    def test_an_unsigned_policy_is_rejected_and_reported_not_obeyed(self):
        """没签名的策略一律不生效：退回内置默认（仍然只放行 sent_confirmed）并如实上报。"""
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "policy.json")
            body = {"policyId": "p", "policyVersion": 1,
                    "allowPublicStates": ["sent_confirmed", "sent_echoed"],
                    "tenantId": TENANT, "accountScope": ACCOUNT, "deviceId": DEVICE,
                    "policyRef": POLICY_REF}
            body["policySha256"] = policy_file.digest(body)
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(body, handle, ensure_ascii=False)
            key_path = os.path.join(td, "key.json")
            with open(key_path, "w", encoding="utf-8") as handle:
                json.dump({"kid": KID, "secretBase64": SECRET}, handle, ensure_ascii=False)
            instance = self._instance(td, policy_path=path, policy_key_path=key_path)
            self.assertIsNone(instance._server_policy())
            status = instance._policy_status()
            self.assertIsNone(sidecar._policy_public_echo(
                instance._server_policy(), self._event("sent_echoed", "s1"), "s1"))
        self.assertEqual(status["policySource"], "builtin_default")
        self.assertEqual(status["policyRejected"]["code"], "policy_signature_required")

    def test_a_policy_without_a_verification_key_is_rejected(self):
        """配了策略却没配验签密钥：同样是配置错误，退回内置默认并如实上报。"""
        with tempfile.TemporaryDirectory() as td:
            policy_path, _key_path, _a, _d = self._signed_files(td)
            instance = self._instance(td, policy_path=policy_path)
            self.assertIsNone(instance._server_policy())
            status = instance._policy_status()
        self.assertEqual(status["policyRejected"]["code"], "policy_key_missing")

    def test_a_signed_policy_from_another_account_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, _a, _d = self._signed_files(td, {"accountScope": "b" * 32})
            instance = self._instance(td, policy_path=policy_path, policy_key_path=key_path)
            self.assertIsNone(instance._server_policy())
            status = instance._policy_status()
        self.assertEqual(status["policyRejected"]["code"], "policy_binding_mismatch")
