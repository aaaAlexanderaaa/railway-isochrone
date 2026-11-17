/* 铁路可达圈 前端 */
"use strict";

/* ================= 工具 ================= */
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, "0");
function fmtHM(m) { // 绝对分钟(相对出发日00:00) -> HH:MM / 次日HH:MM
  const day = Math.floor(m / 1440);
  const hm = `${pad2(Math.floor(m / 60) % 24)}:${pad2(Math.round(m % 60))}`;
  return day === 0 ? hm : day === 1 ? `次日${hm}` : `第${day + 1}天${hm}`;
}
function fmtDur(min) {
  min = Math.round(min);
  return min < 60 ? `${min}分` : `${Math.floor(min / 60)}h${pad2(min % 60)}`;
}
function fmtClock(m) { return `${pad2(Math.floor(m / 60) % 24)}:${pad2(Math.round(m % 60))}`; }
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const CN_TZ = "Asia/Shanghai";
// 产品时钟 = 北京时间。浏览器在 UTC/海外时，「今天」仍应对齐中国铁路运营日。
function chinaParts(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CN_TZ, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).formatToParts(date || new Date());
  const g = (t) => {
    const x = parts.find((p) => p.type === t);
    return x ? Number(x.value) : 0;
  };
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour"), min: g("minute") };
}
function chinaYmdStr(date) {
  const p = chinaParts(date);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}
function chinaMidnightMs(date) {
  return Date.parse(chinaYmdStr(date) + "T00:00:00+08:00");
}
function chinaNowMin() {
  const p = chinaParts();
  return p.h * 60 + p.min;
}
function nowAbsMin() {
  return Math.floor((Date.now() - state.anchor.getTime()) / 60000);
}
function chinaOffParts(off) {
  const t = state.anchor.getTime() + (Number(off) || 0) * 86400000;
  const p = chinaParts(new Date(t));
  p.wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return p;
}
// 绝对分钟(相对北京时间今天00:00, 已含日期偏移) -> 日期感知文本
function fmtAbs(m) {
  const day = Math.floor(m / 1440);
  const hm = fmtClock(m);
  const p = chinaOffParts(day);
  return `${p.m}/${p.d}(${WEEKDAYS[p.wd]}) ${hm}`;
}
function anchorDateStr(off) {
  const p = chinaOffParts(off);
  return `${p.m}/${p.d} ${WEEKDAYS[p.wd]}`;
}

/* WGS84 -> GCJ02 (高德瓦片坐标系) */
const EA = 6378245.0, EE = 0.00669342162296594323;
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return r;
}
function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return r;
}
function wgs2gcj(lat, lng) {
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lat, lng];
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / ((EA * (1 - EE)) / (magic * sq) * Math.PI);
  dLng = (dLng * 180) / (EA / sq * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

/* ================= 全局状态 ================= */
let STATIONS = [], NAMES = [], META = {};
let cityIndex = []; // {name, stops, degree}
let state = {
  origin: null,            // {name, stops:[], city}
  dateOff: 0, fromMin: 8 * 60, untilMin: 22 * 60,
  bmin: 0, bmax: 240,
  cls: "all", maxTra: 2,
  arriveBy: null,          // 最晚到达(绝对分钟, 相对出发日00:00), null=不过滤
  constraint: { on: false, name: null, stops: [], dateOff: 1, timeMin: null, only: false, dur: 0, xf: -1, cls: "all", tFromMin: null, stayMin: 0 },
  shortlist: loadShortlist(),
  colorBy: "typ",
  journeys: new Map(),     // stop -> [[dep,arr,j,ft,st,os],...]
  stats: new Map(),        // stop -> {typ,fast,p90,cnt,dir,lastDep}
  conLabel: null,          // stop -> latest abs min
  selected: null,
  queried: false,
};

/* ================= 地图 ================= */
// 配色固定为「绿快红慢」（2026-09-21 用户决定）：快=绿、慢=红，不再提供配色选择
const RAMP = ["#166534", "#15803d", "#65a30d", "#eab308", "#f97316", "#dc2626", "#7f1d1d"];
const TRA_COLOR = ["#2563eb", "#f59e0b", "#ef4444"];
function colorTyp(t) { const h = t / 60; return RAMP[h < 1 ? 0 : h < 2 ? 1 : h < 3 ? 2 : h < 4 ? 3 : h < 5 ? 4 : h < 6 ? 5 : 6]; }
function isLightColor(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 175;
}
function colorCnt(c) { return RAMP[c < 2 ? 0 : c < 5 ? 1 : c < 10 ? 2 : c < 20 ? 3 : c < 40 ? 4 : c < 80 ? 5 : 6]; }

const map = L.map("map", { preferCanvas: true, zoomControl: true, minZoom: 4, maxZoom: 17 }).setView(wgs2gcj(34.5, 108.5), 5);
L.control.scale({ imperial: false }).addTo(map);
// marker 的 canvas 命中处理器先于 map click 到达（DOM 冒泡顺序）；
// 记录时间戳，让空白兜底不覆盖已命中的精确选择
let lastLayerClickTs = 0;
map.on("click", (e) => {
  if (!STATIONS.length) return;
  const t = e.originalEvent && e.originalEvent.target;
  if (t && t.closest && t.closest("#map-layers, #legend-wrap, #wx-timeline, #list-panel, .leaflet-control")) return;
  if (Date.now() - lastLayerClickTs < 80) return;
  let best = -1, bestD = state.origin ? 26 : 36;
  const p = e.containerPoint;
  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i];
    if (!s || !s.d) continue;
    const [la, lo] = wgs2gcj(s.la, s.lo);
    const d = p.distanceTo(map.latLngToContainerPoint([la, lo]));
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return;
  if (!state.origin && originCombo) { onStationClick(best); return; }
  // 查询后点在圆点附近但没命中 canvas 容差（有效半径仅半径+10.8px，视觉上"点在点上"
  // 常落在死区，2026-09-23/24 用户连续反馈"点不动"）：按最近站给出反馈而非无响应
  if (state.queried) onStationClick(best);
});

const sharedRenderer = L.canvas({ padding: 0.5, tolerance: 10 }); // 灰点半径很小，扩大点击容差

const layerGray = L.layerGroup().addTo(map);      // 全部车站(灰)
const layerNear = L.layerGroup().addTo(map);      // 可达但低于预算下限
const layerBand = L.layerGroup().addTo(map);      // 预算带内(彩色)
const layerDim = L.layerGroup().addTo(map);       // 不满足约束(淡化)
const layerOrigin = L.layerGroup().addTo(map);
const layerLabels = L.layerGroup().addTo(map);
let selectedRing = null;

function mkMarker(s, radius, color, opacity, weight, stroke) {
  const [la, lo] = wgs2gcj(s.la, s.lo);
  return L.circleMarker([la, lo], {
    renderer: sharedRenderer, radius, color: stroke || "#333", weight: weight || 0.6,
    fillColor: color, fillOpacity: opacity == null ? 0.92 : opacity,
  });
}

function buildGrayLayer() {
  layerGray.clearLayers();
  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i];
    const m = mkMarker(s, 3.2, "#9aa7b4", 0.55, 0);
    m.bindTooltip(`${s.n}`, { className: "stn-tip", direction: "top" });
    m.on("click", () => { lastLayerClickTs = Date.now(); onStationClick(i); });
    layerGray.addLayer(m);
  }
}

function tipText(i) {
  const s = STATIONS[i], st = state.stats.get(i);
  if (!st) return `<b>${s.n}</b>（${s.c}）`;
  return `<b>${s.n}</b>（${s.c}）<br>典型 ${fmtDur(st.typ)} · 方案 ${st.cnt} · 直达 ${st.dir}`;
}

let originCombo = null;
let queryGen = 0;
function stopToComboItem(i) {
  const s = STATIONS[i];
  const city = cityIndex.find((c) => c.name === s.c);
  if (city) return { type: "city", name: city.name, stops: city.stops.slice(), degree: city.degree };
  return { type: "stn", name: s.n, stops: [i], degree: s.d };
}
function onStationClick(i) {
  if (!state.origin && originCombo) {
    originCombo.pick(stopToComboItem(i));
    setStatus(`已把出发地设为「${STATIONS[i].c || STATIONS[i].n}」。选好看时间预算后点「查询可达性」。`);
    return;
  }
  if (state.stats.has(i)) selectDestination(i);
  else {
    const s = STATIONS[i];
    setStatus(`「${s.n}」在当前查询条件下不可达（时段、车种或换乘上限内没有可行方案）。`);
    if (state.queried) selectDestination(i, true);
  }
}

function refreshLabels() {
  layerLabels.clearLayers();
  const z = map.getZoom();
  const th = z >= 9 ? 90 : z >= 8 ? 130 : z >= 7 ? 200 : z >= 6 ? 280 : 360;
  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i];
    if (s.d < th) continue;
    // 查询后只标注入选列表的车站(带内/更快区), 避免带外大城市名造成干扰
    if (state.queried && state.origin && s.c !== state.origin.city) {
      const st = state.stats.get(i);
      if (!st || st.typ < 30 || (!inBandQ(st) && st.typ >= state.bmin)) continue;
    }
    const [la, lo] = wgs2gcj(s.la, s.lo);
    L.marker([la, lo], {
      icon: L.divIcon({ className: "lbl-zero", html: "", iconSize: [0, 0] }),
      interactive: false,
    }).addTo(layerLabels)
      .bindTooltip(s.n, { permanent: true, direction: "right", className: "stn-label" });
  }
}
map.on("zoomend", refreshLabels);

// 悬停可点站点时光标变手形：圆点是 canvas 画的没有 DOM hover，用户缺"可点"暗示，
// 只见 Leaflet 默认抓取手形、点击又常落在圆点外的空白上（2026-09-22 用户反馈）
let hoverPts = [];
function rebuildHoverPts() {
  hoverPts = [];
  const size = map.getSize();
  for (let i = 0; i < STATIONS.length; i++) {
    const s = STATIONS[i];
    if (!s || !s.d) continue;
    const [la, lo] = wgs2gcj(s.la, s.lo);
    const p = map.latLngToContainerPoint([la, lo]);
    if (p.x > -40 && p.y > -40 && p.x < size.x + 40 && p.y < size.y + 40) hoverPts.push(p);
  }
}
map.on("moveend zoomend resize", rebuildHoverPts);
let hoverRaf = 0;
map.on("mousemove", (e) => {
  const p = { x: e.containerPoint.x, y: e.containerPoint.y };
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    let hit = false;
    for (const q of hoverPts) {
      const dx = q.x - p.x, dy = q.y - p.y;
      if (dx * dx + dy * dy < 196) { hit = true; break; } // 14px：贴近圆点实际可点范围（半径+canvas容差），36px 在密集区会满屏手形
    }
    const el = map.getContainer();
    if (el) el.style.cursor = hit ? "pointer" : "";
  });
});

function abandonQuery() {
  DetailSession.select();
  queryGen++;
  state.queried = false;
  state.journeys = new Map();
  state.stats = new Map();
  state.conLabel = null;
  state.selected = null;
  Views.clearResults();
  layerBand.clearLayers(); layerNear.clearLayers(); layerDim.clearLayers();
  $("legend-wrap").classList.add("hidden");
  $("list-panel").classList.add("hidden");
  $("btn-table").classList.add("hidden");
  renderShortlist();
  const det = $("detail"); if (det) det.classList.add("hidden");
}

function renderMapResult() {
  const meetup = Views.active().some(v => v.dir === "dep");
  layerBand.clearLayers(); layerNear.clearLayers(); layerDim.clearLayers();
  const con = state.constraint.on && state.constraint.name && state.conLabel;
  const marks = [];
  for (const [stopI, st] of state.stats) {
    if (!meetup && state.origin && STATIONS[stopI].c === state.origin.city) continue;
    const s = STATIONS[stopI];
    const inBand = inBandQ(st);
    const color = state.colorBy === "typ" ? colorTyp(st.typ) : colorCnt(st.cnt);
    let m;
    const conFail = con && state.constraint.only && !conOK(stopI);
    if (!inBand || conFail) {
      if (!conFail && st.typ < state.bmin) m = mkMarker(s, 4.2, "rgba(0,0,0,0)", 0, 1.7, "#5a7a94"); // 低于预算下限的近处站(空心环)
      else continue; // 无带内方案、或已按约束过滤掉的: 不画, 保持地图与列表一致
    } else {
      const r = Math.min(4 + Math.sqrt(st.cnt) * 1.15, 11);
      // 浅色配色下加粗描边, 防止圆点"消失"在底图上
      const isLight = isLightColor(color);
      m = mkMarker(s, r, color, 0.95, isLight ? 1.6 : 1.1, isLight ? "#3d4a56" : "#2b2b2b");
    }
    m.bindTooltip(() => tipText(stopI), { className: "stn-tip", direction: "top" });
    m.on("click", () => { lastLayerClickTs = Date.now(); onStationClick(stopI); });
    (inBand ? layerBand : layerNear).addLayer(m);
    if (inBand) marks.push(m);
  }
  if (marks.length) {
    const g = L.featureGroup(marks);
    try { map.fitBounds(g.getBounds().pad(0.08)); } catch (e) { /* ignore */ }
  }
  Views.renderOverlay(); // 附加圈散点 + 交集城市标记
}

function renderOrigin() {
  layerOrigin.clearLayers();
  if (!state.origin) return;
  // 城市内所有站都标出，主站高亮
  let main = state.origin.stops[0];
  for (const s of state.origin.stops) if (STATIONS[s].d > STATIONS[main].d) main = s;
  for (const s of state.origin.stops) {
    const st = STATIONS[s];
    const m = mkMarker(st, 7, "#111318", 1, 2.5, "#ffffff");
    m.bindTooltip(`出发：${state.origin.name} · ${st.n}`, { className: "stn-tip", direction: "top" });
    layerOrigin.addLayer(m);
  }
  const [la, lo] = wgs2gcj(STATIONS[main].la, STATIONS[main].lo);
  L.marker([la, lo], { icon: L.divIcon({ className: "lbl-zero", html: "", iconSize: [0, 0] }), interactive: false })
    .addTo(layerOrigin)
    .bindTooltip(`出发 · ${state.origin.name}`, { permanent: true, direction: "right", className: "stn-label" });
}

/* ================= 搜索下拉 ================= */
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
function originAnchor() {
  if (!state.origin || !state.origin.stops || !state.origin.stops.length) return null;
  let main = state.origin.stops[0];
  for (const s of state.origin.stops) if (STATIONS[s].d > STATIONS[main].d) main = s;
  const st = STATIONS[main];
  return { la: st.la, lo: st.lo, prov: st.p, main };
}
function fillDates() {
  const ds = $("date-sel");
  const names = ["今天", "明天", "后天"];
  for (let i = 0; i < 14; i++) {
    const lbl = `${i < 3 ? names[i] + " " : ""}${anchorDateStr(i)}`;
    ds.add(new Option(lbl, String(i)));
  }
  ds.value = "0";
  state.dateOff = 0;
}
// 城市内车站多选: 勾选实际会用的车站
function renderStationChecks(containerId, holder, onChange) {
  const el = $(containerId);
  if (!holder.allStops || holder.allStops.length < 2) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  el.classList.remove("hidden");
  const render = () => {
    el.innerHTML = holder.allStops.map((sIdx) => {
      const on = holder.stops.includes(sIdx);
      const st = STATIONS[sIdx];
      return `<label class="${on ? "" : "off"}" title="${st.p || ""}"><input type="checkbox" data-s="${sIdx}" ${on ? "checked" : ""}>${st.n} <span class="mini">${st.d}班</span></label>`;
    }).join("");
    [...el.querySelectorAll("input")].forEach((cb) => {
      cb.onchange = () => {
        const sIdx = Number(cb.dataset.s);
        holder.stops = holder.allStops.filter((x) => (x === sIdx ? cb.checked : holder.stops.includes(x)));
        if (!holder.stops.length) holder.stops = holder.allStops.slice(); // 至少保留一个
        render();
        onChange();
      };
    });
  };
  render();
}

function buildCityIndex() {
  const m = new Map();
  STATIONS.forEach((s, i) => {
    if (!m.has(s.c)) m.set(s.c, { name: s.c, stops: [], degree: 0 });
    const e = m.get(s.c);
    e.stops.push(i); e.degree += s.d;
  });
  cityIndex = Array.from(m.values()).filter((c) => c.degree > 0).sort((a, b) => b.degree - a.degree);
}

function attachCombo(inputId, dropId, chosenId, onPick) {
  const input = $(inputId), drop = $(dropId), chosen = $(chosenId);
  let items = [], active = -1;
  function render(list) {
    items = list; active = -1;
    if (!list.length) { drop.classList.add("hidden"); return; }
    drop.innerHTML = list.map((it, i) => `
      <div class="item" data-i="${i}">
        <span class="nm">${it.type === "city" ? `${it.name}` : `${it.name}`}</span>
        <span class="mt">${it.type === "city" ? `${it.stops.length} 个车站 · ${it.degree} 班/日` : `车站 · ${it.degree} 班/日`}</span>
      </div>`).join("");
    drop.classList.remove("hidden");
  }
  function search(q) {
    q = q.trim();
    if (!q) { render(cityIndex.slice(0, 10).map((c) => ({ type: "city", ...c }))); return; }
    const rank = (name) => name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 9;
    const cs = cityIndex.filter((c) => c.name.includes(q))
      .sort((a, b) => rank(a.name) - rank(b.name) || b.degree - a.degree)
      .slice(0, 8)
      .map((c) => ({ type: "city", ...c }));
    const ss = STATIONS.map((s, i) => ({ i, ...s })).filter((s) => s.n.includes(q) && s.d > 0)
      .sort((a, b) => rank(a.n) - rank(b.n) || b.d - a.d).slice(0, 10 - Math.min(cs.length, 5))
      .map((s) => ({ type: "stn", name: s.n, stops: [s.i], degree: s.d }));
    render([...cs, ...ss]);
  }
  let searchTimer = null;
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(input.value), 120);
  });
  input.addEventListener("focus", () => { input.select(); search(input.value); });
  // 失焦时若输入恰为某城市/车站名, 自动生效, 避免"输入了但没选上"的状态
  input.addEventListener("blur", () => {
    setTimeout(() => {
      if (chosen.classList.contains("hidden")) {
        const q = input.value.trim();
        if (!q) return;
        const city = cityIndex.find((c) => c.name === q);
        const stn = !city ? STATIONS.map((s, i) => ({ i, ...s })).find((s) => s.n === q && s.d > 0) : null;
        if (city) pick({ type: "city", ...city });
        else if (stn) pick({ type: "stn", name: stn.n, stops: [stn.i], degree: stn.d });
      }
    }, 160);
  });
  input.addEventListener("keydown", (e) => {
    if (drop.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); }
    else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); }
    else if (e.key === "Enter" && active >= 0) { pick(items[active]); e.preventDefault(); return; }
    else if (e.key === "Escape") { drop.classList.add("hidden"); return; }
    else return;
    [...drop.children].forEach((el, i) => el.classList.toggle("active", i === active));
    e.preventDefault();
  });
  let lastPickTs = 0;
  drop.addEventListener("mousedown", (e) => {
    const it = e.target.closest(".item");
    if (it) { lastPickTs = Date.now(); pick(items[Number(it.dataset.i)]); }
  });
  drop.addEventListener("click", (e) => {
    const it = e.target.closest(".item");
    if (it && Date.now() - lastPickTs > 400) pick(items[Number(it.dataset.i)]); // 兼容纯 click 事件
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(`#${inputId}`) && !e.target.closest(`#${dropId}`)) drop.classList.add("hidden");
  });
  function pick(it) {
    if (!it) return;
    drop.classList.add("hidden");
    input.value = it.name;
    input.classList.add("hidden");
    chosen.classList.remove("hidden");
    chosen.innerHTML = `<span>${it.type === "city" ? `${it.name}（${it.stops.length} 站：${it.stops.slice(0, 4).map((s) => STATIONS[s].n).join("、")}${it.stops.length > 4 ? "…" : ""}）` : it.name}</span><button type="button" title="重选">✕</button>`;
    chosen.querySelector("button").onclick = () => {
      chosen.classList.add("hidden"); input.classList.remove("hidden"); input.value = ""; input.focus();
      onPick(null);
    };
    onPick(it);
  }
  return { pick };
}

/* ================= 统计 ================= */
function computeStats() {
  state.stats.clear();
  const opt = {from: state.dateOff * 1440 + state.fromMin, until: state.dateOff * 1440 + state.untilMin,
    bmax: state.bmax, maxTra: state.maxTra, arriveBy: state.arriveBy,
    now: state.dateOff === 0 ? nowAbsMin() : null};
  for (const [stopI, js] of state.journeys) {
    const stats = JourneyStats.summarize(js, opt);
    if (stats) state.stats.set(stopI, stats);
  }
  if (state.origin && Views.active().some(v => v.dir === "dep")) {
    for (const i of state.origin.stops) state.stats.set(i, JourneyStats.atOrigin(opt.from));
  }
}

function constraintByText() {
  const c = state.constraint;
  if (!c || !c.name) return "";
  return c.timeMin == null ? `${anchorDateStr(c.dateOff)}当天内` : `${anchorDateStr(c.dateOff)} ${fmtClock(c.timeMin)} 前`;
}
function originToDestHint() {
  const destName = state.constraint && state.constraint.name;
  if (!destName || !state.origin) return "";
  let best = null;
  for (const [stopI, st] of state.stats) {
    if (STATIONS[stopI].c !== destName) continue;
    if (!best || st.fast < best.fast) best = st;
  }
  if (best) return ` 从「${state.origin.city}」到「${destName}」本身最快约 ${fmtDur(best.fast)}。`;
  return ` 当前出发时段内，「${state.origin.city}」到不了「${destName}」本身（超出预算或无班次）。`;
}
function conAbs() {
  const c = state.constraint;
  return c.dateOff * 1440 + (c.timeMin == null ? 1439 : c.timeMin); // 留空 = 当天不限
}
function conFloor() {
  const c = state.constraint;
  return c.tFromMin == null ? 0 : c.dateOff * 1440 + c.tFromMin;
}
// 入带判定使用用户选择的完整区间；低于下限的选择由独立开关显示。
function inBandQ(st) {
  return st.local || st.typ >= state.bmin && st.typ <= state.bmax;
}
// 查询时段右边界(绝对分钟)
function d1Abs() {
  return state.dateOff * 1440 + state.untilMin;
}
function conOK(stopI) {
  const v = state.conLabel ? state.conLabel[stopI] : undefined;
  if (v == null || v < 0) return false;
  const st = state.stats.get(stopI);
  if (st && st.firstArr != null && v <= st.firstArr) return false; // 到达前就得返程 = 不可行
  return true;
}
function cityStay(conMax, stopI) {
  const st = state.stats.get(stopI);
  if (st == null || st.firstArr == null || conMax == null) return null;
  return conMax - st.firstArr;
}
function conTagByMax(conMax, stayMin) {
  if (conMax == null || conMax < 0) return { cls: "bad", txt: "不可行" };
  if (stayMin != null && stayMin <= 0) return { cls: "bad", txt: "不可行（返程发车早于最早到达）" };
  const dt = anchorDateStr(Math.floor(conMax / 1440));
  const base = `最晚 ${dt} ${fmtClock(conMax)} 走`;
  if (stayMin != null && stayMin < 120) return { cls: "warn", txt: `${base} · 在地仅${fmtDur(stayMin)}` };
  return { cls: "ok", txt: base + (stayMin != null ? ` · 在地最多${fmtDur(stayMin)}` : "") };
}
function conTag(stopI) {
  return conTagByMax(conMaxOf(stopI), cityStay(conMaxOf(stopI), stopI));
}
function conMaxOf(stopI) {
  return state.conLabel ? state.conLabel[stopI] : undefined;
}

/* ================= 查询 ================= */
function setStatus(msg, err) {
  const el = $("status");
  el.textContent = msg || "";
  el.classList.toggle("err", !!err);
}

function timeToMin(v) {
  if (!v) return null;
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
}
const END_OF_DAY = 23 * 60 + 59; // <input type=time> 上限 23:59

/* 浏览器 Worker 优先（Cloudflare Pages 无 Node）；失败时回退本机 /api */
const initEngine = () => RailAPI.boot();
const api = (url) => RailAPI.query(url);

function checkRailDay() {
  if (state.anchor && state.anchor.getTime() !== chinaMidnightMs()) {
    DataStatus.newDay();
    $("btn-query").disabled = true;
    return false;
  }
  return true;
}
async function runQuery() {
  if (!checkRailDay()) return;
  if (!state.origin) { setStatus("请先选择出发地（左侧第①步）。", true); return; }
  const btn = $("btn-query");
  btn.disabled = true;
  const gen = ++queryGen;
  setStatus("计算中…（引擎对全天时刻表做轮廓搜索，约 1–2 秒）");
  try {
    state.anchor = state.anchor || new Date(chinaMidnightMs());
    const arriveField = timeToMin($("arrive-by").value);
    if (arriveField == null) {
      // 晚间出发默认不把凌晨才到的方案算进去；不写入输入框，以免被看成「必须 02:00 赶到」。
      if (state.dateOff === 0 && state.fromMin >= 16 * 60) state.arriveBy = 1440 + 2 * 60;
      else state.arriveBy = null;
    } else {
      state.arriveBy = state.dateOff * 1440 + arriveField;
    }
    const o = state.origin.stops.join(",");
    const f = state.dateOff * 1440 + state.fromMin;
    const t = state.dateOff * 1440 + state.untilMin;
    if (t <= f) throw new Error("出发时段无效：结束时间需晚于开始时间");
    const data = await api(`/api/reach?o=${o}&f=${f}&t=${t}&cls=${state.cls}`);
    if (gen !== queryGen) return;
    state.journeys = new Map(data.journeys);
    computeStats();
    state.queried = true;
    state.everQueried = true; // 清除出发地会复位 queried；换源后仍应自动重查（round-27 #1）

    // 附加等时圈视图（出发/抵达）逐一取数，随后城市级取交集；
    // 恰好一个抵达视图时 Views 会镜像回 state.constraint/conLabel（旧「必须赶到」链路）
    await Views.runAll(gen);
    if (gen !== queryGen) return;

    if (state.conLabel && !$("sort-sel").dataset.touched) $("sort-sel").value = "con";
    renderMapResult();
    renderOrigin();
    renderList();
    updateLegend();
    refreshLabels();
    if (state.selected != null) selectDestination(state.selected, true); // 重查后刷新已打开的详情
    syncStatusLine((data.stats.ms || 0));
    loadDepartures(f);
  } catch (err) {
    if (gen !== queryGen) return;
    setStatus(`查询失败：${err.message}`, true);
  } finally {
    if (gen === queryGen) btn.disabled = false;
  }
}

// 状态行按当前过滤口径刷新：换乘/到站/预算/只看约束等即时过滤后必须重算，
// 否则头条数字停留在上一次完整查询，与表格口径脱节（round-20 验收问题）
function syncStatusLine(engineMs) {
  const bandRows = cityRows();
  const nCities = bandRows.length;
  const nStops = bandRows.reduce((acc, r) => acc + [...state.stats.keys()].filter((k) => STATIONS[k].c === STATIONS[r.stopI].c && state.stats.get(k).typ >= 30).length, 0);
  const nowM = nowAbsMin();
  const nowTxt = state.dateOff === 0 ? ` · 现在 ${fmtClock(nowM)}` : "";
  const pastWarn = state.dateOff === 0 && state.fromMin < nowM - 2 ? ` · 已自动从现在 ${fmtClock(nowM)} 起算（你设的时段起点更早，其间班次已发车不计）` : "";
  const destName = state.constraint.on && state.constraint.name ? state.constraint.name : null;
  const onlyOn = !!(destName && state.constraint.only);
  const byText = destName ? constraintByText() : "";
  const engineBit = engineMs != null ? ` · 引擎 ${(engineMs / 1000).toFixed(1)}s` : "";
  const interOn = Views.intersectOn() && Views.anyActive();
  const mainBandCities = cityRows(true).length;
  if (nCities === 0 && onlyOn) {
    setStatus(`从「${state.origin.city}」出发、预算带内没有城市还能在 ${byText}赶到「${destName}」。这是约束下的空结果，不是查询失败。可放宽单程时长/换乘，或取消「只看还能赶到该城市」。${originToDestHint()}${engineBit}`, true);
  } else if (nCities === 0 && interOn) {
    const nViews = Views.active().length + 1;
    const bad = Views.active().filter((v) => { const r = Views.results.get(v.id); return r && r.error; });
    const nm = Views.nearMiss || [];
    const nmBit = nm.length
      ? `最接近的：${nm.map((m) => `「${m.city}」距 ${m.view.dir === "arr" ? "赶到 " + m.view.name : m.view.name + " 出发"}的圈仅超 ${fmtDur(m.over)}`).join("；")}——跟朋友商量一下这几分钟/小时，可能就解了。`
      : "";
    setStatus(bad.length
      ? `有 ${bad.length} 个圈没算成（${bad.map((v) => v.name).join("、")}，见卡片状态），交集暂不可信。请修正后重查。${engineBit}`
      : `主查询与 ${nViews - 1} 个附加圈的交集为空（主圈带内 ${mainBandCities} 城，没有所有人都满足条件的共同城市）。${nmBit}也可放宽某个圈的预算/时段/换乘，或取消勾选「只看交集」。${engineBit}`, true);
  } else if (nStops === 0) {
    setStatus("当前条件下时间预算带内没有可达目的地。可放宽预算/时段，或切换到明天全天。", true);
  } else {
    let destBit;
    if (destName) destBit = onlyOn ? ` · 还能赶到「${destName}」${nCities} 城` : ` · 已加载赶到「${destName}」的可行性（见列表「后续约束」）`;
    else if (interOn) destBit = ""; // bandBit 已含交集信息
    else if (Views.anyActive()) destBit = Views.summaryText();
    else destBit = " · 叠加别的出发地/必须抵达圈并取交集？见左侧②";
    const bandBit = interOn
      ? `去程预算内 ${mainBandCities} 城 → 同时满足全部条件 ${nCities} 城（${nStops} 站，地图 ⊕ 白点）`
      : `预算带内 ${onlyOn && state.rowTotal != null ? state.rowTotal : nCities} 城（${nStops} 站）`;
    setStatus(`✓ 今天是 ${anchorDateStr(0)}${nowTxt} · 查询 ${anchorDateStr(state.dateOff)} ${fmtClock(state.dateOff * 1440 + state.fromMin)}–${fmtClock(state.dateOff * 1440 + state.untilMin)} · ${bandBit}${pastWarn}${destBit}${engineBit}`);
  }
}

async function loadDepartures(fromAbs) {
  if (!state.origin) return;
  try {
    const f2 = state.dateOff === 0 ? Math.max(fromAbs, nowAbsMin()) : fromAbs;
    // 合并同城各站的近期发车
    const all = [];
    for (const sIdx of state.origin.stops.slice(0, 10)) {
      const d = await api(`/api/departures?s=${sIdx}&f=${f2}&n=6&cls=${state.cls}`);
      d.list.forEach((x) => all.push({ ...x, st: sIdx }));
    }
    all.sort((a, b) => a.dep - b.dep);
    const box = $("dep-box");
    if (!all.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    $("dep-station").textContent = `${state.origin.name}（各站）`;
    let dh = "", lastSt = null;
    for (const x of all.slice(0, 10)) {
      if (x.st !== lastSt) { dh += `<div class="dep-st">从 ${STATIONS[x.st].n}</div>`; lastSt = x.st; }
      dh += `<div class="dep-row"><span class="dep-t">${fmtAbs(x.dep)}</span><span class="dep-trip">${x.trip}</span><span>→ ${STATIONS[x.terminal].n}</span></div>`;
    }
    $("dep-list").innerHTML = dh;
  } catch (e) { /* 静默 */ }
}

/* ================= 列表 ================= */
function cityRows(ignoreIntersection = false) {
  const meetup = Views.active().some(v => v.dir === "dep");
  const sizeTh = Number($("size-sel").value) || 0;
  const region = $("region-sel") ? $("region-sel").value : "all";
  const maxKm = $("maxkm-input") && $("maxkm-input").value ? Number($("maxkm-input").value) : 0;
  const oa = originAnchor();
  const byCity = new Map();
  for (const [stopI, st] of state.stats) {
    if (!meetup && state.origin && STATIONS[stopI].c === state.origin.city) continue;
    if (!inBandQ(st)) continue;
    if (sizeTh > 0 && STATIONS[stopI].d < sizeTh) continue;
    if (region !== "all" && oa && oa.prov) {
      const pv = STATIONS[stopI].p;
      if (region === "prov" && pv !== oa.prov) continue;
      if (region === "out" && pv === oa.prov) continue;
    }
    const km = oa ? haversineKm(oa.la, oa.lo, STATIONS[stopI].la, STATIONS[stopI].lo) : null;
    if (maxKm > 0 && km != null && km > maxKm) continue;
    if (!meetup && km != null && km < 25) continue; // 距出发地 <25km 的近郊/同名城区不算"换个城市"（round-20 #8），地图上仍如实画点
    const c = STATIONS[stopI].c;
    const row = { stopI, st, km, prov: STATIONS[stopI].p };
    if (!byCity.has(c)) byCity.set(c, row);
    else {
      const cur = byCity.get(c);
      // 代表站: 典型耗时最短; ±15 分钟带内取"当前过滤口径下直达多、方案多"的站。
      // 此前按全天班次规模(d)平手，"仅直达"下会把青岛锚到直达很少的机场站（round-20 #2）
      if (st.typ < cur.st.typ - 15) byCity.set(c, row);
      else if (st.typ <= cur.st.typ + 15) {
        const better = ((st.dir || 0) - (cur.st.dir || 0)) || ((st.cnt || 0) - (cur.st.cnt || 0));
        if (better > 0) byCity.set(c, row);
      }
    }
  }
  let rows = Array.from(byCity.values());
  // "30 分钟通勤距离"按城市级判定：全市最优站 <30 分钟才算太近（round-25 #2）。
  // 此前站级过滤把无锡站(15分)剔掉、让 68 分的无锡新区当代表，严重误导横向比较
  if (!meetup) rows = rows.filter((r) => r.st.typ >= 30);
  // 城市级约束: 取同城各站"最晚可行出发"的最大值(同城内可乘地铁移动)
  for (const r of rows) {
    const c = STATIONS[r.stopI].c;
    r.conMax = -1; r.conStop = null; r.firstArr = null;
    r.cityBestTyp = null; r.cityBestStop = null; // 同城各站典型耗时最优（round-24 #3：主档站口径会掩盖同城快站）
    for (const [stopI, st2] of state.stats) {
      if (STATIONS[stopI].c !== c) continue; // 同城全部可达站(不限带内), 与详情口径一致
      if (r.firstArr == null || st2.firstArr < r.firstArr) r.firstArr = st2.firstArr;
      if (st2.typ >= 30 && (r.cityBestTyp == null || st2.typ < r.cityBestTyp)) { r.cityBestTyp = st2.typ; r.cityBestStop = stopI; }
      const v = state.conLabel ? state.conLabel[stopI] : -1;
      if (v != null && v > r.conMax) { r.conMax = v; r.conStop = stopI; r.conArr = state.conArr ? state.conArr[stopI] : null; }
    }
  }
    state.rowTotal = rows.length; // 勾选"只看满足约束/交集"前的总数, 供标题对比
  // 多圈交集模式：主视图行集 ∩ 附加视图城市集（2026-09-24 等时圈改造）。
  // 放在 rowTotal 之后，保持"勾选前总数"语义
  if (!ignoreIntersection && Views.intersectOn() && Views.intersect) {
    rows = rows.filter((r) => Views.intersect.has(STATIONS[r.stopI].c));
  }
  const stayTh = state.constraint.on && state.constraint.name ? state.constraint.stayMin : 0;
  if (!ignoreIntersection && stayTh > 0) rows = rows.filter((r) => r.conMax >= 0 && r.firstArr != null && r.conMax - r.firstArr >= stayTh);
  if (!ignoreIntersection && state.constraint.on && state.constraint.name && state.constraint.only) {
    rows = rows.filter((r) => r.conMax != null && r.conMax >= 0 && (r.firstArr == null || r.conMax > r.firstArr));
  }
  const sort = $("sort-sel").value;
  const conOn = state.constraint.on && state.constraint.name;
  rows.sort((a, b) => {
    if (sort === "typ") return a.st.typ - b.st.typ;
    if (sort === "dist") return (a.km ?? 1e9) - (b.km ?? 1e9);
    if (sort === "fast") return a.st.fast - b.st.fast;
    if (sort === "cnt") return b.st.cnt - a.st.cnt;
    if (sort === "dir") return b.st.dir - a.st.dir;
    if (sort === "con") {
      if (!conOn) return a.st.typ - b.st.typ;
      const key = (r) => (r.conMax != null && r.conMax >= 0 && (r.firstArr == null || r.conMax > r.firstArr)) ? r.conMax : -1e9;
      return key(b) - key(a);
    }
    return 0;
  });
  return rows;
}

function renderList() {
  const meetup = Views.active().some(v => v.dir === "dep");
  const rows = cityRows();
  // 表格已降级：默认收起，由「全部目的地表格」按需展开；内容仍照常填充
  const btnTable = $("btn-table");
  if (btnTable) btnTable.classList.remove("hidden");
  const conOn = state.constraint.on && state.constraint.name;
  const sizeTh = Number($("size-sel").value) || 0;
  const region = $("region-sel") ? $("region-sel").value : "all";
  const maxKm = $("maxkm-input") && $("maxkm-input").value ? Number($("maxkm-input").value) : 0;
  const oa = originAnchor();
  const total = rows.length;
  const onlyOn = conOn && state.constraint.only;
  const destName = conOn ? state.constraint.name : "";
  const interBit = Views.intersectOn() && Views.intersect ? ` · ⊕ 满足全部条件` : "";
  $("list-title").textContent = `预算带 ${fmtDur(state.bmin)}–${fmtDur(state.bmax)} 内${onlyOn && state.rowTotal != null ? ` ${state.rowTotal} 城` : ""}${onlyOn ? `，还能赶到「${destName}」${total} 城` : ` ${total} 城`}${interBit}${sizeTh > 0 ? " · 已按车站规模过滤" : ""}`;
  const max = 300;
  // 主表: 预算带内
  const mainRows = rows.slice(0, max).map((r) => rowHtml(r, conOn));
  // 附表: 更快到达(典型低于下限) —— 预算语义偏"上限"的用户不应漏掉这些选择；
  // 交集模式下主圈只认带内城市，此区与"只看交集"承诺矛盾，隐藏
  let fastRows = [];
  if (state.bmin > 0 && !Views.intersectOn() && $("show-faster").checked) {
    const below = new Map();
    for (const [stopI, st] of state.stats) {
      if (!meetup && state.origin && STATIONS[stopI].c === state.origin.city) continue;
      if (st.typ >= state.bmin || st.typ < 30) continue; // 30分钟内的市郊通勤站不算"旅行目的地"
      if (sizeTh > 0 && STATIONS[stopI].d < sizeTh) continue;
      // 与主表同口径: "更快到达"段也遵守 省内/省外 与里程上限筛选
      if (region !== "all" && oa && oa.prov) {
        const pv = STATIONS[stopI].p;
        if (region === "prov" && pv !== oa.prov) continue;
        if (region === "out" && pv === oa.prov) continue;
      }
      const kmF = oa ? haversineKm(oa.la, oa.lo, STATIONS[stopI].la, STATIONS[stopI].lo) : null;
      if (maxKm > 0 && kmF != null && kmF > maxKm) continue;
      const c = STATIONS[stopI].c;
      if (!below.has(c)) below.set(c, { stopI, st });
      else {
        const cur = below.get(c);
        if (st.typ < cur.st.typ - 15) below.set(c, { stopI, st });
        else if (st.typ <= cur.st.typ + 15 && STATIONS[stopI].d > STATIONS[cur.stopI].d) below.set(c, { stopI, st });
      }
    }
    let list = Array.from(below.values());
    for (const r of list) {
      r.conMax = -1; r.conStop = null; r.firstArr = null;
      for (const [stopI, st2] of state.stats) {
        if (STATIONS[stopI].c !== STATIONS[r.stopI].c) continue;
        if (r.firstArr == null || st2.firstArr < r.firstArr) r.firstArr = st2.firstArr;
        const v = state.conLabel ? state.conLabel[stopI] : -1;
        if (v != null && v > r.conMax) { r.conMax = v; r.conStop = stopI; }
      }
    }
    if (state.constraint.on && state.constraint.name && state.constraint.only) {
      list = list.filter((r) => r.conMax != null && r.conMax >= 0 && (r.firstArr == null || r.conMax > r.firstArr));
    }
    list.sort((a, b) => b.st.typ - a.st.typ); // 离预算带最近的排前面
    fastRows = list.slice(0, 25).map((r) => rowHtml(r, conOn, true));
    if (list.length > 25) fastRows.push(`<tr><td colspan="8" class="st">…更快到达共 ${list.length} 城，仅列前 25（按接近预算带排序）</td></tr>`);
  }
  const emptyMsg = conOn && total === 0 && fastRows.length === 0
    ? `<tr><td colspan="8" class="st" style="padding:14px 8px">从「${state.origin ? state.origin.city : "出发地"}」出发、当前预算内没有城市还能在 ${constraintByText()}赶到「${state.constraint.name}」。这是约束下的空结果，不是查询失败。可放宽单程时长/换乘，或取消「只看还能赶到该城市」再对照各城的最晚出发时刻。${originToDestHint()}</td></tr>`
    : "";
  $("list-body").innerHTML = emptyMsg + mainRows.join("") +
    (fastRows.length ? `<tr class="faster-sep"><td colspan="8">以下更快到达（典型耗时低于预算下限 ${fmtDur(state.bmin)}，同样符合"预算=上限"的理解）</td></tr>` : "") +
    fastRows.join("") + (rows.length > max ? `<tr><td colspan="8" class="st">…带内共 ${rows.length} 城，仅显示前 ${max}</td></tr>` : "");
  [...$("list-body").querySelectorAll("tr[data-stop]")].forEach((tr) => {
    tr.onclick = () => selectDestination(Number(tr.dataset.stop));
  });
  renderShortlist();
}

function rowHtml(r, conOn, faster) {
  const s = STATIONS[r.stopI], st = r.st;
  const tag = conOn ? conTagByMax(r.conMax, r.conMax >= 0 && r.firstArr != null ? r.conMax - r.firstArr : null) : null;
  const tip = faster ? ` title="典型耗时低于预算下限；若预算按上限理解，它也是符合预算的选择"` : "";
  // 代表站明显慢于同城最优时点名快站（round-24 #3），只看表格也能拿到详情里"同城车站"的关键信息
  const cityBest = r.cityBestTyp != null && r.cityBestTyp < st.typ - 15
    ? `<br><span class="st" title="同城各可达站里典型耗时最优的车站（该站口径，点击本行在详情里可切换）">同城更快：${STATIONS[r.cityBestStop].n} 典型 ${fmtDur(r.cityBestTyp)}</span>` : "";
  return `<tr data-stop="${r.stopI}"${faster ? ` class="faster"` : ""}>
      <td><b>${s.c}</b><br><span class="st">${s.n} · ${s.d}班/日${st.dir ? "" : "（无直达）"}</span>${cityBest}</td>
      <td class="prov">${s.p || ""}</td>
      <td class="km">${r.km != null ? r.km + "km" : ""}</td>
      <td class="num">${fmtDur(st.fast)}</td>
      <td class="num"${tip}><b>${fmtDur(st.typ)}</b>${st.typ < state.bmin ? ' <span title="典型耗时快于预算下限——若预算按上限理解，它同样符合；这些目的地集中在列表下方"更快到达"区">≈</span>' : ""}</td>
      <td class="num">${st.cnt}</td>
      <td class="num">${st.dir || "—"}</td>
      ${(() => {
        if (tag) return `<td>${`<span class="tag ${tag.cls}" title="${tag.cls === "bad" ? "无可行衔接：或返程发车早于可到达时刻，或换乘≤2次内无解。点行看详情。" : "最晚可行出发时刻（同城各站最大值）。在地时长按「最早到达 × 最晚返程」的乐观配对估算（上限口径），且同城口径可含快于预算下限的车站"}">${tag.txt}</span>`}</td>`;
        const vc = Views.rowCell(s.c);
        return `<td>${vc || `<span class="tag na">—</span>`}</td>`;
      })()}
    </tr>`;
}

/* ================= 候选清单（对比 2–6 个入围目的地） ================= */
function loadShortlist() {
  try {
    const a = JSON.parse(localStorage.getItem("railShortlist") || "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, 8) : [];
  } catch (e) { return []; }
}
function saveShortlist() {
  try { localStorage.setItem("railShortlist", JSON.stringify(state.shortlist)); } catch (e) { /* ignore */ }
}
function toggleStar(city) {
  const i = state.shortlist.indexOf(city);
  if (i >= 0) state.shortlist.splice(i, 1);
  else state.shortlist.push(city);
  saveShortlist();
  renderShortlist();
  syncStarBtn();
}
function syncStarBtn() {
  const btn = $("d-star");
  if (!btn) return;
  const s = state.selected != null ? STATIONS[state.selected] : null;
  const on = !!(s && state.shortlist.includes(s.c));
  btn.classList.toggle("on", on);
  btn.textContent = on ? "★" : "☆";
  btn.title = on ? "从候选对比中移除" : "加入候选对比";
}
function renderShortlist() {
  const sec = $("shortlist-sec"), body = $("shortlist-body");
  if (!sec || !body) return;
  if (!state.shortlist.length) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  const rows = state.shortlist.map((city) => {
    let best = -1;
    for (const [i, st] of state.stats) {
      if (STATIONS[i].c !== city) continue;
      if (best < 0 || st.typ < state.stats.get(best).typ) best = i;
    }
    if (best < 0) {
      return `<tr><td><b>${city}</b></td><td colspan="3" class="sl-dim">本次查询不可达 / 不在预算带</td><td><button class="sl-rm" data-city="${city}" title="移除">✕</button></td></tr>`;
    }
    const st = state.stats.get(best);
    // 口径标注：对比行取"同城典型耗时最优站"，与主表锚站、详情页本站口径可能不同（round-20 #4）
    return `<tr data-stop="${best}">
      <td title="对比行取该城当前查询中典型耗时最优的车站；下方「全部目的地表格」与详情页为锚站/本站口径"><b>${city}</b><br><span class="st">${STATIONS[best].n}</span></td>
      <td class="num">${fmtDur(st.typ)}</td>
      <td class="num">${st.dir || "—"}直/${st.cnt}</td>
      <td class="sl-wx" data-wx="${best}">…</td>
      <td><button class="sl-rm" data-city="${city}" title="移除">✕</button></td>
    </tr>`;
  });
  body.innerHTML = `<table><thead><tr><th>城市</th><th>典型</th><th>直达/方案</th><th>到达时天气</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  body.querySelectorAll("tr[data-stop]").forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest(".sl-rm")) return;
      selectDestination(Number(tr.dataset.stop));
    };
  });
  body.querySelectorAll(".sl-rm").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); toggleStar(b.dataset.city); };
  });
  // 到达时天气：全国格点约 200km 精度，做候选间横向对比足够
  body.querySelectorAll("[data-wx]").forEach((el) => {
    const i = Number(el.dataset.wx), s = STATIONS[i], st = state.stats.get(i);
    const minute = st.firstArr != null ? st.firstArr : state.dateOff * 1440 + state.fromMin + st.typ;
    if (typeof Weather === "undefined" || !Weather.arrivalWx) { el.textContent = "—"; return; }
    Weather.arrivalWx(s.la, s.lo, minute).then((w) => {
      el.textContent = w ? `${w.txt} ${w.temp}°` : "—";
      if (w) el.title = `到达约 ${fmtAbs(minute)} · ${w.txt}${w.precip ? " · 3h 降水 " + w.precip + "mm" : ""}`;
    }).catch(() => { el.textContent = "—"; });
  });
}

/* ================= 详情 ================= */


function updateLegend() {
  if (!state.queried) return;
  $("legend-wrap").classList.remove("hidden");
  const byTyp = state.colorBy === "typ";
  const labels = byTyp
    ? ["< 1h", "1–2h", "2–3h", "3–4h", "4–5h", "5–6h", "≥ 6h"]
    : ["1 班", "2–4", "5–9", "10–19", "20–39", "40–79", "≥ 80"];
  $("legend-body").innerHTML = labels.map((l, i) =>
    `<div class="leg-row"><i style="background:${RAMP[i]}"></i>${l}${byTyp ? "" : " 个方案"}</div>`).join("") +
    `<div class="leg-row"><i style="background:transparent;border:1.5px solid #7b8ea0"></i>低于预算下限</div>` +
    `<div class="leg-row"><i style="background:#9aa7b4;opacity:.55"></i>不可达/未查询</div>` +
    `<div class="leg-note">圆点越大 ≈ 可选班次越多</div>`;
}

/* ================= 事件 ================= */
function initEvents() {
  originCombo = attachCombo("origin-input", "origin-drop", "origin-chosen", (it) => {
    if (!it) {
      state.origin = null;
      try { localStorage.removeItem("railOrigin"); } catch (e) { }
      $("origin-stns").classList.add("hidden"); $("origin-stns").innerHTML = "";
      renderOrigin();
      abandonQuery();
      setStatus("出发地已清除。请重新选择出发地。");
      return;
    }
    state.origin = {
      name: it.name, city: it.type === "city" ? it.name : STATIONS[it.stops[0]].c,
      allStops: it.stops.slice(), stops: it.stops.slice(),
    };
    try { localStorage.setItem("railOrigin", JSON.stringify(Places.encode(it, STATIONS))); } catch (e) { } // 与叠加圈一致跨刷新保留
    renderOrigin();
    renderStationChecks("origin-stns", state.origin, () => { if (state.queried || state.everQueried) runQuery(); });
    // 清除再重选后 queried 已被复位，但用户显然期待结果跟着换（round-27 #1）
    if (state.queried || state.everQueried) runQuery();
  });
  // 等时圈视图系统（2026-09-24 改造）：附加圈 UI + 交集开关 + 两个旧入口按钮
  Views.load();
  Views.renderCards();
  $("btn-add-view").onclick = () => {
    const v = Views.addView({ dir: "dep" });
    if (v) {
      const inp = document.querySelector(`.view-card[data-id="${v.id}"] .vc-place`);
      if (inp) inp.focus();
      setStatus("输入朋友的出发城市或车站，再设日期、时段和预算，查询大家都能到的目的地。");
    }
  };
  $("btn-goto-place").onclick = () => {
    // 抵达圈默认全天窗口（理由同「赶回出发地」：返程出发时段与主查询出发无关，round-25 #4）
    const v = Views.addView({ dir: "arr", bmax: state.bmax, maxTra: state.maxTra, cls: state.cls, fromMin: 0, untilMin: END_OF_DAY });
    if (v) {
      const inp = document.querySelector(`.view-card[data-id="${v.id}"] .vc-place`);
      if (inp) inp.focus();
      setStatus("「必须抵达」圈：填要赶到的城市（如白云机场、青岛），再选日期和「不晚于」时刻。查询后会与主查询取交集——效果等同原来的「之后必须赶到」。");
    }
  };
  $("btn-return-home").onclick = () => {
    if (!state.origin) { setStatus("请先选择出发地，才能设「赶回出发地」。", true); return; }
    const city = cityIndex.find((c) => c.name === state.origin.city);
    const it = city
      ? { type: "city", name: city.name, stops: city.stops.slice(), degree: city.degree }
      : { type: "stn", name: state.origin.name, stops: state.origin.stops.slice(), degree: 0 };
    const backOff = Math.min(13, state.dateOff + 1);
    const v = Views.addView({
      dir: "arr", type: it.type, name: it.name, stops: it.stops.slice(), city: it.type === "city" ? it.name : STATIONS[it.stops[0]].c,
      dateOff: backOff, bmax: state.bmax, maxTra: state.maxTra, cls: state.cls,
      // 抵达圈的时段是"从候选城市出发"的窗口，与主查询出发时段无关，默认全天；
      // 照抄主查询会静默截掉下午的返程班次（round-25 #4）
      fromMin: 0, untilMin: END_OF_DAY,
    });
    if (!v) return;
    $("intersect-only").checked = true;
    setStatus(`已叠加「赶回 ${it.name}」圈（默认次日，沿用你的车程和换乘限制）。请确认返程日期与「不晚于」时刻，然后点查询。`);
    const card = document.querySelector(`.view-card[data-id="${v.id}"]`);
    if (card) { card.scrollIntoView({ block: "nearest" }); const t = card.querySelector(".vc-arrby"); if (t) t.focus(); }
  };
  $("show-faster").onchange = () => { if (state.queried) renderList(); };
  $("intersect-only").onchange = () => {
    if (state.queried) {
      Views.recompute();
      renderMapResult(); renderList(); syncStatusLine();
    }
  };

  $("date-sel").onchange = (e) => {
    state.dateOff = Number(e.target.value);
    const av = timeToMin($("arrive-by").value);
    state.arriveBy = av == null ? null : state.dateOff * 1440 + av;
    if (typeof Weather !== "undefined") Weather.setDay(state.dateOff);
    if (state.dateOff === 0) applyNowPreset();
    else setWindow(6 * 60, END_OF_DAY); // 换未来日期重置为全天, 避免沿用深夜窗口
  };
  $("from-time").onchange = (e) => {
    state.fromMin = timeToMin(e.target.value) ?? state.fromMin;
    if (state.queried) runQuery();
  };
  $("until-time").onchange = (e) => {
    state.untilMin = timeToMin(e.target.value) ?? state.untilMin;
    if (state.queried) runQuery();
  };

  document.querySelectorAll(".presets .chip[data-preset]").forEach((b) => {
    b.onclick = () => {
      const p = b.dataset.preset;
      if (p === "now") applyNowPreset();
      if (p === "allday") setWindow(6 * 60, END_OF_DAY);
      if (p === "morning") setWindow(6 * 60, 12 * 60);
      if (p === "evening") setWindow(17 * 60, END_OF_DAY);
      if (p === "day") setWindow(6 * 60, 18 * 60);
    };
  });

  const bmin = $("budget-min"), bmax = $("budget-max");
  function syncBudget() {
    let a = Number(bmin.value), b = Number(bmax.value);
    if (a > b) { [a, b] = [b, a]; bmin.value = a; bmax.value = b; }
    state.bmin = a; state.bmax = b;
    $("budget-label").textContent = a === 0 ? `≤ ${fmtDur(b)}` : `${fmtDur(a)} – ${fmtDur(b)}`;
    syncPresetChips();
  }
  bmin.oninput = () => { syncBudget(); if (state.queried) { computeStats(); Views.recompute(); renderMapResult(); renderList(); syncStatusLine(); if (state.selected != null) selectDestination(state.selected, true); } };
  bmax.oninput = () => { syncBudget(); if (state.queried) { computeStats(); Views.recompute(); renderMapResult(); renderList(); syncStatusLine(); if (state.selected != null) selectDestination(state.selected, true); } };
  document.querySelectorAll(".chip[data-budget]").forEach((b) => {
    b.onclick = () => {
      const [a, c] = b.dataset.budget.split(",").map(Number);
      bmin.value = a; bmax.value = c; syncBudget();
      if (state.queried) { computeStats(); Views.recompute(); renderMapResult(); renderList(); syncStatusLine(); if (state.selected != null) selectDestination(state.selected, true); }
    };
  });
  syncBudget(); // 首屏把标签和芯片激活态对齐到默认值（bmin=0 → 显示 ≤ 上限）

  document.querySelectorAll('input[name=cls]').forEach((r) => r.onchange = (e) => { state.cls = e.target.value; if (state.queried) runQuery(); });
  document.querySelectorAll('input[name=tra]').forEach((r) => r.onchange = (e) => {
    state.maxTra = Number(e.target.value);
    if (state.queried) { computeStats(); Views.recompute(); renderMapResult(); renderList(); syncStatusLine(); if (state.selected != null) selectDestination(state.selected, true); }
  });

  $("arrive-by").onchange = (e) => {
    const v = timeToMin(e.target.value);
    state.arriveBy = v == null ? null : state.dateOff * 1440 + v;
    if (state.queried) { computeStats(); Views.recompute(); renderMapResult(); renderList(); syncStatusLine(); if (state.selected != null) selectDestination(state.selected, true); }
  };

  $("colorby-sel").onchange = (e) => { state.colorBy = e.target.value; updateLegend(); if (state.queried) renderMapResult(); };
  $("sort-sel").onchange = () => { $("sort-sel").dataset.touched = "1"; renderList(); };
  $("size-sel").onchange = () => renderList();
  $("region-sel").onchange = () => renderList();
  $("maxkm-input").onchange = () => renderList();

  $("btn-query").onclick = runQuery;
  $("btn-demo").onclick = demoFill;
  $("d-close").onclick = () => { $("detail").classList.add("hidden"); if (selectedRing) { map.removeLayer(selectedRing); selectedRing = null; } };
  $("d-star").onclick = () => {
    if (state.selected == null) return;
    toggleStar(STATIONS[state.selected].c);
  };
  $("btn-table").onclick = () => {
    const p = $("list-panel");
    p.classList.toggle("hidden");
    $("btn-table").textContent = p.classList.contains("hidden") ? "全部目的地表格 ▲" : "收起表格 ▼";
  };

  $("btn-help").onclick = () => $("help-overlay").classList.remove("hidden");
  $("help-close").onclick = () => { $("help-overlay").classList.add("hidden"); try { localStorage.setItem("railHelpDismissed", "1"); } catch (e) { } };
  $("help-demo").onclick = () => { $("help-overlay").classList.add("hidden"); demoFill(); };

  // 回车快捷查询
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "BODY") runQuery();
  });
}

function syncPresetChips() {
  document.querySelectorAll(".presets .chip[data-preset]").forEach((b) => {
    const p = b.dataset.preset;
    const [a, c] = { now: [state.fromMin, END_OF_DAY], allday: [360, END_OF_DAY], morning: [360, 720], evening: [1020, END_OF_DAY], day: [360, 1080] }[p] || [null, null];
    b.classList.toggle("active", a != null && state.dateOff === (p === "now" ? 0 : state.dateOff) && a === state.fromMin && c === state.untilMin && (p !== "now" || state.dateOff === 0));
  });
  document.querySelectorAll(".presets .chip[data-budget]").forEach((b) => {
    const [a, c] = b.dataset.budget.split(",").map(Number);
    b.classList.toggle("active", a === state.bmin && c === state.bmax);
  });
}

function setWindow(a, b) {
  state.fromMin = a; state.untilMin = b;
  $("from-time").value = `${pad2(Math.floor(a / 60) % 24)}:${pad2(a % 60)}`;
  $("until-time").value = `${pad2(Math.floor(b / 60) % 24)}:${pad2(Math.min(b % 60, 59))}`;
  syncPresetChips();
  if (state.queried) runQuery();
}
function snap5(m) {
  m = Math.max(0, Number(m) || 0);
  return Math.min(23 * 60 + 55, Math.ceil(m / 5) * 5);
}
function applyNowPreset() {
  const hm = snap5(chinaNowMin());
  setWindow(Math.min(hm, 23 * 60), END_OF_DAY);
  $("date-sel").value = "0";
  state.dateOff = 0;
  if (typeof Weather !== "undefined") Weather.setDay(0);
}

function demoFill() {
  // 示例：上海（虹桥/上海南/上海）· ≤4h · 明天全天 · ≤1次中转
  const cs = cityIndex.find((c) => c.name === "上海");
  if (!cs) { setStatus("示例城市未找到", true); return; }
  const demoStops = cs.stops.filter((x) => ["上海虹桥", "上海南", "上海"].includes(STATIONS[x].n));
  if (!demoStops.length) { setStatus("示例车站未找到", true); return; }
  const oi = $("origin-input");
  oi.classList.add("hidden");
  const oc = $("origin-chosen");
  oc.classList.remove("hidden");
  oc.innerHTML = `<span title="${demoStops.map((x) => STATIONS[x].n).join("、")}">上海（${demoStops.length} 站）</span><button type="button">✕</button>`;
  oc.querySelector("button").onclick = () => {
    oc.classList.add("hidden"); oi.classList.remove("hidden"); oi.value = ""; state.origin = null;
    $("origin-stns").classList.add("hidden"); $("origin-stns").innerHTML = ""; renderOrigin();
  };
  state.origin = { name: "上海", city: "上海", allStops: cs.stops.slice(), stops: demoStops.slice() };
  try { localStorage.setItem("railOrigin", JSON.stringify(Places.encode({ type: "stn", name: "上海", stops: demoStops.slice(), degree: 0 }, STATIONS))); } catch (e) { }
  renderOrigin();
  renderStationChecks("origin-stns", state.origin, () => { if (state.queried) runQuery(); });

  // 本示例不演示多圈交集，清空附加视图，避免残留旧状态
  Views.clearAll();
  state.constraint = { name: null, allStops: [], stops: [], on: false, only: false, dateOff: 0, timeMin: null, stayMin: 0, dur: 0, xf: -1, cls: "all", tFromMin: null };
  state.conLabel = null; state.conArr = null;

  $("budget-min").value = 0; $("budget-max").value = 240;
  $("budget-min").dispatchEvent(new Event("input"));

  const tra = document.querySelector('input[name=tra][value="1"]');
  if (tra) tra.checked = true;
  state.maxTra = 1;

  $("date-sel").value = "1"; state.dateOff = 1;
  if (typeof Weather !== "undefined") Weather.setDay(1);
  state.fromMin = 360; state.untilMin = END_OF_DAY;
  $("from-time").value = "06:00"; $("until-time").value = "23:59";
  syncPresetChips();

  runQuery();
}

/* ================= 启动 ================= */
async function boot() {
  try {
    state.anchor = new Date(chinaMidnightMs());
    $("data-badge").textContent = "正在加载时刻表…";
    await initEngine();
    const meta = await api("/api/meta");
    STATIONS = meta.stations; NAMES = meta.names; META = meta.meta;
    DataStatus.show(META);
    setInterval(checkRailDay, 15000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkRailDay(); });
    buildCityIndex();
    rebuildHoverPts(); // 站点数据到位，启用悬停手形命中表
    buildGrayLayer();
    refreshLabels();
    initEvents();
    fillDates(); // 14 天日期选项
    if (typeof Weather !== "undefined") {
      Weather.init({ map, getDay: () => state.dateOff, stations: STATIONS });
      // 空闲时后台预取天气格点+预警：交互期零即时查询，首开图层零等待
      const kick = () => { if (Weather.prefetch) Weather.prefetch(); };
      if (typeof requestIdleCallback === "function") requestIdleCallback(kick, { timeout: 4000 });
      else setTimeout(kick, 900);
    } else {
      L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", {
        subdomains: "1234", attribution: "底图 © 高德地图", maxZoom: 17,
      }).addTo(map);
    }
    // 配色已固定为「绿快红慢」，不再有选择器
    const hm = snap5(chinaNowMin());
    state.fromMin = Math.min(hm, 23 * 60);
    state.untilMin = END_OF_DAY;
    $("from-time").value = `${pad2(Math.floor(state.fromMin / 60))}:${pad2(state.fromMin % 60)}`;
    const tl = $("today-label");
    if (tl) tl.textContent = `北京时间 ${anchorDateStr(0)}`;
    $("until-time").value = "23:59";
    setStatus("选择出发地后点击「查询可达性」。首次使用可点「使用说明」或直接试示例场景。");
    // 出发地与叠加圈一起跨刷新保留（2026-09-24）：只留其一会出现"有圈无主查询"的悬空态
    try {
      const stored = JSON.parse(localStorage.getItem("railOrigin") || "null");
      const saved = Places.resolve(stored, STATIONS);
      if (stored && !saved) setStatus("保存的出发地不在当前时刻表中，请重新选择。", true);
      if (saved && Array.isArray(saved.stops) && saved.stops.length && originCombo) {
        originCombo.pick(saved);
        setStatus(`已恢复上次的出发地「${saved.name}」和 ${Views.views.length} 个叠加圈（如不需要请点✕清除）。点「查询可达性」重新计算。`);
      }
    } catch (e) { /* ignore */ }
    if (Views.restorationNotice) setStatus(Views.restorationNotice, true);
    renderShortlist(); // 恢复上次收藏的候选（查询前显示为不可达，查询后补全数据）
  } catch (e) {
    DataStatus.fail(e.message);
    setStatus(`数据加载失败：${e.message}`, true);
  }
}
boot();
