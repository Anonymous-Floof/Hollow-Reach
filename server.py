"""Tiny static file server for the voxel sandbox.

Why this exists: the game is built from ES modules, which browsers refuse to load
over the file:// protocol. This serves the project folder over http with the
correct JavaScript MIME type, picks a free port, and opens your browser for you.

Just run it via run.bat (double-click) -- no terminal navigation required.
"""

import http.server
import socketserver
import socket
import threading
import webbrowser
import os
import re
import json
import urllib.parse

PORT_START = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
# Worlds are saved as plain .json files here, NOT in the browser. localStorage is
# keyed per-origin (which includes the port), so if the server ever bound to a
# different port your worlds would seem to "vanish". Files in this folder are
# shared no matter which port the server uses.
WORLDS_DIR = os.path.join(DIRECTORY, "worlds")
API_PREFIX = "/api/world/"


def world_path(world_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "", world_id or "")
    if not safe or safe in (".", ".."):
        return None
    return os.path.join(WORLDS_DIR, safe + ".json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # Always fetch fresh files during development.
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *args):
        # Keep the console quiet; we only care about the banner below.
        pass

    # ---- world save API (file-backed) ----
    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/worlds":
            return self._list_worlds()
        if self.path.startswith(API_PREFIX):
            return self._read_world(urllib.parse.unquote(self.path[len(API_PREFIX):]))
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith(API_PREFIX):
            return self._write_world(urllib.parse.unquote(self.path[len(API_PREFIX):]))
        self.send_error(404)

    def do_DELETE(self):
        if self.path.startswith(API_PREFIX):
            return self._delete_world(urllib.parse.unquote(self.path[len(API_PREFIX):]))
        self.send_error(404)

    def _list_worlds(self):
        os.makedirs(WORLDS_DIR, exist_ok=True)
        out = []
        for fn in sorted(os.listdir(WORLDS_DIR)):
            if not fn.endswith(".json"):
                continue
            try:
                with open(os.path.join(WORLDS_DIR, fn), "r", encoding="utf-8") as f:
                    s = json.load(f)
                out.append({"id": s.get("id"), "name": s.get("name"), "seed": s.get("seed"),
                            "savedAt": s.get("savedAt"), "version": s.get("version")})
            except Exception:
                pass
        self._send_json(out)

    def _read_world(self, world_id):
        p = world_path(world_id)
        if not p or not os.path.exists(p):
            return self._send_json(None, 404)
        try:
            with open(p, "r", encoding="utf-8") as f:
                self._send_json(json.load(f))
        except Exception:
            self._send_json(None, 500)

    def _write_world(self, world_id):
        p = world_path(world_id)
        if not p:
            return self.send_error(400)
        try:
            length = int(self.headers.get("Content-Length", 0))
            obj = json.loads(self.rfile.read(length))
        except Exception:
            return self.send_error(400)
        os.makedirs(WORLDS_DIR, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        self._send_json({"ok": True})

    def _delete_world(self, world_id):
        p = world_path(world_id)
        if p and os.path.exists(p):
            try:
                os.remove(p)
            except OSError:
                pass
        self._send_json({"ok": True})


# Some Windows Python installs map .js to the wrong type, which breaks module
# loading. Force the correct types.
Handler.extensions_map.update(
    {
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".json": "application/json",
    }
)


def find_free_port(start):
    port = start
    for _ in range(64):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            if probe.connect_ex(("127.0.0.1", port)) != 0:
                return port
        port += 1
    return start


def main():
    port = find_free_port(PORT_START)
    url = "http://localhost:{}/".format(port)
    socketserver.TCPServer.allow_reuse_address = True

    # Prefer a dual-stack IPv6 socket so both ::1 and 127.0.0.1 (i.e. however
    # "localhost" resolves) are reachable; fall back to IPv4 if unavailable.
    server_cls = socketserver.TCPServer
    bind_host = "127.0.0.1"
    try:
        class DualStackServer(socketserver.TCPServer):
            address_family = socket.AF_INET6
            def server_bind(self):
                try:
                    self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                except (AttributeError, OSError):
                    pass
                super().server_bind()
        # probe support
        _probe = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        _probe.close()
        server_cls = DualStackServer
        bind_host = "::"
    except OSError:
        pass

    with server_cls((bind_host, port), Handler) as httpd:
        print("=" * 54)
        print("  Voxel Sandbox  -  server running")
        print("  Open in your browser:  " + url)
        print("  (a browser window should open automatically)")
        print("  Press Ctrl+C in this window to stop the server.")
        print("=" * 54)
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped. You can close this window.")


if __name__ == "__main__":
    main()
