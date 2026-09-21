"use strict";
/** 天气数据核心：Open-Meteo 抓取与打包，三端共用（Node require / 浏览器 script / CF Functions import）。
 * 此前同一套逻辑在 lib/weather_grid.js、functions/api/weather/grid.js、public/weather.js 各有一份，
 * 已经漂移——本文件是唯一实现，其余消费它。
 *
 * 数据协议 v3（相对 v2：格点时间轴混合步长——近 72 小时逐小时、其后 3 小时；point 增加湿度/体感）：
 *  grid pack:  { ok, source, v:3, kind:"grid",
 *    lat0/lat1/lon0/lon1, nrow, ncol, stepMin:0(不再均匀，以 times 为准), nearSteps, nSteps,
 *    times:["YYYY-MM-DDTHH:mm", ...]（近段逐小时，远段 3h）,
 *    precip/temp/wind/wdir/code: 长度 nSteps*N 的数组，idx = step*N + k，k 按行优先（lat 从南到北）。
 *    量化：precip=毫米×10 取整，temp=°C 取整，wind=km/h 取整，wdir=度取整，code=WMO 天气码。
 *  point pack: { ok, source, v:3, kind:"point", la, lo, times:[逐小时 iso], nSteps,
 *    models:[{id,label,temp/rh/app/precip/wind:[..],code:[..]}, ...] }
 *    模型数组短于 times 时以后端返回为准（各模型预报时长不同，缺测为 null）。
 *
 * 缓存策略由各服务端自定；建议 grid 6h、point 3h、预警 5min——模式一天只起报 4 次，
 * 3–6 小时的格点缓存不损失任何上游新鲜度。
 */
var WC = (function () {
  const LAT0 = 18, LAT1 = 53.5, LON0 = 73, LON1 = 135;
  const NROW = 20, NCOL = 32;
  const BATCH = 80;        // GET 带 300+ 坐标会 414，POST 单请求上限约 1000 点，仍分批限流
  const CONCURRENCY = 2;
  const GRID_DAYS = 16;
  const STEP_MIN = 180;    // 全国格点基础步长：3 小时
  const GRID_HOURLY_NEAR = 72; // 近 72 小时逐小时（看云雨怎么"流动"），其后回到 3h；总数据量与全 3h 版相当
  const GRID_HOURLY = "precipitation,temperature_2m,wind_speed_10m,wind_direction_10m,weather_code";
  const POINT_MODELS = ["best_match", "ecmwf_ifs025", "gfs_seamless", "icon_seamless"];
  const POINT_LABELS = { best_match: "综合", ecmwf_ifs025: "ECMWF", gfs_seamless: "GFS", icon_seamless: "ICON" };
  const POINT_HOURLY = "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m";
  const POINT_DAYS = 10;
  const OM = "https://api.open-meteo.com/v1/forecast";
  const FETCH_TIMEOUT_MS = 25000;

  function linspace(a, b, n) {
    const o = [];
    if (n === 1) return [a];
    for (let i = 0; i < n; i++) o.push(a + (b - a) * i / (n - 1));
    return o;
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
    return out;
  }

  // 浏览器里 User-Agent 是禁改头（会抛错），只在 Node/Worker 端带上
  function omHeaders() {
    const h = { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" };
    if (typeof window === "undefined") h["User-Agent"] = "railway-map/1.0 (travel overlay)";
    return h;
  }

  async function omPost(body) {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
      try {
        const r = await fetch(OM, {
          method: "POST", headers: omHeaders(), body, signal: ctl ? ctl.signal : undefined,
        });
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error("Open-Meteo HTTP " + r.status);
          // 日配额类 429 重试无意义，立即失败给出明确原因（否则 16 批 × 重试等待 =
          // 用户面对"正在加载全国天气网格…"卡两三分钟）
          if (r.status === 429) {
            const txt = await r.text().catch(() => "");
            if (/daily/i.test(txt)) throw new Error("Open-Meteo 当日配额已耗尽（北京时间次日 08:00 重置）");
          }
          await sleep(r.status === 429 ? 5000 * (attempt + 1) : 700 * (attempt + 1));
          continue;
        }
        if (!r.ok) throw new Error("Open-Meteo HTTP " + r.status);
        const j = await r.json();
        if (j && j.error) throw new Error(j.reason || "Open-Meteo error");
        return j;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(700 * (attempt + 1));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || new Error("Open-Meteo 失败");
  }

  function gridPoints() {
    const lats = linspace(LAT0, LAT1, NROW), lons = linspace(LON0, LON1, NCOL);
    const pts = [];
    for (let i = 0; i < NROW; i++) for (let j = 0; j < NCOL; j++) pts.push([lats[i], lons[j]]);
    return pts;
  }

  const GRID_MODELS = ["best_match", "ecmwf_ifs025", "gfs_seamless", "icon_seamless"];

  const qi = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; };

  function omBody(bp, resolution, days) {
    const body = [
      "latitude=" + bp.map((p) => p[0].toFixed(2)).join(","),
      "longitude=" + bp.map((p) => p[1].toFixed(2)).join(","),
      "hourly=" + GRID_HOURLY,
      "temporal_resolution=" + resolution,
      "forecast_days=" + days,
      "timezone=" + encodeURIComponent("Asia/Shanghai"),
    ];
    return body.join("&");
  }

  async function buildGrid(model) {
    // model: GRID_MODELS 之一；best_match 省略 models= 参数
    const m = GRID_MODELS.includes(model) ? model : "best_match";
    const pts = gridPoints();
    const batches = [];
    for (let i = 0; i < pts.length; i += BATCH) batches.push(pts.slice(i, i + BATCH));
    const parts = await mapPool(batches, CONCURRENCY, async (bp) => {
      const withModel = (b) => m !== "best_match" ? b + "&models=" + m : b;
      // 两段：近 72h 逐小时 + 全程 3h（72h 恰是 3h 序列的第 24 步，无缝衔接）
      const [j1, j3] = await Promise.all([
        omPost(withModel(omBody(bp, "hourly_1", GRID_HOURLY_NEAR / 24))),
        omPost(withModel(omBody(bp, "hourly_3", GRID_DAYS))),
      ]);
      const l1 = Array.isArray(j1) ? j1 : [j1];
      const l3 = Array.isArray(j3) ? j3 : [j3];
      if (!l1[0] || !l1[0].hourly || !l1[0].hourly.time) throw new Error("Open-Meteo 无 hourly 数据");
      if (l1.length !== bp.length || l3.length !== bp.length) throw new Error("Open-Meteo 点数不符");
      const merged = l1.map((loc, i) => ({ hourly: loc.hourly, hourly3: l3[i].hourly }));
      merged.times = l1[0].hourly.time;
      return merged;
    });
    const t1 = parts[0].times;                     // 逐小时段时刻（长度 = GRID_HOURLY_NEAR）
    const near = Math.min(GRID_HOURLY_NEAR, t1.length);
    const t3 = parts[0][0].hourly3.time;           // 3h 段时刻
    const farStart = Math.ceil(near / 3);          // 72h 之后的第一步（3h 序列下标）
    const times = t1.slice(0, near).concat(t3.slice(farStart, GRID_DAYS * 8));
    const nSteps = times.length;
    if (!nSteps || nSteps <= near) throw new Error("Open-Meteo 没有返回时间序列");
    const N = NROW * NCOL;
    const pack = {
      ok: true, source: "open-meteo", v: 3, kind: "grid",
      lat0: LAT0, lat1: LAT1, lon0: LON0, lon1: LON1, nrow: NROW, ncol: NCOL,
      stepMin: 0,          // v3 起步长不均匀（近端 1h、远端 3h），一切以 times 为准
      nearSteps: near,
      nSteps,
      times,
      precip: new Array(nSteps * N).fill(null),
      temp: new Array(nSteps * N).fill(null),
      wind: new Array(nSteps * N).fill(null),
      wdir: new Array(nSteps * N).fill(null),
      code: new Array(nSteps * N).fill(0),
    };
    let k = 0;
    for (const locs of parts) {
      for (const loc of locs) {
        const h = loc.hourly || {}, h3 = loc.hourly3 || {};
        // 近段（逐小时）
        for (let s = 0; s < near; s++) {
          const idx = s * N + k;
          pack.precip[idx] = h.precipitation && h.precipitation[s] != null ? qi(Math.round(h.precipitation[s] * 10)) : null;
          pack.temp[idx] = h.temperature_2m && h.temperature_2m[s] != null ? qi(h.temperature_2m[s]) : null;
          pack.wind[idx] = h.wind_speed_10m && h.wind_speed_10m[s] != null ? qi(h.wind_speed_10m[s]) : null;
          pack.wdir[idx] = h.wind_direction_10m && h.wind_direction_10m[s] != null ? qi(h.wind_direction_10m[s]) : null;
          pack.code[idx] = h.weather_code && h.weather_code[s] != null ? (h.weather_code[s] | 0) : 0;
        }
        // 远段（3h）
        const nFar = nSteps - near;
        for (let s = 0; s < nFar; s++) {
          const idx = (near + s) * N + k;
          const t = farStart + s;
          pack.precip[idx] = h3.precipitation && h3.precipitation[t] != null ? qi(Math.round(h3.precipitation[t] * 10)) : null;
          pack.temp[idx] = h3.temperature_2m && h3.temperature_2m[t] != null ? qi(h3.temperature_2m[t]) : null;
          pack.wind[idx] = h3.wind_speed_10m && h3.wind_speed_10m[t] != null ? qi(h3.wind_speed_10m[t]) : null;
          pack.wdir[idx] = h3.wind_direction_10m && h3.wind_direction_10m[t] != null ? qi(h3.wind_direction_10m[t]) : null;
          pack.code[idx] = h3.weather_code && h3.weather_code[t] != null ? (h3.weather_code[t] | 0) : 0;
        }
        k++;
      }
    }
    if (k !== N) throw new Error("天气格点填充 " + k + "/" + N);
    return pack;
  }

  async function fetchPoint(la, lo) {
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      throw new Error("坐标非法");
    }
    const body = [
      "latitude=" + Number(la).toFixed(3), "longitude=" + Number(lo).toFixed(3),
      "hourly=" + POINT_HOURLY,
      "models=" + POINT_MODELS.join(","),
      "forecast_days=" + POINT_DAYS,
      "timezone=" + encodeURIComponent("Asia/Shanghai"),
    ].join("&");
    const j = await omPost(body);
    const h = j && j.hourly;
    if (!h || !h.time) throw new Error("Open-Meteo 无 hourly 数据");
    const times = h.time;
    const models = POINT_MODELS.map((m) => {
      // models= 显式指定时所有键都带模型后缀（含 best_match → temperature_2m_best_match）
      const pick = (base) => h[base + "_" + m] || null;
      const col = (arr) => (arr ? Array.prototype.map.call(arr, (v) => (v == null ? null : Math.round(v * 10) / 10)) : null);
      return {
        id: m, label: POINT_LABELS[m] || m,
        temp: col(pick("temperature_2m")),
        rh: col(pick("relative_humidity_2m")),
        app: col(pick("apparent_temperature")),
        precip: col(pick("precipitation")),
        wind: col(pick("wind_speed_10m")),
        code: pick("weather_code"),
      };
    });
    return {
      ok: true, source: "open-meteo", v: 3, kind: "point",
      la: Number(la), lo: Number(lo),
      times, nSteps: times.length, models,
    };
  }

  return {
    LAT0, LAT1, LON0, LON1, NROW, NCOL, STEP_MIN, GRID_DAYS, POINT_DAYS, POINT_MODELS, GRID_MODELS,
    buildGrid, fetchPoint, gridPoints,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = WC;
else if (typeof self !== "undefined") self.WeatherCore = WC;
