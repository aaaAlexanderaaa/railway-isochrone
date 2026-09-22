/* 地图底图（标准/卫星）+ 全国天气图层（Open-Meteo 混合步长格点 + 中央气象台预警）
 * 数据抓取/打包唯一实现在 weather_core.js；本文件负责展示：
 *   - 底部时间轴（近 72h 逐小时 + 远期 3h 步长，播放/拖动，与出发日联动）+ 图例 + 出处
 *   - 站点详情内的单点多模型气象图（温度/湿度/降水/天气类型/逐小时数值，悬停读取）
 *   - 对外提供 arrivalWx()：给候选清单/详情页取"到达时刻天气"
 */
"use strict";

const Weather = (() => {
  const CORE = typeof WeatherCore !== "undefined" ? WeatherCore : null;
  const LAT0 = CORE ? CORE.LAT0 : 18, LAT1 = CORE ? CORE.LAT1 : 53.5;
  const LON0 = CORE ? CORE.LON0 : 73, LON1 = CORE ? CORE.LON1 : 135;
  const NROW = CORE ? CORE.NROW : 20, NCOL = CORE ? CORE.NCOL : 32;
  const DEFAULT_STEPS = 176;

  const lats = linspace(LAT0, LAT1, NROW);
  const lons = linspace(LON0, LON1, NCOL);
  const dLat = (LAT1 - LAT0) / (NROW - 1);
  const dLon = (LON1 - LON0) / (NCOL - 1);
  const N = NROW * NCOL;

  let map, getDay, stations = [];
  let grid = null; // 当前模型的 { times[iso], timesMs, nSteps, precip(mm), temp, wind, wdir, code, fetchedAt }
  let gridPromise = null;
  const gridByModel = new Map();
  let wxModel = "best_match";
  const MODEL_LABELS = { best_match: "综合", ecmwf_ifs025: "ECMWF", gfs_seamless: "GFS", icon_seamless: "ICON" };
  let alarms = [];
  let wxStep = 0;
  let mode = "off";
  let playing = false, playTimer = null;
  let pendingTravelOff = 0;
  let layer = null, windLayer = null, warnGroup = null;
  let baseStd, baseSat, baseSatLbl, currentBase = "std";
  let geoIndex = null;
  const MODEL_COLORS = { best_match: "#2563eb", ecmwf_ifs025: "#7c3aed", gfs_seamless: "#ea580c", icon_seamless: "#0d9488" };
  const pointCache = new Map(); // "la,lo" -> { at, pack } 会话内缓存

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

  /* ---------- 格点采样 ---------- */
  function sample(arr, lat, lon, step) {
    const fi = (lat - LAT0) / dLat;
    const fj = (lon - LON0) / dLon;
    if (fi < -0.01 || fj < -0.01 || fi > NROW - 0.99 || fj > NCOL - 0.99) return NaN;
    const i0 = Math.max(0, Math.min(NROW - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(NCOL - 2, Math.floor(fj)));
    const ti = fi - i0, tj = fj - j0;
    const base = step * N;
    const a = arr[base + i0 * NCOL + j0];
    const b = arr[base + i0 * NCOL + j0 + 1];
    const c = arr[base + (i0 + 1) * NCOL + j0];
    const d = arr[base + (i0 + 1) * NCOL + j0 + 1];
    const z0 = lerp(a, b, tj), z1 = lerp(c, d, tj);
    return lerp(z0, z1, ti);
  }

  function sampleCode(lat, lon, step) {
    const fi = Math.round((lat - LAT0) / dLat);
    const fj = Math.round((lon - LON0) / dLon);
    if (fi < 0 || fj < 0 || fi >= NROW || fj >= NCOL) return 0;
    return grid.code[step * N + fi * NCOL + fj] || 0;
  }

  function clampStep(s) {
    const max = (grid && grid.nSteps ? grid.nSteps : DEFAULT_STEPS) - 1;
    return Math.max(0, Math.min(max, s | 0));
  }

  // 绝对分钟（相对查询日 00:00）→ 时间轴步：timesMs 二分
  function stepForMinute(minAbs) {
    if (!grid || !grid.timesMs || !grid.timesMs.length) return 0;
    const ms = (grid.timesMs[0] - stateAnchorMs()) + (Number(minAbs) || 0) * 60000;
    let lo = 0, hi = grid.timesMs.length - 1;
    if (ms <= grid.timesMs[0]) return 0;
    if (ms >= grid.timesMs[hi]) return hi;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (grid.timesMs[mid] <= ms) lo = mid; else hi = mid;
    }
    // 取更近的一步
    return (ms - grid.timesMs[lo]) <= (grid.timesMs[hi] - ms) ? lo : hi;
  }
  function stateAnchorMs() {
    return typeof state !== "undefined" && state.anchor ? state.anchor.getTime() : Date.now();
  }

  /* ---------- 色标（降水阈值按窗口累计口径校准） ---------- */
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
    [0.05, "#9ec5f7", 0.30],
    [0.5, "#5b93ea", 0.45],
    [2, "#1d4ed8", 0.58],
    [6, "#3730a3", 0.70],
    [12, "#6d28d9", 0.80],
    [25, "#9d174d", 0.88],
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

  function pixelColor(lat, lon, step) {
    if (!grid) return [0, 0, 0, 0];
    const fade = edgeFade(lat, lon);
    if (fade <= 0) return [0, 0, 0, 0];
    let col;
    if (mode === "rain") {
      const p = sample(grid.precip, lat, lon, step);
      const code = sampleCode(lat, lon, step);
      const [rr, rg, rb, ra] = ramp(RAIN_STOPS, p);
      if (ra >= 0.05) {
        col = [rr, rg, rb, Math.min(230, (ra * 255) | 0)];
      } else if (code === 3) {
        col = [214, 222, 234, 42];
      } else if (code === 45 || code === 48) {
        col = [203, 213, 225, 66];
      } else {
        return [0, 0, 0, 0];
      }
    } else if (mode === "temp") {
      const t = sample(grid.temp, lat, lon, step);
      const [r, g, b, a] = ramp(TEMP_STOPS, t);
      col = [r, g, b, a * 255];
    } else if (mode === "wind") {
      const w = sample(grid.wind, lat, lon, step);
      const [r, g, b, a] = ramp(WIND_STOPS, w);
      col = [r, g, b, a * 255];
    } else if (mode === "warn") {
      const code = sampleCode(lat, lon, step);
      const p = sample(grid.precip, lat, lon, step);
      const extreme = code >= 95 || code === 65 || code === 67 || code === 75 || code === 82 || code === 86 || code === 96 || code === 99;
      const heavy = p >= 8 || code >= 63;
      if (extreme) col = [185, 28, 28, 0.55 * 255];
      else if (heavy) col = [234, 88, 12, 0.4 * 255];
      else if (p >= 2.5 || (code >= 61 && code < 80)) col = [234, 179, 8, 0.28 * 255];
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
      if (!this._liveTiles) this._liveTiles = new Map(); // 活动瓦片登记：切帧原地重绘用
      const run = () => {
        try { this._paint(ctx, coords, size); } catch (e) { /* 空瓦片 */ }
        this._liveTiles.set(coords.x + ":" + coords.y + ":" + coords.z,
          { canvas, coords: { x: coords.x, y: coords.y, z: coords.z } });
        done(null, canvas);
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else run();
      return canvas;
    },
    // 切帧路径：不销毁瓦片，离屏画完整帧后一次性拷贝——Leaflet 的 redraw() 会先拆光
    // 瓦片再异步重建，播放时用户看到"清空→闪烁→补上"（2026-09-22 用户体感反馈）
    stepRedraw() {
      if (!this._liveTiles || !this._liveTiles.size) return;
      const size = this.getTileSize();
      // 属性名不能用 _off：Leaflet 内部占用该名，addTo 后会被覆盖成非 canvas
      if (!this._wxOffCanvas) this._wxOffCanvas = document.createElement("canvas");
      if (this._wxOffCanvas.width !== size.x || this._wxOffCanvas.height !== size.y) {
        this._wxOffCanvas.width = size.x;
        this._wxOffCanvas.height = size.y;
      }
      const octx = this._wxOffCanvas.getContext("2d", { willReadFrequently: true });
      for (const [key, rec] of this._liveTiles) {
        if (!rec.canvas.isConnected) { this._liveTiles.delete(key); continue; }
        octx.clearRect(0, 0, size.x, size.y); // 上一瓦片的离屏残影不得串到这块瓦片
        try { this._paint(octx, rec.coords, size); } catch (e) { /* 保持清空 */ }
        const ctx = rec.canvas.getContext("2d");
        ctx.clearRect(0, 0, size.x, size.y);
        ctx.drawImage(this._wxOffCanvas, 0, 0);
      }
    },
    _paint(ctx, coords, size) {
      if (!grid || mode === "off") return;
      const map_ = this._map;
      if (!map_) return;
      const z = coords.z;
      const nw = L.point(coords.x * size.x, coords.y * size.y);
      const stepPx = z >= 8 ? 1 : z >= 6 ? 2 : 3;
      const img = ctx.createImageData(size.x, size.y);
      const data = img.data;
      const step = clampStep(wxStep);
      for (let y = 0; y < size.y; y += stepPx) {
        const left = map_.unproject([nw.x, nw.y + y], z);
        const right = map_.unproject([nw.x + size.x, nw.y + y], z);
        const gcjLat = left.lat;
        const [wlat] = z >= 7 ? gcj2wgs(gcjLat, left.lng) : [gcjLat, left.lng];
        for (let x = 0; x < size.x; x += stepPx) {
          const t = x / size.x;
          const gcjLng = left.lng + (right.lng - left.lng) * t;
          const wlng = z >= 7 ? gcj2wgs(wlat, gcjLng)[1] : gcjLng;
          const col = pixelColor(wlat, wlng, step);
          const a = col[3] | 0;
          if (!a) continue;
          for (let dy = 0; dy < stepPx && y + dy < size.y; dy++) {
            for (let dx = 0; dx < stepPx && x + dx < size.x; dx++) {
              const i = ((y + dy) * size.x + (x + dx)) * 4;
              data[i] = col[0]; data[i + 1] = col[1]; data[i + 2] = col[2]; data[i + 3] = a;
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  });

  /* 风场粒子（Windy 式）：预计算屏幕网格速度场，粒子沿场平移拖尾。 */
  const WindParticles = L.Layer.extend({
    options: { cell: 24, maxParticles: 750, timeScale: 300 },
    onAdd(map_) {
      this._map = map_;
      this._canvas = L.DomUtil.create("canvas", "wx-wind-canvas");
      this._canvas.style.position = "absolute";
      this._canvas.style.pointerEvents = "none";
      map_.getPane("weatherPane").appendChild(this._canvas);
      map_.on("moveend zoomend resize", this._reset, this);
      this._raf = null;
      this._reset();
    },
    onRemove(map_) {
      map_.off("moveend zoomend resize", this._reset, this);
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = null;
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    },
    _reset() {
      const map_ = this._map, c = this._canvas;
      if (!map_ || !c) return;
      this._buildField();
      if (!this._field || mode !== "wind" || !grid) {
        if (c) { c.width = 0; c.height = 0; }
        return;
      }
      const size = map_.getSize();
      c.width = size.x; c.height = size.y;
      L.DomUtil.setPosition(c, map_.containerPointToLayerPoint([0, 0]));
      this._spawn();
      if (!this._raf) this._loop();
    },
    _buildField() {
      if (!grid || !this._map) { this._field = null; return; }
      const map_ = this._map, size = map_.getSize();
      const cell = this.options.cell;
      const cols = Math.ceil(size.x / cell) + 1, rows = Math.ceil(size.y / cell) + 1;
      const step = clampStep(wxStep);
      const field = new Array(cols * rows);
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const ll = map_.containerPointToLatLng([j * cell, i * cell]);
          const [wla, wlo] = gcj2wgs(ll.lat, ll.lng);
          const spd = sample(grid.wind, wla, wlo, step);
          const dir = sample(grid.wdir, wla, wlo, step);
          if (!Number.isFinite(spd) || !Number.isFinite(dir) || spd < 1) { field[i * cols + j] = null; continue; }
          const rad = dir * Math.PI / 180;
          const u = -spd * Math.sin(rad);
          const v = -spd * Math.cos(rad);
          const cosLat = Math.max(0.2, Math.cos(wla * Math.PI / 180));
          const dLat = v / 111, dLon = u / (111 * cosLat);
          const hasG = typeof wgs2gcj === "function";
          const [gla, glo] = hasG ? wgs2gcj(wla, wlo) : [wla, wlo];
          const [gla2, glo2] = hasG ? wgs2gcj(wla + dLat, wlo + dLon) : [wla + dLat, wlo + dLon];
          const p0 = map_.latLngToContainerPoint([gla, glo]);
          const p1 = map_.latLngToContainerPoint([gla2, glo2]);
          field[i * cols + j] = { vx: (p1.x - p0.x) / 3600, vy: (p1.y - p0.y) / 3600, spd };
        }
      }
      this._field = field;
      this._cols = cols;
      this._cell = cell;
    },
    _velAt(x, y) {
      const f = this._field;
      if (!f) return null;
      const j = Math.floor(x / this._cell), i = Math.floor(y / this._cell);
      if (i < 0 || j < 0 || i * this._cols + j >= f.length) return null;
      return f[i * this._cols + j];
    },
    _newP(size) {
      return { x: Math.random() * size.x, y: Math.random() * size.y, age: (Math.random() * 100) | 0, max: 70 + Math.random() * 90 };
    },
    _spawn() {
      const size = this._map.getSize();
      const n = Math.min(this.options.maxParticles, Math.round(size.x * size.y / 1300));
      this._particles = Array.from({ length: n }, () => this._newP(size));
    },
    _loop() {
      const step = () => {
        this._raf = requestAnimationFrame(step);
        if (mode !== "wind" || !this._map || !grid) return;
        this._frame();
      };
      this._raf = requestAnimationFrame(step);
    },
    _frame() {
      const c = this._canvas, ctx = c.getContext("2d");
      if (!c || !c.width) return;
      const size = this._map.getSize();
      const ts = this.options.timeScale / 30;
      // 慢擦除 = 长拖尾；粒子用深色系（浅蓝在底图上不可见——视觉验收观察项 #3）
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,0.055)";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.globalCompositeOperation = "source-over";
      ctx.lineWidth = 1.8;
      ctx.lineCap = "round";
      for (let k = 0; k < this._particles.length; k++) {
        const p = this._particles[k];
        const v = this._velAt(p.x, p.y);
        if (!v || v.spd < 1.5 || p.age > p.max || p.x < -10 || p.y < -10 || p.x > size.x + 10 || p.y > size.y + 10) {
          this._particles[k] = this._newP(size);
          continue;
        }
        const nx = p.x + v.vx * ts, ny = p.y + v.vy * ts;
        const a = 0.5 + Math.min(v.spd / 50, 0.45);
        ctx.strokeStyle = `rgba(17,29,46,${a.toFixed(2)})`;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(nx, ny);
        ctx.stroke();
        p.x = nx; p.y = ny; p.age++;
      }
    },
  });

  /* ---------- 时间轴标签 ---------- */
  function chinaYmd(date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(date || new Date());
  }
  function weekdayName(ymd) {
    const [y, m, d] = ymd.split("-").map(Number);
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  function stepForTravelOff(dateOff) {
    const off = Number(dateOff) || 0;
    if (!grid || !grid.times || !grid.times.length) return off;
    const today = chinaYmd();
    let i0 = grid.times.findIndex((t) => t.slice(0, 10) === today);
    if (i0 < 0) i0 = 0;
    const noonIdx = grid.times.findIndex((t, i) => i >= i0 && t.endsWith("T12:00"));
    const base = noonIdx >= 0 ? noonIdx : i0;
    return clampStep(base + stepSpanSteps(base, off * 1440)); // 出发日正午
  }
  // 从基准步偏移 N 分钟对应几步（混合步长下不能按固定步数换算）
  function stepSpanSteps(fromStep, minutes) {
    if (!grid || !grid.timesMs || !grid.timesMs.length) return 0;
    const target = grid.timesMs[fromStep] + (Number(minutes) || 0) * 60000;
    let hi = grid.timesMs.length - 1;
    if (target >= grid.timesMs[hi]) return hi - fromStep;
    let lo = fromStep;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (grid.timesMs[mid] <= target) lo = mid; else hi = mid;
    }
    return lo - fromStep;
  }

  function stepLabel(s) {
    if (!grid || !grid.times || !grid.times[s]) return "";
    const iso = grid.times[s];
    const ymd = iso.slice(0, 10), hm = iso.slice(11, 16);
    const today = chinaYmd();
    const diff = Math.round((Date.parse(ymd + "T00:00:00+08:00") - Date.parse(today + "T00:00:00+08:00")) / 86400000);
    const tag = diff === 0 ? "今天" : diff === 1 ? "明天" : `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))} ${weekdayName(ymd)}`;
    return `${tag} ${hm}`;
  }

  /* ---------- 拉取（服务端优先，失败回退浏览器直连 Open-Meteo） ---------- */
  function ensureGrid() {
    if (grid) return Promise.resolve(grid);
    if (gridPromise) return gridPromise;
    gridPromise = fetchGrid(wxModel).then((g) => {
      grid = g;
      gridByModel.set(wxModel, g);
      gridPromise = null;
      wxStep = clampStep(stepForTravelOff(pendingTravelOff));
      return g;
    }).catch((e) => { gridPromise = null; throw e; });
    return gridPromise;
  }

  async function fetchGrid(model) {
    const m = MODEL_LABELS[model] ? model : "best_match";
    try {
      const r = await fetch("/api/weather/grid" + (m !== "best_match" ? "?model=" + m : ""));
      if (r.ok) {
        const j = await r.json();
        if (j && j.ok && j.v === 3 && j.times && j.times.length && j.nrow === NROW && j.ncol === NCOL) {
          return unpackPack(j);
        }
      }
    } catch (e) { /* 回退直连 */ }
    if (!CORE) throw new Error("天气组件未加载");
    return unpackPack(await CORE.buildGrid(m));
  }

  function unpackPack(j) {
    const nSteps = j.nSteps || (j.times && j.times.length) || 0;
    if (!nSteps) throw new Error("天气网格为空");
    const toF = (a, div) => {
      const out = new Float32Array(nSteps * N);
      out.fill(NaN);
      if (!a) return out;
      for (let i = 0; i < out.length && i < a.length; i++) {
        const v = Number(a[i]);
        out[i] = Number.isFinite(v) ? v / (div || 1) : NaN;
      }
      return out;
    };
    const code = new Uint8Array(nSteps * N);
    if (j.code) for (let i = 0; i < code.length && i < j.code.length; i++) code[i] = j.code[i] | 0;
    const times = j.times;
    const timesMs = new Float64Array(nSteps);
    for (let i = 0; i < nSteps; i++) timesMs[i] = Date.parse(times[i] + ":00+08:00");
    return {
      times, timesMs, nSteps,
      fetchedAt: j.fetchedAt || null,
      precip: toF(j.precip, 10),
      temp: toF(j.temp),
      wind: toF(j.wind),
      wdir: toF(j.wdir),
      code,
    };
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

  function bestHit(str, map2) {
    let best = null, n = 1;
    for (const [k, v] of map2) {
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

  /* ---------- 单点多模型气象图（渲染进站点详情） ---------- */
  function codeEmoji(code) {
    if (code >= 95) return "⛈️";
    if (code >= 71 && code <= 77) return "🌨️";
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "🌧️";
    if (code >= 51) return "🌦️";
    if (code === 45 || code === 48) return "🌫️";
    if (code >= 1 && code <= 3) return code === 1 ? "🌤️" : "☁️";
    return "☀️";
  }
  function wxTxt(code, prec) {
    if (code >= 95) return "雷雨";
    if (code >= 71 && code <= 77) return "雪";
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
      if (prec >= 8) return "强降水";
      if (prec >= 3) return "中雨";
      return "小雨";
    }
    if (code === 45 || code === 48) return "雾";
    if (code >= 1 && code <= 3) return "多云";
    return "晴";
  }

  async function fetchPoint(la, lo) {
    const key = la.toFixed(2) + "," + lo.toFixed(2);
    const hit = pointCache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.pack;
    const r = await fetch(`/api/weather/point?la=${la.toFixed(3)}&lo=${lo.toFixed(3)}`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (!j || !j.ok) throw new Error(j && j.error || "接口失败");
    pointCache.set(key, { at: Date.now(), pack: j });
    return j;
  }

  async function pointChart(container, la, lo, opts) {
    if (!container) return;
    opts = opts || {};
    container.innerHTML = `<p class="mini">正在加载多模型预报…</p>`;
    let pack;
    try {
      pack = await fetchPoint(la, lo);
    } catch (e) {
      container.innerHTML = `<p class="mini" style="color:#b91c1c">预报加载失败：${e.message || e}</p>`;
      return;
    }
    drawPointChart(container, pack, opts);
  }

  function drawPointChart(container, pd, opts) {
    const n = pd.nSteps;
    const W = Math.max(320, Math.min(720, container.clientWidth || 460)), H = 216, dpr = Math.min(2, window.devicePixelRatio || 1);
    container.innerHTML = "";
    const cv = document.createElement("canvas");
    cv.className = "wx-pt-cv";
    const tip = document.createElement("div");
    tip.className = "wx-pt-tip mini";
    const meta = document.createElement("div");
    meta.className = "mini";
    container.appendChild(cv);
    container.appendChild(tip);
    container.appendChild(meta);
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = "100%"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const padL = 34, padR = 34, padT = 24, iconH = 20, bodyT = padT + iconH, bodyB = H - 40, barH = 26, labelY = H - 8;
    const plotW = W - padL - padR, plotH = bodyB - bodyT - barH;
    // 小时刻度与图标行的抽稀步长：按画布宽度分档（视觉复检：6h 在 400px 宽仍粘连，窄画布降到 12h）
    const hourEvery = plotW < 520 ? 12 : plotW < 760 ? 6 : 3;
    const bm = pd.models.find((m) => m.id === "best_match") || pd.models[0];

    let tMin = Infinity, tMax = -Infinity, pMax = 0;
    for (const m of pd.models) {
      for (const v of (m.temp || [])) { if (v != null) { if (v < tMin) tMin = v; if (v > tMax) tMax = v; } }
    }
    for (const v of (bm.precip || [])) if (v != null && v > pMax) pMax = v;
    if (!Number.isFinite(tMin)) { container.innerHTML = `<p class="mini">无预报数据</p>`; return; }
    tMin = Math.floor(tMin - 2); tMax = Math.ceil(tMax + 2);
    const xOf = (i) => padL + (i / Math.max(1, n - 1)) * plotW;
    const yT = (t) => bodyT + (1 - (t - tMin) / (tMax - tMin)) * plotH;
    const yH = (h) => bodyT + (1 - Math.max(0, Math.min(100, h)) / 100) * plotH;

    ctx.clearRect(0, 0, W, H);
    // 日分隔与日期标签 + 每 3 小时时刻
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    let lastDay = "";
    for (let i = 0; i < n; i++) {
      const d = pd.times[i].slice(0, 10), hm = pd.times[i].slice(11, 16);
      const x = xOf(i);
      if (d !== lastDay) {
        lastDay = d;
        ctx.strokeStyle = "rgba(100,116,139,.35)";
        ctx.beginPath(); ctx.moveTo(x, bodyT - 6); ctx.lineTo(x, bodyB); ctx.stroke();
        ctx.fillStyle = "#475569";
        ctx.fillText(`${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`, x, labelY - 14);
      }
      if (hm.endsWith(":00") && Number(hm.slice(0, 2)) % hourEvery === 0) {
        ctx.strokeStyle = "rgba(148,163,184,.25)";
        ctx.beginPath(); ctx.moveTo(x, bodyT); ctx.lineTo(x, bodyB); ctx.stroke();
        ctx.fillStyle = "#94a3b8";
        ctx.fillText(hm.slice(0, 2), x, labelY);
      }
    }
    // 温度刻度（左）
    ctx.textAlign = "right";
    for (let t = Math.ceil(tMin / 5) * 5; t <= tMax; t += 5) {
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(String(t), padL - 4, yT(t) + 3);
      ctx.strokeStyle = "rgba(148,163,184,.18)";
      ctx.beginPath(); ctx.moveTo(padL, yT(t)); ctx.lineTo(W - padR, yT(t)); ctx.stroke();
    }
    // 湿度刻度（右）
    ctx.textAlign = "left";
    ctx.font = "bold 9px sans-serif";
    for (const hh of [25, 50, 75]) {
      ctx.fillStyle = "#0d9488";
      ctx.fillText(hh + "%", W - padR + 4, yH(hh) + 3);
    }
    ctx.font = "9px sans-serif";
    // 湿度带（综合模式）
    if (bm && bm.rh) {
      ctx.fillStyle = "rgba(13,148,136,.12)";
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = bm.rh[i];
        if (v == null) { pen = false; continue; }
        const x = xOf(i), y = yH(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      for (let i = n - 1; i >= 0; i--) {
        const v = bm.rh[i];
        if (v == null) continue;
        ctx.lineTo(xOf(i), bodyB);
        break;
      }
      ctx.lineTo(xOf(0), bodyB);
      ctx.closePath();
      ctx.fill();
    }
    // 降水柱
    if (bm && bm.precip && pMax > 0.05) {
      ctx.fillStyle = "rgba(59,130,246,.4)";
      const bw = Math.max(1, plotW / n - 0.5);
      for (let i = 0; i < n; i++) {
        const v = bm.precip[i];
        if (v == null || v <= 0) continue;
        const h = Math.min(barH - 4, v / pMax * (barH - 4));
        ctx.fillRect(xOf(i) - bw / 2, bodyB - h, bw, h);
      }
    }
    // 各模型温度线
    for (const m of pd.models) {
      if (!m.temp) continue;
      ctx.strokeStyle = MODEL_COLORS[m.id] || "#475569";
      ctx.lineWidth = m.id === "best_match" ? 2 : 1.2;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const v = m.temp[i];
        if (v == null) { pen = false; continue; }
        const x = xOf(i), y = yT(v);
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    }
    // 天气图标行（与小时刻度同频抽稀，字号略缩留间隙）
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    for (let i = 0; i < n; i++) {
      const hm = pd.times[i].slice(11, 16);
      if (!(hm.endsWith(":00") && Number(hm.slice(0, 2)) % hourEvery === 0)) continue;
      const code = bm && bm.code ? bm.code[i] : 0;
      ctx.fillText(codeEmoji(code), xOf(i), padT + 6);
    }
    // 现在线
    const t0 = Date.parse(pd.times[0] + ":00+08:00");
    const nowH = (Date.now() - t0);
    if (nowH >= 0 && nowH <= (Date.parse(pd.times[n - 1] + ":00+08:00") - t0)) {
      const x = xOf((nowH / (Date.parse(pd.times[n - 1] + ":00+08:00") - t0)) * (n - 1));
      ctx.strokeStyle = "rgba(15,23,42,.65)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, bodyB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "rgba(15,23,42,.75)";
      ctx.textAlign = "left";
      ctx.fillText("现在", x + 3, padT + 8);
    }
    // 到达标记
    if (opts.arrAbs != null && bm) {
      const tEnd = Date.parse(pd.times[n - 1] + ":00+08:00");
      const span = (tEnd - t0) / (n - 1);
      const i = Math.round(((t0 + (Number(opts.arrAbs) || 0) * 60000) - t0) / span);
      const x = xOf(Math.max(0, Math.min(n - 1, i)));
      if (x > padL && x < W - padR) {
        ctx.strokeStyle = "#d97706";
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, bodyB); ctx.stroke();
        ctx.fillStyle = "#d97706";
        ctx.textAlign = "center";
        ctx.fillText("到达", x, padT + 8);
        ctx.lineWidth = 1;
      }
    }

    const upd = pd.fetchedAt ? new Date(pd.fetchedAt) : null;
    const updTxt = upd ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" }).format(upd) : "";
    meta.innerHTML = pd.models.map((m) => `<span style="color:${MODEL_COLORS[m.id]}">━ ${m.label}</span>`).join(" · ")
      + ` · <span style="color:#0d9488">▨ 湿度</span> · 柱=降水 · 悬停看逐小时数值 · © Open-Meteo${updTxt ? " · 更新 " + updTxt : ""}`;

    // 悬停：tooltip 显示逐小时具体数值（重绘仅 tooltip，不动画布）
    cv.onmousemove = (ev) => {
      const rect = cv.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * (W / rect.width);
      const py = (ev.clientY - rect.top) * (H / rect.height);
      const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / plotW * (n - 1))));
      const iso = pd.times[i];
      const code = bm && bm.code ? bm.code[i] : 0;
      const prec = bm && bm.precip ? bm.precip[i] : null;
      const rows = pd.models.filter((m) => m.temp && m.temp[i] != null).map((m) =>
        `<span style="color:${MODEL_COLORS[m.id]}">${m.label} ${m.temp[i]}°C${m.rh && m.rh[i] != null ? ` · 湿${m.rh[i]}%` : ""}${m.wind && m.wind[i] != null ? ` · 风${m.wind[i]}km/h` : ""}</span>`);
      tip.innerHTML = `<b>${iso.slice(5, 16).replace("T", " ")}</b> ${codeEmoji(code)} ${wxTxt(code, prec)}${prec ? ` · 降水${prec}mm/h` : ""}<br>${rows.join("<br>")}`;
      tip.style.display = "block";
      // 跟随光标 Y（不压顶部图标行），X 靠右时向左翻转（视觉验收 P1）
      const tipH = tip.offsetHeight || 70;
      tip.style.top = Math.max(26, Math.min(py - tipH - 10, H - tipH - 6)) + "px";
      const flip = px > (rect.width * 0.62);
      tip.classList.toggle("flip", flip);
      tip.style.left = (flip ? Math.max(140, px) : Math.min(Math.max(px, 26), rect.width - 26)) + "px";
    };
    cv.onmouseleave = () => { tip.style.display = "none"; };
  }

  /* ---------- 对外：到达时刻天气（候选清单/详情用） ---------- */
  async function arrivalWx(la, lo, minuteAbs) {
    if (!CORE) return null;
    const g = await ensureGrid();
    const s = clampStep(stepForMinute(minuteAbs));
    const temp = sample(g.temp, la, lo, s);
    const prec = sample(g.precip, la, lo, s);
    const code = sampleCode(la, lo, s);
    if (!Number.isFinite(temp)) return null;
    return { temp: Math.round(temp), precip: Number.isFinite(prec) ? Math.round(prec * 10) / 10 : null, code, txt: wxTxt(code, prec) };
  }

  /* ---------- UI ---------- */
  function $(id) { return document.getElementById(id); }

  function legendHtml() {
    if (mode === "off") return "";
    if (mode === "rain") {
      return `<div class="wx-leg-inline">雨云（近端逐小时/远端 3h 累计降水；灰=阴/雾）</div>
        <div class="wx-bar rain"></div>`;
    }
    if (mode === "temp") {
      return `<div class="wx-leg-inline">气温</div>
        <div class="wx-bar temp"></div>`;
    }
    if (mode === "wind") {
      return `<div class="wx-leg-inline">风速（粒子流方向=风去的方向，颜色=强弱）</div>
        <div class="wx-bar wind"></div>`;
    }
    if (mode === "warn") {
      const n = alarms.length;
      return `<div class="wx-leg-inline">黄=明显降水 · 橙=较大 · 红=雷暴/极端 · 圆点=气象台在发预警${n ? `（${n} 条）` : ""}</div>`;
    }
    return "";
  }

  function buildTicks() {
    const box = $("wx-ticks");
    if (!box || !grid || !grid.times) return;
    const n = grid.nSteps;
    let html = "";
    let lastDay = "";
    for (let i = 0; i < n; i++) {
      const d = grid.times[i].slice(0, 10);
      if (d === lastDay) continue;
      lastDay = d;
      const today = chinaYmd();
      const diff = Math.round((Date.parse(d + "T00:00:00+08:00") - Date.parse(today + "T00:00:00+08:00")) / 86400000);
      const label = diff === 0 ? "今天" : diff === 1 ? "明天" : `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      html += `<span style="left:${(i / (n - 1) * 100).toFixed(2)}%" title="${d} ${weekdayName(d)}">${label}</span>`;
    }
    box.innerHTML = html;
  }

  function refreshChrome() {
    const tl = $("wx-timeline");
    const on = mode !== "off";
    if (tl) tl.classList.toggle("hidden", !on);
    document.body.classList.toggle("wx-tl-on", on); // 详情面板/地图控件为时间轴让位
    const sl = $("wx-day");
    if (sl) {
      sl.max = String((grid && grid.nSteps ? grid.nSteps : DEFAULT_STEPS) - 1);
      sl.value = String(clampStep(wxStep));
    }
    const lab = $("wx-day-label");
    if (lab) lab.textContent = on ? stepLabel(clampStep(wxStep)) : "";
    if (on) buildTicks();
    const leg = $("wx-legend");
    if (leg) leg.innerHTML = legendHtml();
    const src = $("wx-src");
    if (src) {
      const modelBit = wxModel !== "best_match" ? " · 模式 " + MODEL_LABELS[wxModel] : "";
      src.textContent = !on ? "" :
        (mode === "warn"
          ? "预警来自中央气象台（实况）；色块为模式预报，仅供出行参考"
          : `预报 © Open-Meteo${modelBit} · 近72h逐小时+远期3h · 格点约1.5–2°，看趋势非点对点${grid && grid.fetchedAt ? " · 更新 " + new Date(grid.fetchedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }) : ""}${grid && grid.stale ? " · 陈旧缓存（上游暂时不可用）" : ""}`);
    }
    const play = $("wx-play");
    if (play) play.textContent = playing ? "❚❚" : "▶";
  }

  function redraw() {
    if (layer && layer.stepRedraw) layer.stepRedraw(); // 切帧/换模式：原地重绘，不闪
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
        if (!windLayer) windLayer = new WindParticles();
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
    // 空串是合法输入（清除"正在加载…"占位），不能按 falsy 过滤（视觉模型三轮观察项 #2）
    if (typeof setStatus === "function" && msg !== undefined && msg !== null) setStatus(msg, err);
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
      const max = (grid && grid.nSteps ? grid.nSteps : DEFAULT_STEPS) - 1;
      wxStep = wxStep >= max ? 0 : wxStep + 1;
      redraw();
    }, 700);
  }

  function setDay(off) {
    pendingTravelOff = Number(off) || 0;
    if (grid) wxStep = stepForTravelOff(pendingTravelOff);
    if (mode !== "off") redraw();
    else refreshChrome();
  }

  /* 全国图层模型切换：Windy 式"全图单模型、点位多模型"分工 */
  async function setGridModel(m) {
    if (!MODEL_LABELS[m] || m === wxModel) return;
    wxModel = m;
    try { localStorage.setItem("railWxModel", m); } catch (e) { /* ignore */ }
    const cached = gridByModel.get(m);
    if (cached) {
      grid = cached;
      wxStep = clampStep(stepForTravelOff(pendingTravelOff));
      redraw();
      return;
    }
    grid = null;
    gridPromise = null;
    refreshChrome();
    if (mode === "off") return;
    setStatusSafe("正在加载 " + MODEL_LABELS[m] + " 模式网格…");
    try {
      await ensureGrid();
      setStatusSafe("");
      redraw();
    } catch (e) {
      wxModel = "best_match";
      const fallback = gridByModel.get("best_match");
      if (fallback) { grid = fallback; redraw(); }
      setStatusSafe(MODEL_LABELS[m] + " 模式暂不可用：" + (e.message || e), true);
      const sel = $("wx-model");
      if (sel) sel.value = "best_match";
    }
  }

  function bindUi() {
    document.querySelectorAll('input[name="basemap"]').forEach((el) => {
      el.onchange = () => setBasemap(el.value);
    });
    document.querySelectorAll('input[name="wx"]').forEach((el) => {
      el.onchange = () => setMode(el.value);
    });
    const sl = $("wx-day");
    if (sl) sl.oninput = () => { wxStep = Number(sl.value) || 0; if (mode !== "off") redraw(); else refreshChrome(); };
    const play = $("wx-play");
    if (play) play.onclick = () => togglePlay();
    const msel = $("wx-model");
    if (msel) msel.onchange = () => setGridModel(msel.value);
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
    function withRetry(layer2) {
      layer2.on("tileerror", (e) => {
        const t = e.tile;
        if (!t || t.dataset.retried) return;
        t.dataset.retried = "1";
        const src = t.src;
        setTimeout(() => { if (t.parentNode) t.src = src + (src.includes("?") ? "&" : "?") + "r=" + Date.now(); }, 500);
      });
      return layer2;
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
    try { wxModel = localStorage.getItem("railWxModel") || "best_match"; } catch (e) { /* ignore */ }
    if (!MODEL_LABELS[wxModel]) wxModel = "best_match";
    const msel = $("wx-model");
    if (msel) msel.value = wxModel;
    refreshChrome();
    // 恢复上次会话的天气图层选择
    let savedMode = "off";
    try { savedMode = localStorage.getItem("railWxMode") || "off"; } catch (e) { /* ignore */ }
    if (savedMode !== "off" && ["rain", "temp", "wind", "warn"].includes(savedMode)) {
      const r = document.querySelector(`input[name="wx"][value="${savedMode}"]`);
      if (r) r.checked = true;
      setMode(savedMode);
    }
  }

  /* 开机后台预取：格点+预警在页面空闲时拉好，用户首次开图层零等待。
   * 静默失败——预取是优化不是依赖，失败回落到开图层时的正常加载路径。 */
  async function prefetch() {
    try { await ensureGrid(); } catch (e) { /* 开图层时再试 */ }
    try { await loadAlarms(); } catch (e) { /* 同上 */ }
  }

  return { init, setDay, setMode, setBasemap, setGridModel, pointChart, arrivalWx, prefetch };
})();
