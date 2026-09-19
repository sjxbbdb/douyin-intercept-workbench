"""最小 RFC6455 WebSocket 客户端（仅标准库，零依赖）。

为什么自己写：CDP 只需要"文本帧 + 掩码 + ping/pong"这几件事，
引入第三方库只为这点功能不划算；本项目沿用交接包"依赖越少越好"的原则。

注意：连接 Chrome DevTools 端点时【不要发送 Origin 头】——
Chrome 会拒绝带 Origin 的连接（防止网页直连调试端口）。
"""
import base64
import os
import socket
import ssl
import struct
from urllib.parse import urlparse


class WebSocketError(Exception):
    pass


class RawWebSocket:
    def __init__(self, url, timeout=30.0):
        u = urlparse(url)
        if u.scheme not in ("ws", "wss"):
            raise WebSocketError("unsupported scheme: %r" % url)
        self.secure = u.scheme == "wss"
        self.host = u.hostname
        self.port = u.port or (443 if self.secure else 80)
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        self.path = path
        self.timeout = timeout
        self.sock = None
        self._buf = b""

    # ---------- 连接 ----------

    def connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=self.timeout)
        if self.secure:
            ctx = ssl.create_default_context()
            # 本地调试端口常用自签证书
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            raw = ctx.wrap_socket(raw, server_hostname=self.host)
        self.sock = raw
        self._handshake()
        return self

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        host_header = self.host
        if self.port not in (80, 443):
            host_header = "%s:%d" % (self.host, self.port)
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ) % (self.path, host_header, key)
        self.sock.sendall(req.encode("ascii"))
        # 读到 \r\n\r\n 为止
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WebSocketError("handshake: connection closed")
            head += chunk
            if len(head) > 65536:
                raise WebSocketError("handshake: header too large")
        header, _, rest = head.partition(b"\r\n\r\n")
        self._buf = rest
        first = header.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101" not in first:
            raise WebSocketError("handshake failed: %s" % first)

    # ---------- 收发 ----------

    def _send_frame(self, opcode, payload):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        key = os.urandom(4)
        masked = bytes(b ^ key[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + key + masked)

    def send_text(self, text):
        self._send_frame(0x1, text)

    def _read_exact(self, n):
        while len(self._buf) < n:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout as exc:
                # 裸 TimeoutError 会穿透到调用方且难以归因；
                # 统一包成 WebSocketError，由 cdp.call 再包成 CDPError。
                raise WebSocketError("read timeout (socket)") from exc
            except OSError as exc:
                raise WebSocketError("socket error: %s" % exc) from exc
            if not chunk:
                raise WebSocketError("connection closed while reading")
            self._buf += chunk
        out = self._buf[:n]
        self._buf = self._buf[n:]
        return out

    def _read_one_frame(self):
        b1, b2 = self._read_exact(2)
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read_exact(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read_exact(8))[0]
        key = self._read_exact(4) if masked else None
        data = self._read_exact(n) if n else b""
        if key:
            data = bytes(b ^ key[i % 4] for i, b in enumerate(data))
        return fin, opcode, data

    def recv_message(self):
        """返回一条完整的文本消息（自动处理 ping/pong 与分片）。"""
        while True:
            fin, opcode, data = self._read_one_frame()
            if opcode == 0x9:  # ping
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                raise WebSocketError("server sent close")
            if opcode in (0x1, 0x2):
                payload = data
                while not fin:
                    fin, _op, more = self._read_one_frame()
                    payload += more
                return payload.decode("utf-8", "replace")
            # 未知 opcode：忽略

    def set_timeout(self, seconds):
        if self.sock is not None:
            self.sock.settimeout(seconds)

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            if self.sock:
                self.sock.close()
        except Exception:
            pass
        self.sock = None
