/* 浏览器侧引擎 Worker：Cloudflare Pages 无 Node 时也能算可达性 */
"use strict";
importScripts("engine.js");

// 不能再 const Engine —— engine.js 已 class Engine，同名会直接 SyntaxError，Pages 上无 HTTP 回退。
const EngineImpl = (self.RailEngine && self.RailEngine.Engine) || self.Engine;
let engine = null;

function parseList(v) {
  if (Array.isArray(v)) return v.map(Number).filter((x) => Number.isFinite(x));
  if (v == null || v === "") return [];
  return String(v).split(",").map(Number).filter((x) => Number.isFinite(x));
}

self.onmessage = async (ev) => {
  const { id, method, args } = ev.data || {};
  try {
    let result;
    if (method === "boot") {
      const url = (args && args.netUrl) || "data/net.json";
      const r = await fetch(url);
      if (!r.ok) throw new Error(`加载时刻表失败 HTTP ${r.status}`);
      const data = await r.json();
      engine = new EngineImpl(data);
      result = { meta: engine.meta, stations: engine.stations, names: engine.names };
    } else if (!engine) {
      throw new Error("引擎尚未加载");
    } else if (method === "meta") {
      result = { meta: engine.meta, stations: engine.stations, names: engine.names };
    } else if (method === "reach") {
      const o = parseList(args.o), f = Number(args.f), t = Number(args.t);
      const cls = args.cls || "all";
      const r = engine.reach(o, f, t, cls);
      const journeys = [];
      for (const [s, list] of r.journeys) journeys.push([s, list]);
      result = { samples: r.samples, stats: engine.lastStats, journeys };
    } else if (method === "itinerary") {
      const o = parseList(args.o), f = Number(args.f), t = Number(args.t);
      result = engine.itinerary(o, f, t, args.cls || "all", Number(args.st), Number(args.s), Number(args.j));
    } else if (method === "constraint") {
      const d = parseList(args.d), T = Number(args.T), floor = Number(args.floor);
      const xf = Number(args.xf ?? -1), dur = Number(args.dur || 0), ccls = args.cls || "all";
      const r = engine.constraint(d, T, Number.isFinite(floor) ? floor : 0, ccls,
        Number.isFinite(xf) ? xf : -1, Number.isFinite(dur) ? dur : 0);
      result = { latest: Array.from(r.latest), arrAt: Array.from(r.arrAt) };
    } else if (method === "departures") {
      const s = Number(args.s), f = Number(args.f);
      const n = Math.min(Number(args.n) || 8, 30);
      result = { list: engine.departures(s, f, n, args.cls || "all") };
    } else {
      throw new Error("unknown method " + method);
    }
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
