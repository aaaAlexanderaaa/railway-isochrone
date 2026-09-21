"use strict";
/** 全国天气格点：Open-Meteo 多点日报。供 server.js 使用。
 *
 * 用 POST：GET 带 300+ 坐标会 414 Request-URI Too Long（实测 320 点即失败）。
 * 免费接口单请求上限约 1000 点，但仍按小批 + 限流，避免 429。
 */

const LAT0 = 18, LAT1 = 53.5, LON0 = 73, LON1 = 135;
const NROW = 20, NCOL = 32;
const BATCH = 80;
const CONCURRENCY = 2;
const FORECAST_DAYS = 16;
const OM = "https://api.open-meteo.com/v1/forecast";
const DAILY = [
  "weather_code",
  "temperature_2m_max",
  "precipitation_sum",
  "wind_speed_10m_max",
  "wind_direction_10m_dominant",
  "cloud_cover_mean",
].join(",");
const UA = "railway-map/1.0 (travel overlay)";

function linspace(a, b, n) {
  const o = [];
  if (n === 1) return [a];
  for (let i = 0; i < n; i++) o.push(a + (b - a) * i / (n - 1));
  return o;
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
  const n = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function fetchBatch(pts) {
  const la = pts.map((p) => p[0].toFixed(2)).join(",");
  const lo = pts.map((p) => p[1].toFixed(2)).join(",");
  const body = [
    "latitude=" + la,
    "longitude=" + lo,
    "daily=" + DAILY,
    "forecast_days=" + FORECAST_DAYS,
    "timezone=" + encodeURIComponent("Asia/Shanghai"),
  ].join("&");
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(OM, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
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
      if (!locs[0] || !locs[0].daily || !locs[0].daily.time) {
        throw new Error("Open-Meteo 无 daily 数据");
      }
      if (locs.length !== pts.length) {
        throw new Error("Open-Meteo 返回 " + locs.length + " 点，期望 " + pts.length);
      }
      return { times: locs[0].daily.time, locs };
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr || new Error("Open-Meteo 失败");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

async function buildWeatherGrid() {
  const lats = linspace(LAT0, LAT1, NROW);
  const lons = linspace(LON0, LON1, NCOL);
  const pts = [];
  for (let i = 0; i < NROW; i++) for (let j = 0; j < NCOL; j++) pts.push([lats[i], lons[j]]);
  const batches = [];
  for (let i = 0; i < pts.length; i += BATCH) batches.push(pts.slice(i, i + BATCH));
  const parts = await mapPool(batches, CONCURRENCY, fetchBatch);
  const nDays = Math.min(FORECAST_DAYS, (parts[0].times || []).length);
  if (!nDays) throw new Error("Open-Meteo 没有返回日期");
  const N = NROW * NCOL;
  const pack = {
    ok: true,
    source: "open-meteo",
    lat0: LAT0, lat1: LAT1, lon0: LON0, lon1: LON1,
    nrow: NROW, ncol: NCOL, nDays,
    times: parts[0].times.slice(0, nDays),
    precip: new Array(nDays * N).fill(null),
    temp: new Array(nDays * N).fill(null),
    cloud: new Array(nDays * N).fill(null),
    wind: new Array(nDays * N).fill(null),
    wdir: new Array(nDays * N).fill(null),
    code: new Array(nDays * N).fill(0),
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
  if (k !== N) throw new Error("天气格点填充 " + k + "/" + N);
  return pack;
}

module.exports = { buildWeatherGrid, LAT0, LAT1, LON0, LON1, NROW, NCOL, FORECAST_DAYS, BATCH };
