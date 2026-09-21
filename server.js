// 铁路可达圈 - HTTP 服务
// 用法: node server.js  (默认 http://127.0.0.1:8787)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Engine } = require("./lib/engine");
const WC = require("./public/weather_core.js");
const FARE = require("./lib/fare12306.js");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const PUB = path.join(ROOT, "public");

const engine = new Engine(path.join(PUB, "data", "net.json"));
const cache = new Map(); // url -> Buffer
const CACHE_MAX = 60;
let alarmCache = { at: 0, body: null };
const gridCache = new Map(); // model -> { at, body, inflight }
const pointCache = new Map(); // "la,lo" -> { at, body, inflight }
const POINT_CACHE_MAX = 200;
// 模式一天只起报 4 次，3–6h 的格点缓存不损失上游新鲜度；预警才是事件驱动需要短缓存
const GRID_TTL = 6 * 60 * 60 * 1000;
const POINT_TTL = 3 * 60 * 60 * 1000;
const ALARM_TTL = 5 * 60 * 1000;
const GRID_MODELS = ["best_match", "ecmwf_ifs025", "gfs_seamless", "icon_seamless"];
const WX_CACHE_DIR = path.join(ROOT, "data", "wx-cache");

// 最后一次成功的格点落盘：上游限流/重启期间服务陈旧缓存。
// 模式一天只起报 4 次，陈旧数小时的格点在数据上零损失（fetchedAt 会如实标注）。
function wxCachePath(m) { return path.join(WX_CACHE_DIR, m + ".json"); }
function loadStaleGrid(m) {
  try {
    const body = JSON.parse(fs.readFileSync(wxCachePath(m), "utf8"));
    if (body && body.ok && body.times && body.times.length) {
      body.stale = true;
      return body;
    }
  } catch (e) { /* 无陈旧缓存 */ }
  return null;
}
function saveStaleGrid(m, body) {
  try {
    fs.mkdirSync(WX_CACHE_DIR, { recursive: true });
    fs.writeFile(wxCachePath(m), JSON.stringify(body), () => {});
  } catch (e) { /* 落盘失败不影响服务 */ }
}

async function loadWeatherGrid(model) {
  const m = GRID_MODELS.includes(model) ? model : "best_match";
  const hit = gridCache.get(m);
  if (hit && hit.body && Date.now() - hit.at < GRID_TTL) return hit.body;
  // 上游失败退避门：陈旧缓存可用且还在退避期内时，直接服务陈旧，不再打上游
  if (hit && hit.body && hit.retryAt && Date.now() < hit.retryAt) return hit.body;
  if (hit && hit.inflight) return hit.inflight;
  const inflight = (async () => {
    const body = await WC.buildGrid(m);
    body.fetchedAt = new Date().toISOString();
    saveStaleGrid(m, body);
    gridCache.set(m, { at: Date.now(), body, inflight: null, retryAt: 0 });
    return body;
  })().catch((err) => {
    console.warn("[weather-grid:" + m + "] 拉取失败:", err.message);
    const stale = (hit && hit.body) || loadStaleGrid(m);
    if (stale) {
      gridCache.set(m, { at: 0, body: stale, inflight: null, retryAt: Date.now() + 10 * 60 * 1000 });
      return stale;
    }
    gridCache.delete(m);
    throw err;
  });
  gridCache.set(m, { at: hit ? hit.at : 0, body: hit ? hit.body : null, inflight, retryAt: hit ? hit.retryAt : 0 });
  return inflight;
}

async function loadWeatherPoint(la, lo) {
  const key = la.toFixed(2) + "," + lo.toFixed(2);
  const hit = pointCache.get(key);
  if (hit && hit.body && Date.now() - hit.at < POINT_TTL) return hit.body;
  if (hit && hit.inflight) return hit.inflight;
  const inflight = (async () => {
    const body = await WC.fetchPoint(la, lo);
    body.fetchedAt = new Date().toISOString();
    pointCache.set(key, { at: Date.now(), body, inflight: null });
    return body;
  })().catch((e) => {
    pointCache.delete(key);
    throw e;
  });
  pointCache.set(key, { at: 0, body: null, inflight });
  if (pointCache.size > POINT_CACHE_MAX) {
    for (const [k, v] of pointCache) { // FIFO 驱逐，跳过进行中的请求
      if (pointCache.size <= POINT_CACHE_MAX) break;
      if (!v.inflight) pointCache.delete(k);
    }
  }
  return inflight;
}

async function loadAlarms() {
  if (alarmCache.body && Date.now() - alarmCache.at < ALARM_TTL) return alarmCache.body;
  const qs = "pageNo=1&pageSize=200&signaltype=&signallevel=&province=";
  const urls = [
    `https://www.nmc.cn/rest/findAlarm?${qs}`,
    `http://www.nmc.cn/rest/findAlarm?${qs}`,
  ];
  let first = null, lastErr = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "railway-map/1.0", Accept: "application/json" } });
      if (r.ok) { first = await r.json(); break; }
      lastErr = new Error("nmc HTTP " + r.status);
    } catch (e) { lastErr = e; }
  }
  if (!first) throw lastErr || new Error("nmc unreachable");
  const page = first.data && first.data.page;
  let list = (page && page.list) || [];
  const totalPage = (page && page.totalPage) || 1;
  for (let p = 2; p <= Math.min(totalPage, 3); p++) {
    try {
      const r = await fetch(`https://www.nmc.cn/rest/findAlarm?pageNo=${p}&pageSize=200&signaltype=&signallevel=&province=`, {
        headers: { "User-Agent": "railway-map/1.0", Accept: "application/json" },
      });
      if (!r.ok) break;
      const j = await r.json();
      const extra = j && j.data && j.data.page && j.data.page.list;
      if (extra && extra.length) list = list.concat(extra);
    } catch (e) { break; }
  }
  const body = {
    ok: true,
    source: "nmc.cn",
    fetchedAt: new Date().toISOString(),
    count: list.length,
    list,
    provinceAlarms: (first.data && first.data.provinceAlarms) || [],
    stat: (first.data && first.data.stat) || null,
  };
  alarmCache = { at: Date.now(), body };
  return body;
}

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

function sendJson(req, res, code, obj, extraHeaders) {
  let body = JSON.stringify(obj);
  const enc = req.headers["accept-encoding"] || "";
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (enc.includes("gzip")) {
    body = zlib.gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  } else {
    body = Buffer.from(body, "utf8");
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
      if (p === "/api/weather/alarms") {
        loadAlarms()
          .then((body) => sendJson(req, res, 200, body, { "Cache-Control": "public, max-age=300" }))
          .catch((err) => sendJson(req, res, 502, { ok: false, error: String(err.message || err) }));
        return;
      }
      if (p === "/api/weather/grid") {
        const model = q.get("model") || "best_match";
        loadWeatherGrid(model)
          .then((body) => sendJson(req, res, 200, body, { "Cache-Control": "public, max-age=10800" }))
          .catch((err) => sendJson(req, res, 502, { ok: false, error: String(err.message || err) }));
        return;
      }
      if (p === "/api/weather/point") {
        const la = Number(q.get("la")), lo = Number(q.get("lo"));
        if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
          return sendJson(req, res, 400, { ok: false, error: "la/lo 参数非法" });
        }
        loadWeatherPoint(la, lo)
          .then((body) => sendJson(req, res, 200, body, { "Cache-Control": "public, max-age=10800" }))
          .catch((err) => sendJson(req, res, 502, { ok: false, error: String(err.message || err) }));
        return;
      }
      if (p === "/api/fare") {
        // 12306 公布价按需富集：只在用户点开具体行程时调用，失败由前端回退估算价
        const date = (q.get("date") || "").trim();
        const from = (q.get("from") || "").trim();
        const to = (q.get("to") || "").trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !from || !to) {
          return sendJson(req, res, 400, { ok: false, error: "date/from/to 参数非法" });
        }
        FARE.queryFares(date, from, to)
          .then((body) => sendJson(req, res, 200, body, { "Cache-Control": "public, max-age=21600" }))
          .catch((err) => sendJson(req, res, 502, { ok: false, error: String(err.message || err) }));
        return;
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
  loadWeatherGrid().catch((e) => console.warn("[weather-grid] 预热失败:", e.message));
});
