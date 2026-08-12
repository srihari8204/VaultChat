#!/usr/bin/env python3
"""
admin/logserver.py — read-only log API behind admin.corefinite.com/logapi/.

Topology (see nginx block in admin/LOGS_DEPLOY.md):
  browser → https://admin.corefinite.com/logapi/*  (nginx, TLS)
          → 127.0.0.1:9999 (this process, loopback-only, token-checked)

SECURITY
  * Binds 127.0.0.1 ONLY. nginx is the sole public path, and every request must
    carry X-Log-Token matching LOG_TOKEN (constant-time compare). No token
    configured → the API refuses to serve anything.
  * Read-only: fixed whitelist of log commands, argv-exec (no shell); the only
    user-influenced values are a clamped line count and a validated duration.

RUN (as a systemd unit — full steps in admin/LOGS_DEPLOY.md):
  LOG_TOKEN=<hex> COMPOSE_DIR=/home/srihari/vaultchat python3 admin/logserver.py
"""
import hmac
import json
import os
import re
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST, PORT = "127.0.0.1", 9999
COMPOSE_DIR = os.environ.get("COMPOSE_DIR", "/home/srihari/vaultchat")
LOG_TOKEN = os.environ.get("LOG_TOKEN", "")
MAX_LINES = 2000

# The box's `dc` alias file set — identical service resolution to operations.
COMPOSE_FILES = ["-f", "docker-compose.yml", "-f", "docker-compose.prod.yml", "-f", "docker-compose.box.yml"]

# type "compose": docker compose logs <name>     (run in COMPOSE_DIR)
# type "journal": journalctl -u <name>
# type "file":    tail -n N <path>
# type "multi":   fixed argv sequence (status overviews)
SOURCES = {
    # ── docker compose services ──
    "caddy":            {"type": "compose", "name": "caddy"},
    "go-api":           {"type": "compose", "name": "go-api"},
    "postgres":         {"type": "compose", "name": "postgres"},
    "pgbouncer":        {"type": "compose", "name": "pgbouncer"},
    "redis":            {"type": "compose", "name": "redis"},
    "valhalla":         {"type": "compose", "name": "valhalla"},
    "coturn":           {"type": "compose", "name": "coturn"},
    "livekit":          {"type": "compose", "name": "livekit"},
    "prometheus":       {"type": "compose", "name": "prometheus"},
    "grafana":          {"type": "compose", "name": "grafana"},
    "api (node, legacy)": {"type": "compose", "name": "api"},
    # ── system services (journalctl) ──
    "nginx (journal)":  {"type": "journal", "name": "nginx"},
    "docker (journal)": {"type": "journal", "name": "docker"},
    "sshd (journal)":   {"type": "journal", "name": "ssh"},
    "ufw (journal)":    {"type": "journal", "name": "ufw"},
    # ── plain log files ──
    "nginx access.log": {"type": "file", "path": "/var/log/nginx/access.log"},
    "nginx error.log":  {"type": "file", "path": "/var/log/nginx/error.log"},
    "syslog":           {"type": "file", "path": "/var/log/syslog"},
    # ── overviews ──
    "docker ps":        {"type": "multi", "argvs": [["docker", "ps", "--format",
                         "table {{.Names}}\t{{.Status}}\t{{.Ports}}"]]},
    "disk / memory":    {"type": "multi", "argvs": [["df", "-h"], ["free", "-h"], ["uptime"]]},
}


def compose_base():
    """`docker compose` (v2) with `docker-compose` (v1) fallback."""
    if shutil.which("docker"):
        try:
            if subprocess.run(["docker", "compose", "version"], capture_output=True, timeout=10).returncode == 0:
                return ["docker", "compose"]
        except Exception:
            pass
    if shutil.which("docker-compose"):
        return ["docker-compose"]
    return ["docker", "compose"]


COMPOSE = compose_base()


def run(argv, cwd=None):
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=25)
        return p.returncode, p.stdout or "", p.stderr or ""
    except Exception as e:  # timeout, missing binary, …
        return 1, "", str(e)


def fetch(src, lines, since):
    s = SOURCES[src]
    if s["type"] == "compose":
        argv = COMPOSE + COMPOSE_FILES + ["logs", "--no-color", "--tail", str(lines)]
        if since:
            argv += ["--since", since]                      # e.g. 15m, 2h
        argv.append(s["name"])
        return run(argv, cwd=COMPOSE_DIR)
    if s["type"] == "journal":
        argv = ["journalctl", "-u", s["name"], "-n", str(lines), "--no-pager", "-o", "short-iso"]
        if since:
            unit = {"s": "seconds", "m": "minutes", "h": "hours", "d": "days"}[since[-1]]
            argv += ["--since", f"{since[:-1]} {unit} ago"]
        return run(argv)
    if s["type"] == "file":
        return run(["tail", "-n", str(lines), s["path"]])
    if s["type"] == "multi":
        outs, code = [], 0
        for a in s["argvs"]:
            c, o, e = run(a)
            code = code or c
            outs.append(f"$ {' '.join(a)}\n{o or e}")
        return code, "\n".join(outs), ""
    return 1, "", "bad source type"


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # keep the journal quiet
        pass

    def _authed(self):
        if not LOG_TOKEN:
            self._json(503, {"ok": False, "error": "LOG_TOKEN not configured on the server"})
            return False
        tok = self.headers.get("X-Log-Token", "")
        if not hmac.compare_digest(tok, LOG_TOKEN):
            self._json(401, {"ok": False, "error": "bad token"})
            return False
        return True

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not self._authed():
            return
        if u.path == "/sources":
            self._json(200, {"ok": True, "sources": [
                {"id": k, "type": v["type"]} for k, v in SOURCES.items()
            ]})
            return
        if u.path == "/logs":
            src = (q.get("src") or [""])[0]
            if src not in SOURCES:
                self._json(400, {"ok": False, "error": f"unknown source: {src}"})
                return
            try:
                lines = max(10, min(MAX_LINES, int((q.get("lines") or ["200"])[0])))
            except ValueError:
                lines = 200
            since = (q.get("since") or [""])[0]
            if since and not re.fullmatch(r"\d{1,4}[smhd]", since):
                since = ""
            code, out, err = fetch(src, lines, since)
            self._json(200, {
                "ok": code == 0,
                "lines": out.splitlines()[-lines:],
                "error": "" if code == 0 else err[-2000:],
            })
            return
        self._json(404, {"ok": False, "error": "not found"})


if __name__ == "__main__":
    if not LOG_TOKEN:
        print("WARNING: LOG_TOKEN is empty — every request will be refused (503).")
    print(f"log API on http://{HOST}:{PORT}  (compose dir: {COMPOSE_DIR})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
