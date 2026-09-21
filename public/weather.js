/* 地图底图（标准/卫星）+ 全国天气图层（Open-Meteo 预报 + 中央气象台预警） */
"use strict";

const Weather = (() => {
  const LAT0 = 18, LAT1 = 53.5, LON0 = 73, LON1 = 135;
  const NROW = 20, NCOL = 32;
  const BATCH = 80;
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

  const lats = linspace(LAT0, LAT1, NROW);
  const lons = linspace(LON0, LON1, NCOL);
  const dLat = (LAT1 - LAT0) / (NROW - 1);
  const dLon = (LON1 - LON0) / (NCOL - 1);
  const N = NROW * NCOL;

  let map, getDay, stations = [];
  let grid = null; // { times, precip, temp, cloud, wind, wdir, code }
  let gridPromise = null;
  let alarms = [];
  let wxDay = 0;
  let mode = "off"; // off | rain | temp | wind | warn
  let playing = false, playTimer = null;
  let pendingTravelOff = 0;
  let layer = null, windLayer = null, warnGroup = null;
  let baseStd, baseSat, baseSatLbl, currentBase = "std";
  let geoIndex = null;

  function linspace(a, b, n) {
    const o = new Float64Array(n);
    if (n === 1) { o[0] = a; return o; }
    for (let i = 0; i < n; i++) o[i] = a + (b - a) * i / (n - 1);
    return o;
  }

  function gcj2wgs(lat, lng) {
    if (typeof wgs2gcj !== "function") return [lat, lng];
    let wlat = lat, wlng = lng;
    for (let i = 0; i < 4; i++) {
      const [glat, glng] = wgs2gcj(wlat, wlng);
      wlat -= glat - lat;
      wlng -= glng - lng;
    }
    return [wlat, wlng];
  }

  function lerp(a, b, t) {
    if (!Number.isFinite(a)) return b;
    if (!Number.isFinite(b)) return a;
    return a + (b - a) * t;
  }

  function sample(arr, lat, lon, day) {
    const fi = (lat - LAT0) / dLat;
    const fj = (lon - LON0) / dLon;
    if (fi < -0.01 || fj < -0.01 || fi > NROW - 0.99 || fj > NCOL - 0.99) return NaN;
    const i0 = Math.max(0, Math.min(NROW - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(NCOL - 2, Math.floor(fj)));
    const ti = fi - i0, tj = fj - j0;
    const base = day * N;
    const a = arr[base + i0 * NCOL + j0];
    const b = arr[base + i0 * NCOL + j0 + 1];
    const c = arr[base + (i0 + 1) * NCOL + j0];
    const d = arr[base + (i0 + 1) * NCOL + j0 + 1];
    const z0 = lerp(a, b, tj), z1 = lerp(c, d, tj);
    return lerp(z0, z1, ti);
  }

  function sampleCode(lat, lon, day) {
    const fi = Math.round((lat - LAT0) / dLat);
    const fj = Math.round((lon - LON0) / dLon);
    if (fi < 0 || fj < 0 || fi >= NROW || fj >= NCOL) return 0;
    return grid.code[day * N + fi * NCOL + fj] || 0;
  }

  /* ---------- 色标 ---------- */
  function mix(hexA, hexB, t) {
    const p = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const a = p(hexA), b = p(hexB);
    t = Math.max(0, Math.min(1, t));
    return [
      (a[0] + (b[0] - a[0]) * t) | 0,
      (a[1] + (b[1] - a[1]) * t) | 0,
      (a[2] + (b[2] - a[2]) * t) | 0,
    ];
  }
  function ramp(stops, x) {
    if (!Number.isFinite(x)) return [0, 0, 0, 0];
    if (x <= stops[0][0]) return [...mix(stops[0][1], stops[0][1], 0), stops[0][2]];
    for (let i = 1; i < stops.length; i++) {
      if (x <= stops[i][0]) {
        const t = (x - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
        const [r, g, b] = mix(stops[i - 1][1], stops[i][1], t);
        const a = stops[i - 1][2] + (stops[i][2] - stops[i - 1][2]) * t;
        return [r, g, b, a];
      }
    }
    const last = stops[stops.length - 1];
    const [r, g, b] = mix(last[1], last[1], 0);
    return [r, g, b, last[2]];
  }

  const RAIN_STOPS = [
    [0, "#d7e8fb", 0],
    [0.2, "#9ec5f7", 0.32],
    [1, "#5b93ea", 0.48],
    [4, "#1d4ed8", 0.62],
    [10, "#3730a3", 0.74],
    [20, "#6d28d9", 0.82],
    [40, "#9d174d", 0.88],
  ];
  const TEMP_STOPS = [
    [-15, "#1e3a8a", 0.55],
    [0, "#3b82f6", 0.5],
    [10, "#22c55e", 0.48],
    [18, "#a3e635", 0.45],
    [24, "#facc15", 0.5],
    [30, "#f97316", 0.55],
    [36, "#dc2626", 0.62],
    [42, "#7f1d1d", 0.7],
  ];
  const WIND_STOPS = [
    [0, "#e0f2fe", 0.15],
    [12, "#7dd3fc", 0.35],
    [24, "#0ea5e9", 0.48],
    [36, "#eab308", 0.55],
    [50, "#ea580c", 0.65],
    [70, "#b91c1c", 0.75],
  ];

  function edgeFade(lat, lon) {
    const ti = (lat - LAT0) / (LAT1 - LAT0);
    const tj = (lon - LON0) / (LON1 - LON0);
    if (ti < 0 || tj < 0 || ti > 1 || tj > 1) return 0;
    const m = Math.min(ti, 1 - ti, tj, 1 - tj);
    return m < 0.07 ? Math.max(0, m / 0.07) : 1;
  }

  function pixelColor(lat, lon, day) {
    if (!grid) return [0, 0, 0, 0];
    const fade = edgeFade(lat, lon);
    if (fade <= 0) return [0, 0, 0, 0];
    let col;
    if (mode === "rain") {
      const p = sample(grid.precip, lat, lon, day);
      const c = sample(grid.cloud, lat, lon, day);
      const cloudA = Number.isFinite(c) ? Math.min(0.55, (c / 100) * 0.55) : 0;
      const [rr, rg, rb, ra] = ramp(RAIN_STOPS, p);
      if (ra < 0.05 && cloudA < 0.08) return [0, 0, 0, 0];
      col = ra >= 0.05
        ? [rr, rg, rb, Math.min(230, (ra * 255) | 0)]
        : [236, 240, 246, (cloudA * 255) | 0];
    } else if (mode === "temp") {
      const t = sample(grid.temp, lat, lon, day);
      const [r, g, b, a] = ramp(TEMP_STOPS, t);
      col = [r, g, b, a * 255];
    } else if (mode === "wind") {
      const w = sample(grid.wind, lat, lon, day);
      const [r, g, b, a] = ramp(WIND_STOPS, w);
      col = [r, g, b, a * 255];
    } else if (mode === "warn") {
      const code = sampleCode(lat, lon, day);
      const p = sample(grid.precip, lat, lon, day);
      const extreme = code >= 95 || code === 65 || code === 67 || code === 75 || code === 82 || code === 86 || code === 96 || code === 99;
      const heavy = p >= 15 || code >= 63;
      if (extreme) col = [185, 28, 28, 0.55 * 255];
      else if (heavy) col = [234, 88, 12, 0.4 * 255];
      else if (p >= 4 || (code >= 61 && code < 80)) col = [234, 179, 8, 0.28 * 255];
      else return [0, 0, 0, 0];
    } else {
      return [0, 0, 0, 0];
    }
    col[3] = (col[3] * fade) | 0;
    return col;
  }

  const WxGrid = L.GridLayer.extend({
    options: { tileSize: 256, opacity: 1, pane: "weatherPane", updateWhenIdle: false, keepBuffer: 1 },
    createTile(coords, done) {
      const canvas = L.DomUtil.create("canvas", "leaflet-tile");
      const size = this.getTileSize();
      canvas.width = size.x;
      canvas.height = size.y;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const run = () => {
        try { this._paint(ctx, coords, size); } catch (e) { /* 空瓦片 */ }
        done(null, canvas);
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else run();
      return canvas;
    },
    _paint(ctx, coords, size) {
      if (!grid || mode === "off") return;
      const map_ = this._map;
      if (!map_) return;
      const z = coords.z;
      const nw = L.point(coords.x * size.x, coords.y * size.y);
      const step = z >= 8 ? 1 : z >= 6 ? 2 : 3;
      const img = ctx.createImageData(size.x, size.y);
      const data = img.data;
      const day = clampDay(wxDay);
      for (let y = 0; y < size.y; y += step) {
        const left = map_.unproject([nw.x, nw.y + y], z);
        const right = map_.unproject([nw.x + size.x, nw.y + y], z);
        const gcjLat = left.lat;
        const [wlat] = z >= 7 ? gcj2wgs(gcjLat, left.lng) : [gcjLat, left.lng];
        for (let x = 0; x < size.x; x += step) {
          const t = x / size.x;
          const gcjLng = left.lng + (right.lng - left.lng) * t;
          const wlng = z >= 7 ? gcj2wgs(wlat, gcjLng)[1] : gcjLng;
          const col = pixelColor(wlat, wlng, day);
          const a = col[3] | 0;
          if (!a) continue;
          for (let dy = 0; dy < step && y + dy < size.y; dy++) {
            for (let dx = 0; dx < step && x + dx < size.x; dx++) {
              const i = ((y + dy) * size.x + (x + dx)) * 4;
              data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = a;
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  });

  const WindArrows = L.Layer.extend({
    onAdd(map_) {
      this._map = map_;
      this._canvas = L.DomUtil.create("canvas", "wx-wind-canvas");
      this._canvas.style.position = "absolute";
      this._canvas.style.pointerEvents = "none";
      map_.getPane("weatherPane").appendChild(this._canvas);
      map_.on("moveend zoomend resize", this._reset, this);
      this._reset();
    },
    onRemove(map_) {
      map_.off("moveend zoomend resize", this._reset, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    },
    _reset() {
      const map_ = this._map, c = this._canvas;
      if (!map_ || !c || !grid || mode !== "wind") {
        if (c) { c.width = 0; c.height = 0; }
        return;
      }
      const size = map_.getSize();
      c.width = size.x; c.height = size.y;
      L.DomUtil.setPosition(c, map_.containerPointToLayerPoint([0, 0]));
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, size.x, size.y);
      const day = clampDay(wxDay);
      const z = map_.getZoom();
      const stride = z >= 7 ? 1 : z >= 5 ? 2 : 3;
      ctx.strokeStyle = "rgba(15,23,42,.85)";
      ctx.fillStyle = "rgba(15,23,42,.85)";
      ctx.lineWidth = 1.2;
      for (let i = 0; i < NROW; i += stride) {
        for (let j = 0; j < NCOL; j += stride) {
          const lat = lats[i], lon = lons[j];
          const [gla, glo] = typeof wgs2gcj === "function" ? wgs2gcj(lat, lon) : [lat, lon];
          const pt = map_.latLngToContainerPoint([gla, glo]);
          if (pt.x < -20 || pt.y < -20 || pt.x > size.x + 20 || pt.y > size.y + 20) continue;
          const spd = grid.wind[day * N + i * NCOL + j];
          const dir = grid.wdir[day * N + i * NCOL + j];
          if (!Number.isFinite(spd) || !Number.isFinite(dir) || spd < 2) continue;
          drawArrow(ctx, pt.x, pt.y, dir, Math.min(22, 6 + spd * 0.28));
        }
      }
    },
  });

  function drawArrow(ctx, x, y, deg, len) {
    // 气象风向：风来自该角度（0=北）。箭头指向风去的方向 = deg+180
    const rad = (deg + 180) * Math.PI / 180;
    const dx = Math.sin(rad) * len, dy = -Math.cos(rad) * len;
    ctx.beginPath();
    ctx.moveTo(x - dx * 0.5, y - dy * 0.5);
    ctx.lineTo(x + dx * 0.5, y + dy * 0.5);
    ctx.stroke();
    const hx = x + dx * 0.5, hy = y + dy * 0.5;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(hx - dx * 0.28 + dy * 0.16, hy - dy * 0.28 - dx * 0.16);
    ctx.lineTo(hx - dx * 0.28 - dy * 0.16, hy - dy * 0.28 + dx * 0.16);
    ctx.closePath();
    ctx.fill();
  }

  function clampDay(d) {
    if (!grid || !grid.nDays) return 0;
    return Math.max(0, Math.min(grid.nDays - 1, d | 0));
  }

  function chinaYmd(date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date || new Date());
  }

  function weekdayName(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  function forecastIndexForTravelOff(dateOff) {
    const off = Number(dateOff) || 0;
    if (!grid || !grid.times || !grid.times.length) return off;
    const today = chinaYmd();
    let i0 = grid.times.indexOf(today);
    if (i0 < 0) {
      i0 = 0;
      for (let i = 0; i < grid.times.length; i++) if (grid.times[i] <= today) i0 = i;
    }
    return clampDay(i0 + off);
  }

  function dayLabel(off) {
    const ymd = grid && grid.times && grid.times[off];
    if (!ymd || !/^\d{4}-\d{2}-\d{2}/.test(ymd)) return `第${off + 1}天`;
    const today = chinaYmd();
    const t0 = Date.parse(today + "T00:00:00+08:00");
    const t1 = Date.parse(ymd.slice(0, 10) + "T00:00:00+08:00");
    const diff = Math.round((t1 - t0) / 86400000);
    const tag = diff === 0 ? "今天 " : diff === 1 ? "明天 " : "";
    const [, mo, d] = ymd.split("-");
    return `${tag}${Number(mo)}/${Number(d)} ${weekdayName(ymd.slice(0, 10))}`;
  }

  /* ---------- 拉取 Open-Meteo ---------- */
  function ensureGrid() {
    if (grid) return Promise.resolve(grid);
    if (gridPromise) return gridPromise;
    gridPromise = fetchGrid().then((g) => {
      grid = g;
      gridPromise = null;
      wxDay = forecastIndexForTravelOff(pendingTravelOff);
      return g;
    }).catch((e) => { gridPromise = null; throw e; });
    return gridPromise;
  }

  async function fetchGrid() {
    try {
      const r = await fetch("/api/weather/grid");
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.times && j.times.length && j.nrow === NROW && j.ncol === NCOL) {
          return unpackPack(j);
        }
      }
    } catch (e) { /* 回退直连 Open-Meteo */ }
    return fetchGridDirect();
  }

  function unpackPack(j) {
    const nDays = j.nDays || (j.times && j.times.length) || FORECAST_DAYS;
    const toF = (a) => {
      const out = new Float32Array(nDays * N);
      out.fill(NaN);
      if (!a) return out;
      for (let i = 0; i < out.length && i < a.length; i++) {
        const v = Number(a[i]);
        out[i] = Number.isFinite(v) ? v : NaN;
      }
      return out;
    };
    const code = new Uint8Array(nDays * N);
    if (j.code) for (let i = 0; i < code.length && i < j.code.length; i++) code[i] = j.code[i] | 0;
    return {
      times: j.times,
      nDays,
      precip: toF(j.precip),
      temp: toF(j.temp),
      cloud: toF(j.cloud),
      wind: toF(j.wind),
      wdir: toF(j.wdir),
      code,
    };
  }

  async function fetchGridDirect() {
    const pts = [];
    for (let i = 0; i < NROW; i++) for (let j = 0; j < NCOL; j++) pts.push([lats[i], lons[j]]);
    const batches = [];
    for (let i = 0; i < pts.length; i += BATCH) batches.push(pts.slice(i, i + BATCH));
    const parts = await Promise.all(batches.map(fetchBatch));
    const nDays = Math.min(FORECAST_DAYS, (parts[0].times || []).length);
    if (!nDays) throw new Error("天气接口没有返回日期");
    const pack = {
      times: parts[0].times.slice(0, nDays),
      nDays,
      precip: new Float32Array(nDays * N),
      temp: new Float32Array(nDays * N),
      cloud: new Float32Array(nDays * N),
      wind: new Float32Array(nDays * N),
      wdir: new Float32Array(nDays * N),
      code: new Uint8Array(nDays * N),
    };
    pack.precip.fill(NaN); pack.temp.fill(NaN); pack.cloud.fill(NaN);
    pack.wind.fill(NaN); pack.wdir.fill(NaN);
    let k = 0;
    for (const part of parts) {
      for (const loc of part.locs) {
        const daily = loc.daily || {};
        for (let d = 0; d < nDays; d++) {
          const idx = d * N + k;
          pack.precip[idx] = num(daily.precipitation_sum && daily.precipitation_sum[d]);
          pack.temp[idx] = num(daily.temperature_2m_max && daily.temperature_2m_max[d]);
          pack.cloud[idx] = num(daily.cloud_cover_mean && daily.cloud_cover_mean[d]);
          pack.wind[idx] = num(daily.wind_speed_10m_max && daily.wind_speed_10m_max[d]);
          pack.wdir[idx] = num(daily.wind_direction_10m_dominant && daily.wind_direction_10m_dominant[d]);
          pack.code[idx] = daily.weather_code && daily.weather_code[d] != null ? (daily.weather_code[d] | 0) : 0;
        }
        k++;
      }
    }
    return pack;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  async function fetchBatch(pts) {
    const la = pts.map((p) => p[0].toFixed(2)).join(",");
    const lo = pts.map((p) => p[1].toFixed(2)).join(",");
    // 回退路径用 GET；每批 ≤80 点，避免 320 点 GET 触发 414
    const url = `${OM}?latitude=${la}&longitude=${lo}&daily=${DAILY}&forecast_days=${FORECAST_DAYS}&timezone=Asia/Shanghai`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("天气数据 HTTP " + r.status);
    const j = await r.json();
    if (j && j.error) throw new Error(j.reason || "天气数据错误");
    const locs = Array.isArray(j) ? j : [j];
    if (!locs[0] || !locs[0].daily) throw new Error("天气数据缺少 daily");
    if (locs.length !== pts.length) throw new Error("天气数据点数不符");
    return { times: (locs[0].daily.time) || [], locs };
  }

  /* ---------- 预警 ---------- */
  function buildGeoIndex(stns) {
    const byName = new Map(), byCity = new Map(), byProv = new Map();
    const cityAgg = new Map(), provAgg = new Map();
    for (const s of stns) {
      byName.set(s.n, s);
      if (s.n.endsWith("站") && s.n.length > 2) byName.set(s.n.slice(0, -1), s);
      let c = cityAgg.get(s.c);
      if (!c) { c = { n: 0, la: 0, lo: 0, name: s.c }; cityAgg.set(s.c, c); }
      c.n++; c.la += s.la; c.lo += s.lo;
      if (s.p) {
        let p = provAgg.get(s.p);
        if (!p) { p = { n: 0, la: 0, lo: 0, name: s.p }; provAgg.set(s.p, p); }
        p.n++; p.la += s.la; p.lo += s.lo;
      }
    }
    for (const [k, v] of cityAgg) byCity.set(k, { n: k, la: v.la / v.n, lo: v.lo / v.n, c: k });
    for (const [k, v] of provAgg) byProv.set(k, { n: k, la: v.la / v.n, lo: v.lo / v.n, c: k });
    return { byName, byCity, byProv };
  }

  function bestHit(str, map) {
    let best = null, n = 1;
    for (const [k, v] of map) {
      if (k.length > n && str.includes(k)) { best = v; n = k.length; }
    }
    return best;
  }

  function locateAlarm(title) {
    if (!geoIndex) return null;
    const head = String(title || "").split(/气象台|发布/)[0];
    return bestHit(head, geoIndex.byName)
      || bestHit(head, geoIndex.byCity)
      || bestHit(head, geoIndex.byProv);
  }

  function levelOf(title) {
    if (/红色/.test(title)) return { name: "红", color: "#b91c1c" };
    if (/橙色/.test(title)) return { name: "橙", color: "#ea580c" };
    if (/黄色/.test(title)) return { name: "黄", color: "#ca8a04" };
    if (/蓝色/.test(title)) return { name: "蓝", color: "#2563eb" };
    return { name: "预警", color: "#7c3aed" };
  }

  async function loadAlarms() {
    try {
      const r = await fetch("/api/weather/alarms");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (!j || j.ok === false) throw new Error(j && j.error || "预警接口失败");
      alarms = [].concat(j.list || [], j.provinceAlarms || []);
    } catch (e) {
      alarms = [];
      throw e;
    }
  }

  function renderAlarms() {
    if (warnGroup) { warnGroup.clearLayers(); }
    if (mode !== "warn" || !map) return;
    if (!warnGroup) warnGroup = L.layerGroup();
    if (!map.hasLayer(warnGroup)) warnGroup.addTo(map);
    const seen = new Set();
    for (const a of alarms) {
      const loc = locateAlarm(a.title);
      if (!loc) continue;
      const key = a.alertid || a.title;
      if (seen.has(key)) continue;
      seen.add(key);
      const lv = levelOf(a.title);
      const [la, lo] = typeof wgs2gcj === "function" ? wgs2gcj(loc.la, loc.lo) : [loc.la, loc.lo];
      const mk = L.circleMarker([la, lo], {
        radius: 7, color: "#fff", weight: 1.2, fillColor: lv.color, fillOpacity: 0.92,
      });
      mk.bindTooltip(`${a.title}<br><span class="mini">${a.issuetime || ""}</span>`, {
        className: "stn-tip", direction: "top",
      });
      warnGroup.addLayer(mk);
    }
  }

  /* ---------- 底图 ---------- */
  function setBasemap(kind) {
    currentBase = kind;
    if (!map) return;
    // 卫星瓦片在海外经常缺块：标准底图垫在下面，缺块处仍能看路网。
    if (!map.hasLayer(baseStd)) baseStd.addTo(map);
    if (kind === "sat") {
      if (!map.hasLayer(baseSat)) baseSat.addTo(map);
      if (!map.hasLayer(baseSatLbl)) baseSatLbl.addTo(map);
      document.body.classList.add("sat-basemap");
    } else {
      if (map.hasLayer(baseSat)) map.removeLayer(baseSat);
      if (map.hasLayer(baseSatLbl)) map.removeLayer(baseSatLbl);
      document.body.classList.remove("sat-basemap");
    }
    try { localStorage.setItem("railBasemap", kind); } catch (e) { /* ignore */ }
  }

  /* ---------- UI ---------- */
  function $(id) { return document.getElementById(id); }

  function legendHtml() {
    if (mode === "off") return "";
    if (mode === "rain") {
      return `<div class="wx-leg">雨云（当日累计降水 + 云量）</div>
        <div class="wx-bar rain"></div>
        <div class="wx-scale"><span>晴</span><span>小雨</span><span>中雨</span><span>大雨</span></div>`;
    }
    if (mode === "temp") {
      return `<div class="wx-leg">最高气温</div>
        <div class="wx-bar temp"></div>
        <div class="wx-scale"><span>-10°</span><span>10°</span><span>25°</span><span>40°</span></div>`;
    }
    if (mode === "wind") {
      return `<div class="wx-leg">最大风速（箭头=风向）</div>
        <div class="wx-bar wind"></div>
        <div class="wx-scale"><span>轻风</span><span>清劲</span><span>大风</span></div>`;
    }
    if (mode === "warn") {
      const n = alarms.length;
      return `<div class="wx-leg">黄色=明显降水 · 橙=较大 · 红=雷暴/极端
        <br>圆点=中央气象台在发预警${n ? `（${n} 条）` : "（加载中/暂不可用）"}</div>`;
    }
    return "";
  }

  function refreshChrome() {
    const row = $("wx-dayrow");
    const src = $("wx-src");
    const leg = $("wx-legend");
    const sl = $("wx-day");
    const lab = $("wx-day-label");
    if (row) row.classList.toggle("hidden", mode === "off");
    if (sl) {
      sl.max = String((grid && grid.nDays ? grid.nDays : FORECAST_DAYS) - 1);
      sl.value = String(clampDay(wxDay));
    }
    if (lab) lab.textContent = mode === "off" ? "" : dayLabel(clampDay(wxDay));
    if (leg) leg.innerHTML = legendHtml();
    if (src) {
      src.textContent = mode === "off" ? "" :
        (mode === "warn"
          ? "预警来自中央气象台（实况）；色块为模式预报，仅供出行参考"
          : "预报 © Open-Meteo（CMA GRAPES / ECMWF / DWD 等），全国格点约 1.5°，大部分可靠、非点对点精确");
    }
    const play = $("wx-play");
    if (play) play.textContent = playing ? "❚❚" : "▶";
  }

  function redraw() {
    if (layer) layer.redraw();
    if (windLayer && windLayer._reset) windLayer._reset();
    renderAlarms();
    refreshChrome();
  }

  async function setMode(next) {
    mode = next;
    try { localStorage.setItem("railWxMode", mode); } catch (e) { /* ignore */ }
    if (mode === "off") {
      stopPlay();
      if (layer && map.hasLayer(layer)) map.removeLayer(layer);
      if (windLayer && map.hasLayer(windLayer)) map.removeLayer(windLayer);
      if (warnGroup && map.hasLayer(warnGroup)) map.removeLayer(warnGroup);
      refreshChrome();
      return;
    }
    setStatusSafe("正在加载全国天气网格…");
    try {
      await ensureGrid();
      if (!grid || !grid.times || !grid.times.length) throw new Error("天气网格为空");
      if (!layer) layer = new WxGrid();
      if (!map.hasLayer(layer)) layer.addTo(map);
      if (mode === "wind") {
        if (!windLayer) windLayer = new WindArrows();
        if (!map.hasLayer(windLayer)) windLayer.addTo(map);
      } else if (windLayer && map.hasLayer(windLayer)) map.removeLayer(windLayer);
      if (mode === "warn") {
        loadAlarms().then(redraw).catch(() => { alarms = []; redraw(); });
      } else if (warnGroup && map.hasLayer(warnGroup)) map.removeLayer(warnGroup);
      setStatusSafe("");
      redraw();
    } catch (e) {
      setStatusSafe("天气图层暂时不可用：" + (e.message || e), true);
      const src = $("wx-src");
      if (src) src.textContent = "天气网格加载失败：" + (e.message || e);
      refreshChrome();
    }
  }

  function setStatusSafe(msg, err) {
    if (typeof setStatus === "function" && msg) setStatus(msg, err);
  }

  function stopPlay() {
    playing = false;
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    refreshChrome();
  }

  function togglePlay() {
    if (playing) { stopPlay(); return; }
    if (mode === "off") return;
    playing = true;
    refreshChrome();
    playTimer = setInterval(() => {
      const max = (grid && grid.nDays ? grid.nDays : FORECAST_DAYS) - 1;
      wxDay = wxDay >= max ? 0 : wxDay + 1;
      redraw();
    }, 900);
  }

  function setDay(off) {
    pendingTravelOff = Number(off) || 0;
    wxDay = forecastIndexForTravelOff(pendingTravelOff);
    if (mode !== "off") redraw();
    else refreshChrome();
  }

  function bindUi() {
    document.querySelectorAll('input[name="basemap"]').forEach((el) => {
      el.onchange = () => setBasemap(el.value);
    });
    document.querySelectorAll('input[name="wx"]').forEach((el) => {
      el.onchange = () => setMode(el.value);
    });
    const sl = $("wx-day");
    if (sl) sl.oninput = () => { wxDay = Number(sl.value) || 0; if (mode !== "off") redraw(); else refreshChrome(); };
    const play = $("wx-play");
    if (play) play.onclick = () => togglePlay();
  }

  function init(opts) {
    map = opts.map;
    getDay = opts.getDay || (() => 0);
    stations = opts.stations || [];
    geoIndex = buildGeoIndex(stations);
    if (!map.getPane("weatherPane")) {
      map.createPane("weatherPane");
      map.getPane("weatherPane").style.zIndex = 350;
      map.getPane("weatherPane").style.pointerEvents = "none";
    }
    if (!map.getPane("satLabels")) {
      map.createPane("satLabels");
      map.getPane("satLabels").style.zIndex = 250;
      map.getPane("satLabels").style.pointerEvents = "none";
    }
    const tileOpts = { subdomains: "1234", attribution: "底图 © 高德地图", maxZoom: 17 };
    function withRetry(layer) {
      layer.on("tileerror", (e) => {
        const t = e.tile;
        if (!t || t.dataset.retried) return;
        t.dataset.retried = "1";
        const src = t.src;
        setTimeout(() => { if (t.parentNode) t.src = src + (src.includes("?") ? "&" : "?") + "r=" + Date.now(); }, 500);
      });
      return layer;
    }
    baseStd = withRetry(L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", tileOpts));
    baseSat = withRetry(L.tileLayer("https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}", tileOpts));
    baseSatLbl = withRetry(L.tileLayer("https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}", { ...tileOpts, pane: "satLabels", opacity: 0.95 }));
    let saved = "std";
    try { saved = localStorage.getItem("railBasemap") || "std"; } catch (e) { /* ignore */ }
    setBasemap(saved === "sat" ? "sat" : "std");
    const radio = document.querySelector(`input[name="basemap"][value="${saved === "sat" ? "sat" : "std"}"]`);
    if (radio) radio.checked = true;
    bindUi();
    pendingTravelOff = getDay();
    wxDay = forecastIndexForTravelOff(pendingTravelOff);
    refreshChrome();
  }

  return { init, setDay, setMode, setBasemap };
})();
