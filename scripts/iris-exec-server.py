#!/usr/bin/env python3
"""
Tiny HTTP server baked into the Firecracker rootfs.
Listens on port 8080 and executes bash commands on behalf of iris-runtime.

Endpoints:
  GET  /health        → {"status": "ok"}
  POST /exec          → {"command": "...", "timeout": 60}
                     ← {"stdout": "...", "stderr": "...", "exit_code": 0}
"""
import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8080


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # suppress per-request noise

    def send_json(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok"})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/exec":
            self.send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            req = json.loads(body)
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid JSON"})
            return

        command = req.get("command", "")
        timeout = int(req.get("timeout", 60))

        if not command:
            self.send_json(400, {"error": "command is required"})
            return

        try:
            result = subprocess.run(
                ["sh", "-c", command],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            self.send_json(200, {
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exit_code": result.returncode,
            })
        except subprocess.TimeoutExpired:
            self.send_json(200, {
                "stdout": "",
                "stderr": f"Command timed out after {timeout}s",
                "exit_code": 124,
            })
        except Exception as exc:
            self.send_json(500, {
                "stdout": "",
                "stderr": str(exc),
                "exit_code": 1,
            })


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"iris-exec-server listening on :{PORT}", flush=True)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    t.join()
