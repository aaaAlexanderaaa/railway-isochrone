/**
 * Cloudflare Pages Function: 全国天气格点（Open-Meteo），浏览器可直接用。
 * GET /api/weather/grid
 *
 * 用 POST 拉 Open-Meteo：GET 300+ 坐标会 414。结果进 Cache API 半小时。
 */
const LAT0 = 18, LAT1 = 53.5, LON0 = 73, LON1 = 135;
const NROW = 20, NCOL = 32;
const BATCH = 80;
const CONCURRENCY = 2;
const FORECAST_DAYS = 16;
const DAILY = "weather_code,temperature_2m_max,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,cloud_cover_mean";
const OM = "https://api.open-meteo.com/v1/forecast";

function linspace(a, b, n) {
  const o = [];
  if (n === 1) return [a];
  for (let i = 0; i < n; i++) o.push(a + (b - a) * i / (n - 1));
  return o;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchBatch(pts) {
  const la = pts.map((p) => p[0].toFixed(2)).join(",");
  const lo = pts.map((p) => p[1].toFixed(2)).join(",");
  const body = `latitude=${la}&longitude=${lo}&daily=${DAILY}&forecast_days=${FORECAST_DAYS}&timezone=${encodeURIComponent("Asia/Shanghai")}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(OM, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (r.status === 429 || r.status >= 500) {
        lastErr = new Error("Open-Meteo HTTP " + r.status);
        await sleep(700 * (attempt + 1));
        continue;
      }
      if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
      const j = await r.json();
      if (j && j.error) throw new Error(j.reason || "Open-Meteo error");
      const locs = Array.isArray(j) ? j : [j];
      if (!locs[0] || !locs[0].daily || !locs[0].daily.time) throw new Error("Open-Meteo 无 daily 数据");
      if (locs.length !== pts.length) throw new Error("Open-Meteo 返回点数不符");
      return { times: locs[0].daily.time, locs };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr || new Error("Open-Meteo 失败");
}

async function buildPack() {
  const lats = linspace(LAT0, LAT1, NROW);
  const lons = linspace(LON0, LON1, NCOL);
  const pts = [];
  for (let i = 0; i < NROW; i++) for (let j = 0; j < NCOL; j++) pts.push([lats[i], lons[j]]);
  const batches = [];
  for (let i = 0; i < pts.length; i += BATCH) batches.push(pts.slice(i, i + BATCH));
  const parts = await mapPool(batches, CONCURRENCY, fetchBatch);
  const nDays = Math.min(FORECAST_DAYS, parts[0].times.length);
  const N = NROW * NCOL;
  const pack = {
    ok: true, source: "open-meteo",
    lat0: LAT0, lat1: LAT1, lon0: LON0, lon1: LON1,
    nrow: NROW, ncol: NCOL, nDays,
    times: parts[0].times.slice(0, nDays),
    precip: new Array(nDays * N).fill(null),
    temp: new Array(nDays * N).fill(null),
    cloud: new Array(nDays * N).fill(null),
    wind: new Array(nDays * N).fill(null),
    wdir: new Array(nDays * N).fill(null),
    code: new Array(nDays * N).fill(0),
    fetchedAt: new Date().toISOString(),
  };
  let k = 0;
  for (const part of parts) {
    for (const loc of part.locs) {
      const daily = loc.daily || {};
      for (let d = 0; d < nDays; d++) {
        const idx = d * N + k;
        pack.precip[idx] = num(daily.precipitation_sum ? daily.precipitation_sum[d] : null);
        pack.temp[idx] = num(daily.temperature_2m_max ? daily.temperature_2m_max[d] : null);
        pack.cloud[idx] = num(daily.cloud_cover_mean ? daily.cloud_cover_mean[d] : null);
        pack.wind[idx] = num(daily.wind_speed_10m_max ? daily.wind_speed_10m_max[d] : null);
        pack.wdir[idx] = num(daily.wind_direction_10m_dominant ? daily.wind_direction_10m_dominant[d] : null);
        pack.code[idx] = daily.weather_code && daily.weather_code[d] != null ? (daily.weather_code[d] | 0) : 0;
      }
      k++;
    }
  }
  return pack;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const cacheKey = new Request(url.origin + "/api/weather/grid", { method: "GET" });
  try {
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  } catch (e) { /* 无 Cache API 时直接拉 */ }

  try {
    const pack = await buildPack();
    const res = new Response(JSON.stringify(pack), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=1800",
      },
    });
    try {
      context.waitUntil(caches.default.put(cacheKey, res.clone()));
    } catch (e) { /* ignore */ }
    return res;
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
