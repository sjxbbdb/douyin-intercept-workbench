# -*- coding: utf-8 -*-
"""授权端下发的【非对称签名】策略：RS256 验签 + 五个绑定 + 台账校验（2026-09-28 第三版）。

评审意见（2026-09-28，第二轮）逐条钉在这里：
  1) 验签密钥不能再是客户端本地共享 HMAC secret（客户端能自己签）——
     只接受非对称签名，客户端只有公钥，私钥留在授权端；
  2) 租户必须绑定到【当前授权会话】；
  3) policyRef 必须【自动写入冻结计划】；
  4) 策略缓存必须感知【过期与轮换】；
  5) 策略放行前必须有【服务端台账存在性校验】的接线，没接线就不放行；
  6) 未完成前只允许 sent_confirmed。
"""
import base64
import hashlib
import hmac
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest

PROBE = pathlib.Path(__file__).resolve().parents[1]
if str(PROBE) not in sys.path:
    sys.path.insert(0, str(PROBE))

import policy_file  # noqa: E402
import sidecar  # noqa: E402

FIXTURE = pathlib.Path(__file__).resolve().parent / "fixtures" / "policy_rsa.json"
RSA = json.loads(FIXTURE.read_text(encoding="utf-8"))
KID = RSA["kid"]
ACCOUNT = "a" * 32
DEVICE = "d" * 32
TENANT = "tenant-1"
POLICY_REF = "policy-ref-1"
SESSION = "auth-session-1"


def payload(**overrides):
    body = {"policyId": "dy-intercept", "policyVersion": 3, "knowledgeSetVersion": 7,
            "allowPublicStates": ["sent_confirmed"],
            "maxPrivate": 20, "minTextLength": 2, "maxTextLength": 500,
            "tenantId": TENANT, "accountScope": ACCOUNT, "deviceId": DEVICE,
            "policyRef": POLICY_REF, "authorizationSession": SESSION}
    body.update(overrides)
    return body


def envelope(**overrides):
    return policy_file.sign(payload(**overrides), RSA, KID)


def public_key_file(td, name="key.json"):
    path = os.path.join(td, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump({"keys": {KID: {"kty": "RSA", "n": RSA["n"], "e": RSA["e"]}}}, handle)
    return path


class PolicySignatureTests(unittest.TestCase):
    def _write(self, body, td, name="policy.json"):
        path = os.path.join(td, name)
        with open(path, "w", encoding="utf-8") as handle:
            if isinstance(body, str):
                handle.write(body)
            else:
                json.dump(body, handle, ensure_ascii=False)
        return path

    def _load(self, td, body, **kwargs):
        kwargs.setdefault("keys", policy_file.load_keys(public_key_file(td)))
        kwargs.setdefault("account_scope", ACCOUNT)
        kwargs.setdefault("device", DEVICE)
        kwargs.setdefault("tenant", TENANT)
        kwargs.setdefault("auth_session", SESSION)
        return policy_file.load(self._write(body, td), **kwargs)

    def test_no_path_means_no_policy(self):
        self.assertIsNone(policy_file.load(None))
        self.assertIsNone(policy_file.load(""))

    def test_a_properly_signed_policy_binds_five_identities(self):
        with tempfile.TemporaryDirectory() as td:
            loaded = self._load(td, envelope())
        self.assertEqual(loaded["identity"], {"policyId": "dy-intercept", "policyVersion": 3,
                                              "knowledgeSetVersion": 7})
        self.assertEqual(loaded["keyId"], KID)
        self.assertEqual(loaded["tenantId"], TENANT)
        self.assertEqual(loaded["policyRef"], POLICY_REF)
        self.assertEqual(loaded["deviceId"], DEVICE)
        self.assertEqual(loaded["authorizationSession"], SESSION)
        self.assertEqual(loaded["content"]["allowPublicStates"], ["sent_confirmed"])

    def test_shared_secret_signatures_are_refused(self):
        """评审核心：共享 HMAC secret 等于客户端能自己签一份策略 —— 一律拒绝。"""
        header = {"alg": "HS256", "kid": KID, "typ": "JWT"}
        protected = base64.urlsafe_b64encode(
            json.dumps(header, sort_keys=True, separators=(",", ":")).encode()).rstrip(b"=").decode()
        body = base64.urlsafe_b64encode(json.dumps(payload(), ensure_ascii=False, sort_keys=True,
                                                   separators=(",", ":")).encode()).rstrip(b"=").decode()
        signature = base64.urlsafe_b64encode(
            hmac.new(b"client-side-secret", ("%s.%s" % (protected, body)).encode("ascii"),
                     hashlib.sha256).digest()).rstrip(b"=").decode()
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, {"protected": protected, "payload": body, "signature": signature})
        self.assertEqual(raised.exception.code, "policy_alg_unsupported")

    def test_a_shared_secret_key_file_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "oct.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"kid": KID, "kty": "oct", "secretBase64": "AAAA"}, handle)
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                policy_file.load_keys(path)
        self.assertEqual(raised.exception.code, "policy_key_invalid")

    def test_a_plain_json_policy_is_refused(self):
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
        other = dict(RSA)
        other["kid"] = "not-provisioned"
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, policy_file.sign(payload(), other, "not-provisioned"))
        self.assertEqual(raised.exception.code, "policy_key_unknown")

    def test_every_binding_must_match(self):
        cases = [{"accountScope": "b" * 32}, {"deviceId": "e" * 32}, {"tenantId": "tenant-2"},
                 {"authorizationSession": "auth-session-2"}]
        for override in cases:
            with tempfile.TemporaryDirectory() as td:
                with self.assertRaises(policy_file.PolicyFileError) as raised:
                    self._load(td, envelope(**override))
            self.assertEqual(raised.exception.code, "policy_binding_mismatch", repr(override))

    def test_a_missing_binding_in_the_payload_is_refused(self):
        for field in ("deviceId", "authorizationSession", "tenantId"):
            body = payload()
            del body[field]
            with tempfile.TemporaryDirectory() as td:
                with self.assertRaises(policy_file.PolicyFileError) as raised:
                    self._load(td, policy_file.sign(body, RSA, KID))
            self.assertEqual(raised.exception.code, "policy_file_invalid", field)

    def test_a_missing_local_binding_value_is_refused(self):
        """本机没有授权会话（宿主没透传）时，绑定无从谈起 -> 不放行。"""
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(policy_file.PolicyFileError) as raised:
                self._load(td, envelope(), auth_session=None)
        self.assertEqual(raised.exception.code, "policy_binding_missing")

    def test_sent_echoed_is_still_not_allowed(self):
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

    def test_device_id_is_stable_and_persisted(self):
        with tempfile.TemporaryDirectory() as td:
            first = policy_file.device_id(td)
            self.assertEqual(first, policy_file.device_id(td))
            self.assertTrue(os.path.isfile(os.path.join(td, "device.json")))


class SidecarPolicyWiringTests(unittest.TestCase):
    """sidecar 侧：缓存感知过期/轮换、台账校验接线、policyRef 自动写入冻结计划。"""

    def _instance(self, td, policy_path=None, policy_key_path=None):
        return sidecar.Sidecar(os.path.join(td, "state"), os.path.join(td, "profile"), 19291,
                               policy_path=policy_path, policy_key_path=policy_key_path,
                               auth_session=SESSION, auth_tenant=TENANT)

    def _signed_files(self, td, **overrides):
        state = os.path.join(td, "state")
        os.makedirs(state, exist_ok=True)
        instance = self._instance(td)
        # 用实例自己的 state_dir：Sidecar 会对路径做 realpath，两处必须指同一个 device.json。
        body = payload(accountScope=instance.account_scope,
                       deviceId=policy_file.device_id(instance.state_dir), **overrides)
        policy_path = os.path.join(td, "policy.json")
        with open(policy_path, "w", encoding="utf-8") as handle:
            json.dump(policy_file.sign(body, RSA, KID), handle, ensure_ascii=False)
        return policy_path, public_key_file(td), instance

    @staticmethod
    def _wired(instance, ok=True):
        instance.policy_ledger_check = lambda _loaded: ok
        return instance

    def test_without_a_policy_file_nothing_changes(self):
        with tempfile.TemporaryDirectory() as td:
            instance = self._instance(td)
            self.assertIsNone(instance._server_policy())
            self.assertIsNone(sidecar._policy_public_echo(
                instance._server_policy(),
                {"detail": {"recordedState": "sent_echoed", "sendId": "s1"}}, "s1"))
            self.assertEqual(instance._policy_status()["policySource"], "builtin_default")

    def test_a_policy_without_the_ledger_seam_is_not_honoured(self):
        """评审第 5 条：没有服务端台账校验的接线，策略一律不放行。"""
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self.assertIsNone(instance._server_policy())
            status = instance._policy_status()
        self.assertEqual(status["policyRejected"]["code"], "policy_not_wired_to_ledger")

    def test_a_policy_missing_from_the_server_ledger_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self._wired(instance, ok=False)
            self.assertIsNone(instance._server_policy())
            status = instance._policy_status()
        self.assertEqual(status["policyRejected"]["code"], "policy_not_in_server_ledger")

    def test_a_wired_and_ledger_backed_policy_is_used(self):
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self._wired(instance)
            loaded = instance._server_policy()
            status = instance._policy_status()
        self.assertIsNotNone(loaded)
        self.assertEqual(status["policySource"], "server_signed_file")
        self.assertEqual(status["policyRef"], POLICY_REF)
        self.assertEqual(status["policyKeyId"], KID)
        self.assertIsNone(status["policyRejected"])

    def test_the_cache_notices_rotation(self):
        """评审第 4 条：换一版策略（文件变了）必须立刻生效，不能一直用缓存。"""
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self._wired(instance)
            self.assertEqual(instance._server_policy()["policyRef"], POLICY_REF)
            rotated = payload(accountScope=instance.account_scope,
                              deviceId=policy_file.device_id(instance.state_dir),
                              policyRef="policy-ref-2", policyVersion=4)
            with open(policy_path, "w", encoding="utf-8") as handle:
                json.dump(policy_file.sign(rotated, RSA, KID), handle, ensure_ascii=False)
            reloaded = instance._server_policy()
        self.assertEqual(reloaded["policyRef"], "policy-ref-2")
        self.assertEqual(reloaded["identity"]["policyVersion"], 4)

    def test_the_cache_notices_expiry(self):
        """评审第 4 条：缓存不能把过期策略一直用下去。"""
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td, expiresAt=time.time() + 0.3)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self._wired(instance)
            self.assertIsNotNone(instance._server_policy())
            time.sleep(0.4)
            self.assertIsNone(instance._server_policy())
            status = instance._policy_status()
        self.assertEqual(status["policyRejected"]["code"], "policy_expired")

    def test_the_issued_policy_ref_is_written_into_the_frozen_plan(self):
        """评审第 3 条：policyRef 必须自动写进冻结计划。"""
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self._wired(instance)
            reference = instance._plan_policy_ref({})
            status = instance._policy_status()
            # 夹具目录一旦退出就被删掉：期望值必须在 with 里取。
            expected_device = policy_file.device_id(instance.state_dir)
        # policyRef 只放稳定的身份三件套（策略内容不许借身份夹带）。
        self.assertEqual(reference, {"policyId": "dy-intercept", "policyVersion": 3,
                                     "knowledgeSetVersion": 7})
        # 绑定信息走 status，事后同样可审计。
        self.assertEqual(status["policyRef"], POLICY_REF)
        self.assertEqual(status["policyTenantId"], TENANT)
        self.assertEqual(status["policyAuthorizationSession"], SESSION)
        self.assertEqual(status["policyDeviceId"], expected_device)

    def test_a_caller_policy_ref_that_disagrees_is_refused(self):
        with tempfile.TemporaryDirectory() as td:
            policy_path, key_path, instance = self._signed_files(td)
            instance.policy_path, instance.policy_key_path = policy_path, key_path
            self._wired(instance)
            with self.assertRaises(sidecar.SidecarError) as raised:
                instance._plan_policy_ref({"policyId": "dy-intercept", "policyVersion": 9})
        self.assertEqual(raised.exception.code, "policy_ref_mismatch")
