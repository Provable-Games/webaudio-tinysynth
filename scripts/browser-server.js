#!/usr/bin/env node
/*
 * Controlled HTTP server for the browser matrix (Node's http module only).
 *
 * As a module: startServer({overrides}) listens on 127.0.0.1 at an ephemeral
 * port and resolves to {origin, port, requests, registerPage, hold, release,
 * close}. Every request is logged in `requests` with its time, path, status
 * and outcome, so a test can see exactly what the page asked for.
 *
 * Routes (GET only; anything else is 405):
 *   /lib/source.js, /lib/min.js     the library builds (honours --source/--min overrides)
 *   /html/<id>                      a page registered with registerPage(id, html)
 *   /midi/ok/<fixture>              200 with the fixture bytes
 *   /midi/status/<code>/<fixture>   that status code, with the fixture bytes (no body for 204/304)
 *   /midi/redirect/<fixture>        302 to /midi/ok/<fixture>
 *   /midi/empty                     200 with an empty body
 *   /midi/garbage                   200 with 64 bytes that are not a MIDI file
 *   /midi/truncated/<n>/<fixture>   200 with the first n bytes of the fixture
 *   /midi/reset                     the socket is destroyed without a response
 *   /midi/hold/<key>/<fixture>      200 with the fixture, sent only after release(key)
 *   /midi/slow/<ms>/<fixture>       200 with the fixture after ms milliseconds
 *   anything else under the repository root, read-only (static mode only)
 * <fixture> is a path relative to the repository root ending in .mid, such
 * as ws.mid or test-midi/all-gm-sounds.mid.
 *
 * As a CLI (manual listening): node scripts/browser-server.js [--port=8000]
 * serves the repository read-only plus the routes above, for example
 * http://127.0.0.1:8000/simple.html.
 */
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mid": "audio/midi",
  ".css": "text/css", ".png": "image/png", ".json": "application/json", ".map": "application/json", ".md": "text/plain; charset=utf-8",
};

function fixture(rel) {
  if (!/\.mid$/i.test(rel)) throw new Error("not a .mid fixture: " + rel);
  const p = path.resolve(ROOT, rel);
  if (!p.startsWith(ROOT + path.sep)) throw new Error("fixture outside the repository: " + rel);
  return fs.readFileSync(p);
}

function startServer({ overrides = {}, staticFiles = false, port = 0 } = {}) {
  const pages = new Map();
  const holds = new Map();
  const requests = [];
  const sockets = new Set();
  const t0 = Date.now();

  const server = http.createServer((req, res) => {
    const entry = { t: (Date.now() - t0) / 1000, method: req.method, path: req.url, status: null, outcome: "pending", bytes: 0 };
    requests.push(entry);
    const send = (status, body, type) => {
      entry.status = status;
      entry.bytes = body ? body.length : 0;
      entry.outcome = "sent";
      const headers = { "cache-control": "no-store" };
      if (type) headers["content-type"] = type;
      res.writeHead(status, headers);
      res.end(body);
    };
    try {
      if (req.method !== "GET") return send(405, Buffer.from("method not allowed\n"), "text/plain");
      const url = new URL(req.url, "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const rest = (n) => parts.slice(n).join("/");
      if (parts[0] === "lib" && (parts[1] === "source.js" || parts[1] === "min.js")) {
        const build = parts[1] === "source.js" ? "source" : "min";
        const file = overrides[build] || path.join(ROOT, build === "source" ? "webaudio-tinysynth.js" : "webaudio-tinysynth.min.js");
        return send(200, fs.readFileSync(file), TYPES[".js"]);
      }
      if (parts[0] === "html" && pages.has(rest(1))) return send(200, Buffer.from(pages.get(rest(1))), TYPES[".html"]);
      if (parts[0] === "midi") {
        switch (parts[1]) {
        case "ok": return send(200, fixture(rest(2)), TYPES[".mid"]);
        case "status": {
          const code = Number(parts[2]);
          return send(code, code === 204 || code === 304 ? null : fixture(rest(3)), TYPES[".mid"]);
        }
        case "redirect":
          entry.status = 302;
          entry.outcome = "sent";
          res.writeHead(302, { location: "/midi/ok/" + rest(2), "cache-control": "no-store" });
          return res.end();
        case "empty": return send(200, Buffer.alloc(0), TYPES[".mid"]);
        case "garbage": return send(200, Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)), TYPES[".mid"]);
        case "truncated": return send(200, fixture(rest(3)).subarray(0, Number(parts[2])), TYPES[".mid"]);
        case "reset":
          entry.outcome = "reset";
          return req.socket.destroy();
        case "hold": {
          const key = parts[2], body = fixture(rest(3));
          entry.outcome = "held";
          const go = () => send(200, body, TYPES[".mid"]);
          if (holds.get(key) === "released") return go();
          holds.set(key, go);
          return undefined;
        }
        case "slow": {
          const body = fixture(rest(3));
          setTimeout(() => send(200, body, TYPES[".mid"]), Number(parts[2]));
          return undefined;
        }
        }
      }
      if (staticFiles) {
        const p = path.resolve(ROOT, "." + url.pathname);
        const file = p.endsWith(path.sep) || p === ROOT ? path.join(p, "index.html") : p;
        if ((file === ROOT || file.startsWith(ROOT + path.sep)) && !file.includes(path.sep + ".git") &&
            fs.existsSync(file) && fs.statSync(file).isFile())
          return send(200, fs.readFileSync(file), TYPES[path.extname(file).toLowerCase()] || "application/octet-stream");
      }
      return send(404, Buffer.from("not found\n"), "text/plain");
    } catch (e) {
      return send(500, Buffer.from(String(e && e.message) + "\n"), "text/plain");
    }
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        origin: "http://127.0.0.1:" + actual,
        port: actual,
        requests,
        registerPage: (id, html) => pages.set(id, html),
        hold: (key) => { if (!holds.has(key)) holds.set(key, null); },
        release: (key) => {
          const go = holds.get(key);
          holds.set(key, "released");
          if (typeof go === "function") go();
        },
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

/* An address that refuses connections: a port that was bound and then closed. */
function refusedOrigin() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve("http://127.0.0.1:" + port));
    });
  });
}

module.exports = { startServer, refusedOrigin, fixture };

if (require.main === module) {
  const portArg = process.argv.slice(2).map((a) => /^--port=(\d+)$/.exec(a)).find(Boolean);
  startServer({ staticFiles: true, port: portArg ? Number(portArg[1]) : 8000 }).then((s) => {
    console.log("serving " + ROOT + " read-only at " + s.origin + "/ (Ctrl-C to stop)");
    console.log("  demos: " + s.origin + "/simple.html  " + s.origin + "/jstest.html  " + s.origin + "/soundedit.html");
    const shown = new Set();
    setInterval(() => {
      for (const r of s.requests) if (!shown.has(r)) { shown.add(r); console.log(r.t.toFixed(3) + " " + r.method + " " + r.path + " " + r.status + " " + r.outcome); }
    }, 250);
  });
}
