#!/usr/bin/env python3 -I
"""最小 CDP 客户端：设置视口、可选执行 JS、输出 PNG 截图。仅用标准库。"""
import base64, hashlib, json, os, socket, struct, sys, time, urllib.request

def http_json(url):
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())

class WS:
    def __init__(self, url):
        assert url.startswith("ws://")
        hostport, path = url[5:].split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               "Sec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        resp = b""
        while b"\r\n\r\n" not in resp:
            resp += self.s.recv(1024)
        self._buf = b""

    def send(self, obj):
        data = json.dumps(obj).encode()
        h = bytearray([0x81])
        n = len(data)
        if n < 126:
            h.append(0x80 | n)
        elif n < 65536:
            h.append(0x80 | 126); h += struct.pack(">H", n)
        else:
            h.append(0x80 | 127); h += struct.pack(">Q", n)
        mask = os.urandom(4); h += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.s.sendall(bytes(h) + masked)

    def recv(self):
        while True:
            if self._buf:
                msg, self._buf = self._decode(self._buf)
                if msg is not None:
                    return msg
            self._buf += self.s.recv(65536)

    def _decode(self, buf):
        if len(buf) < 2:
            return None, buf
        b1, b2 = buf[0], buf[1]
        ln = b2 & 0x7f
        i = 2
        if ln == 126:
            ln = struct.unpack(">H", buf[2:4])[0]; i = 4
        elif ln == 127:
            ln = struct.unpack(">Q", buf[2:10])[0]; i = 10
        if len(buf) < i + ln:
            return None, buf
        payload = buf[i:i + ln]
        return json.loads(payload), buf[i + ln:]

def main():
    target = sys.argv[1]          # url
    out_png = sys.argv[2]
    width, height = int(sys.argv[3]), int(sys.argv[4])
    js = sys.argv[5] if len(sys.argv) > 5 else ""
    tabs = http_json("http://127.0.0.1:9222/json")
    page = next(t for t in tabs if t["type"] == "page")
    ws = WS(page["webSocketDebuggerUrl"])
    mid = 0
    def cmd(method, params=None):
        nonlocal mid
        mid += 1
        ws.send({"id": mid, "method": method, "params": params or {}})
        while True:
            m = ws.recv()
            if m.get("id") == mid:
                return m
    cmd("Page.enable")
    cmd("Emulation.setDeviceMetricsOverride",
        {"width": width, "height": height, "deviceScaleFactor": 1, "mobile": False})
    cmd("Page.navigate", {"url": target})
    time.sleep(2.5)  # 等 DOMContentLoaded + 自测
    if js:
        cmd("Runtime.evaluate", {"expression": js, "awaitPromise": True})
        time.sleep(1.5)
    shot = cmd("Page.captureScreenshot", {"format": "png"})
    data = base64.b64decode(shot["result"]["data"])
    with open(out_png, "wb") as f:
        f.write(data)
    print("wrote", out_png, len(data), "bytes")

if __name__ == "__main__":
    main()
