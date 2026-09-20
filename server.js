// 铁路可达圈 - HTTP 服务
// 用法: node server.js  (默认 http://127.0.0.1:8787)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Engine } = require("./lib/engine");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");

const engine = new Engine(path.join(PUB, "data", "net.json"));
const cache = new Map(); // url -> Buffer
const CACHE_MAX = 60;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(req, res, code, obj) {
  let body = JSON.stringify(obj);
  const enc = req.headers["accept-encoding"] || "";
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (enc.includes("gzip")) {
    body = zlib.gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

function parseList(q, name) {
  const v = q.get(name);
  if (!v) return [];
  return v.split(",").map(Number).filter((x) => Number.isFinite(x));
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = u.pathname;

  if (p.startsWith("/api/")) {
    try {
      const q = u.searchParams;
      if (p === "/api/meta") {
        return sendJson(req, res, 200, {
          meta: engine.meta,
          stations: engine.stations,
          names: engine.names,
        });
      }
      if (p === "/api/reach") {
        const key = req.url;
        if (cache.has(key)) return sendJson(req, res, 200, cache.get(key));
        const o = parseList(q, "o"), f = Number(q.get("f")), t = Number(q.get("t"));
        const cls = q.get("cls") || "all";
        if (!o.length || !Number.isFinite(f) || !Number.isFinite(t) || f >= t) {
          return sendJson(req, res, 400, { error: "参数错误: 需要 o(车站列表), f<t(时间窗,绝对分钟)" });
        }
        const r = engine.reach(o, f, t, cls);
        const journeys = [];
        for (const [s, list] of r.journeys) journeys.push([s, list]);
        const out = { samples: r.samples, stats: engine.lastStats, journeys };
        if (cache.size > CACHE_MAX) cache.clear();
        cache.set(key, out);
        return sendJson(req, res, 200, out);
      }
      if (p === "/api/itinerary") {
        const o = parseList(q, "o"), f = Number(q.get("f")), t = Number(q.get("t"));
        const cls = q.get("cls") || "all";
        const st = Number(q.get("st")), s = Number(q.get("s")), j = Number(q.get("j"));
        const r = engine.itinerary(o, f, t, cls, st, s, j);
        return sendJson(req, res, 200, r);
      }
      if (p === "/api/constraint") {
        const key = req.url;
        if (cache.has(key)) return sendJson(req, res, 200, cache.get(key));
        const d = parseList(q, "d"), T = Number(q.get("T")), floor = Number(q.get("floor"));
        const xf = Number(q.get("xf") || -1), dur = Number(q.get("dur") || 0), ccls = q.get("cls") || "all";
        if (!d.length || !Number.isFinite(T)) {
          return sendJson(req, res, 400, { error: "参数错误: 需要 d(目的地), T(截止绝对分钟)" });
        }
        const r = engine.constraint(d, T, Number.isFinite(floor) ? floor : 0, ccls,
          Number.isFinite(xf) ? xf : -1, Number.isFinite(dur) ? dur : 0);
        const out = { latest: Array.from(r.latest), arrAt: Array.from(r.arrAt) };
        if (cache.size > CACHE_MAX) cache.clear();
        cache.set(key, out);
        return sendJson(req, res, 200, out);
      }
      if (p === "/api/departures") {
        const s = Number(q.get("s")), f = Number(q.get("f"));
        const n = Math.min(Number(q.get("n")) || 8, 30);
        const cls = q.get("cls") || "all";
        return sendJson(req, res, 200, { list: engine.departures(s, f, n, cls) });
      }
      return sendJson(req, res, 404, { error: "unknown api" });
    } catch (err) {
      console.error("[api]", err);
      return sendJson(req, res, 500, { error: String(err.message || err) });
    }
  }

  // 静态文件
  let fp = p === "/" ? "/index.html" : p;
  fp = path.normalize(path.join(PUB, fp));
  if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`铁路可达圈 serving at http://127.0.0.1:${PORT}`);
});
