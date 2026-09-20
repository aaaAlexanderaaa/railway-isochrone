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
// 绝对分钟(相对今天00:00, 已含日期偏移) -> 日期感知文本, 始终带日期
function fmtAbs(m) {
  const day = Math.floor(m / 1440);
  const hm = fmtClock(m);
  const base = new Date(state.anchor || new Date());
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + day);
  return `${base.getMonth() + 1}/${base.getDate()}(${WEEKDAYS[base.getDay()]}) ${hm}`;
}
function anchorDateStr(off) {
  const base = new Date(state.anchor || new Date());
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + off);
  return `${base.getMonth() + 1}/${base.getDate()} ${WEEKDAYS[base.getDay()]}`;
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
  bmin: 180, bmax: 240,
  cls: "all", maxTra: 2,
  arriveBy: null,          // 最晚到达(绝对分钟, 相对出发日00:00), null=不过滤
  constraint: { on: false, name: null, stops: [], dateOff: 1, timeMin: null, only: false, dur: 0, xf: -1, cls: "all", tFromMin: null, stayMin: 0 },
  colorBy: "typ",
  journeys: new Map(),     // stop -> [[dep,arr,j,ft,st,os],...]
  stats: new Map(),        // stop -> {typ,fast,p90,cnt,dir,lastDep}
  conLabel: null,          // stop -> latest abs min
  selected: null,
  queried: false,
};

/* ================= 地图 ================= */
const PALETTES = {
  rainbow: { name: "彩虹（默认）", colors: ["#440154", "#46327e", "#365c8d", "#277f8e", "#1fa187", "#86c546", "#e0b50f"] },
  ocean: { name: "深海蓝", colors: ["#08306b", "#08519c", "#2171b5", "#4292c6", "#6baed6", "#9ecae1", "#c6dbef"] },
  warm: { name: "暖阳橙红", colors: ["#67000d", "#a50f15", "#cb181d", "#ef3b2c", "#fb6a4a", "#fc9272", "#fcbba1"] },
  duibu: { name: "冷暖对比", colors: ["#053061", "#1a5fa8", "#4393c3", "#a8cbe0", "#f3b285", "#d6604d", "#b2182b"] },
  traffic: { name: "绿快红慢", colors: ["#166534", "#15803d", "#65a30d", "#eab308", "#f97316", "#dc2626", "#7f1d1d"] },
};
let RAMP = PALETTES.rainbow.colors;
function setPalette(key) {
  RAMP = (PALETTES[key] || PALETTES.rainbow).colors;
  state.palette = key;
  try { localStorage.setItem("railPalette", key); } catch (e) { }
  if (state.queried) { renderMapResult(); }
  updateLegend();
}
const TRA_COLOR = ["#2563eb", "#f59e0b", "#ef4444"];
function colorTyp(t) { const h = t / 60; return RAMP[h < 1 ? 0 : h < 2 ? 1 : h < 3 ? 2 : h < 4 ? 3 : h < 5 ? 4 : h < 6 ? 5 : 6]; }
function isLightColor(hex) {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 175;
}
function colorCnt(c) { return RAMP[c < 2 ? 0 : c < 5 ? 1 : c < 10 ? 2 : c < 20 ? 3 : c < 40 ? 4 : c < 80 ? 5 : 6]; }

const map = L.map("map", { preferCanvas: true, zoomControl: true, minZoom: 4, maxZoom: 17 }).setView(wgs2gcj(34.5, 108.5), 5);
L.tileLayer("https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}", {
  subdomains: "1234", attribution: "底图 © 高德地图", maxZoom: 17,
}).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const sharedRenderer = L.canvas({ padding: 0.5 }); // 所有矢量标记共用一个渲染器

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
    const m = mkMarker(s, 2.2, "#9aa7b4", 0.55, 0);
    m.bindTooltip(`${s.n}`, { className: "stn-tip", direction: "top" });
    m.on("click", () => onStationClick(i));
    layerGray.addLayer(m);
  }
}

function tipText(i) {
  const s = STATIONS[i], st = state.stats.get(i);
  if (!st) return `<b>${s.n}</b>（${s.c}）`;
  return `<b>${s.n}</b>（${s.c}）<br>典型 ${fmtDur(st.typ)} · 方案 ${st.cnt} · 直达 ${st.dir}`;
}

function onStationClick(i) {
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

function renderMapResult() {
  layerBand.clearLayers(); layerNear.clearLayers(); layerDim.clearLayers();
  const con = state.constraint.on && state.constraint.name && state.conLabel;
  const marks = [];
  for (const [stopI, st] of state.stats) {
    if (state.origin && STATIONS[stopI].c === state.origin.city) continue;
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
    m.on("click", () => onStationClick(stopI));
    (inBand ? layerBand : layerNear).addLayer(m);
    if (inBand) marks.push(m);
  }
  if (marks.length) {
    const g = L.featureGroup(marks);
    try { map.fitBounds(g.getBounds().pad(0.08)); } catch (e) { /* ignore */ }
  }
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
  const ds = $("date-sel"), cd = $("cdate-sel");
  const names = ["今天", "明天", "后天"];
  for (let i = 0; i < 14; i++) {
    const lbl = `${i < 3 ? names[i] + " " : ""}${anchorDateStr(i)}`;
    ds.add(new Option(lbl, String(i)));
    cd.add(new Option(lbl, String(i)));
  }
  ds.value = "0"; cd.value = "0"; // B 端默认与 A 端同日, 避免一上来就日期错配
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
    const cs = cityIndex.filter((c) => c.name.includes(q)).slice(0, 8)
      .map((c) => ({ type: "city", ...c }));
    const ss = STATIONS.map((s, i) => ({ i, ...s })).filter((s) => s.n.includes(q) && s.d > 0)
      .sort((a, b) => b.d - a.d).slice(0, 10 - Math.min(cs.length, 5))
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
}

/* ================= 统计 ================= */
function computeStats() {
  state.stats.clear();
  const arrCut = state.arriveBy;
  const fAbs = state.dateOff * 1440 + state.fromMin;
  const tAbs = state.dateOff * 1440 + state.untilMin;
  for (const [stopI, js0] of state.journeys) {
    let js = js0.filter((x) => x[2] - 1 <= state.maxTra);
    if (arrCut != null) js = js.filter((x) => x[1] <= arrCut);
    js = js.filter((x) => x[0] >= fAbs && x[0] <= tAbs); // 出发必须落在所选时段内
    if (state.dateOff === 0) {
      const nowAbs0 = Math.floor((Date.now() - new Date(state.anchor || Date.now()).setHours(0, 0, 0, 0)) / 60000);
      js = js.filter((x) => x[0] >= nowAbs0); // 已发车班次不计入统计
    }
    if (!js.length) continue;
    const pairs = js.map((x) => [x[1] - x[0], x]).sort((a, b) => a[0] - b[0]);
    // 主档 = 耗时 ≤ min(预算上限, 最快+2h), 至少保留最快一班
    const cut = Math.max(pairs[0][0], Math.min(state.bmax, pairs[0][0] + 120));
    const core = pairs.filter((p) => p[0] <= cut);
    const rest = pairs.filter((p) => p[0] > cut);
    const coreDurs = core.map((p) => p[0]);
    const med = coreDurs.length % 2
      ? coreDurs[(coreDurs.length - 1) / 2]
      : Math.round((coreDurs[coreDurs.length / 2 - 1] + coreDurs[coreDurs.length / 2]) / 2);
    const p90 = coreDurs[Math.min(coreDurs.length - 1, Math.floor(coreDurs.length * 0.9))];
    state.stats.set(stopI, {
      typ: med, fast: pairs[0][0], p90, cnt: core.length,
      firstArr: Math.min(...js.map((x) => x[1])),
      slowCnt: rest.length,
      slowLastDep: rest.length ? Math.max(...rest.map((p) => p[1][0])) : null,
      dir: core.filter((p) => p[1][2] === 1).length,
      lastDep: core.length ? Math.max(...core.map((p) => p[1][0])) : null,
      firstDep: js[0][0],
      coreCut: cut,
      js,
    });
  }
}

function conAbs() {
  const c = state.constraint;
  return c.dateOff * 1440 + (c.timeMin == null ? 1439 : c.timeMin); // 留空 = 当天不限
}
function conFloor() {
  const c = state.constraint;
  return c.tFromMin == null ? 0 : c.dateOff * 1440 + c.tFromMin;
}
// 入带判定: 典型耗时落在 [下限-30分钟, 上限]。预算本质是上限;
// 下限保留30分钟弹性, 让"略快于下限"的目的地(如2h57之于3h带)仍然可见。
function inBandQ(st) {
  return st.typ >= state.bmin - 30 && st.typ <= state.bmax;
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

async function api(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error || msg; } catch (e) { }
    throw new Error(msg);
  }
  return r.json();
}

async function runQuery() {
  if (!state.origin) { setStatus("请先选择出发地（左侧第①步）。", true); return; }
  const btn = $("btn-query");
  btn.disabled = true;
  setStatus("计算中…（引擎对全天时刻表做轮廓搜索，约 1–2 秒）");
  try {
    state.anchor = state.anchor || new Date();
    // 傍晚出发且未设"最晚到达"时, 默认截断到次日凌晨 02:00, 避免"凌晨才到"被计入
    if (state.arriveBy == null && state.dateOff === 0 && state.fromMin >= 16 * 60) {
      state.arriveBy = 1440 + 2 * 60;
      $("arrive-by").value = "02:00";
      setStatus("已按晚间出发自动设置「最晚到达 = 次日 02:00」，可在左侧修改或清空。");
    }
    const o = state.origin.stops.join(",");
    const f = state.dateOff * 1440 + state.fromMin;
    const t = state.dateOff * 1440 + state.untilMin;
    if (t <= f) throw new Error("出发时段无效：结束时间需晚于开始时间");
    const data = await api(`/api/reach?o=${o}&f=${f}&t=${t}&cls=${state.cls}`);
    state.journeys = new Map(data.journeys);
    computeStats();
    state.queried = true;

    // 约束
    state.conLabel = null;
    const c = state.constraint;
    const cw = $("cwarn");
    if (c.on && c.name) {
      // 截止时间与出发日的时序体检: 早于"出发+30分钟"则交集必然近乎为空, 必须显式预警而不是静默全判不可行
      const travelStart = state.dateOff * 1440 + state.fromMin;
      const conT = conAbs();
      if (conT < travelStart + 30) {
        cw.classList.remove("hidden");
        cw.textContent = `⚠ B 端到达截止（${anchorDateStr(c.dateOff)} ${fmtClock(conT)}）早于出发日 ${anchorDateStr(state.dateOff)} ${fmtClock(travelStart)} 出发后的最早可能到达——交集必然近乎为空。请核对 B 端的日期/时间。`;
      } else if (conT < travelStart + state.bmax) {
        cw.classList.remove("hidden");
        cw.textContent = `提示：截止时间距出发仅 ${fmtDur(conT - travelStart)}，短于预算上限 ${fmtDur(state.bmax)}——较远的目的地会被判不可行，这属于约束本身收紧，不是数据缺失。`;
      } else cw.classList.add("hidden");
      const cd = await api(`/api/constraint?d=${c.stops.join(",")}&T=${conAbs()}&floor=${conFloor()}&xf=${c.xf}&dur=${c.dur}&cls=${c.cls}`);
      state.conLabel = cd.latest; state.conArr = cd.arrAt;
    } else {
      cw.classList.add("hidden");
    }

    if (state.conLabel && !$("sort-sel").dataset.touched) { $("sort-sel").value = "con"; setStatus("已加载 B 端条件，列表默认按约束余量排序（可在右上切换）。"); }
    renderMapResult();
    renderOrigin();
    renderList();
    updateLegend();
    refreshLabels();
    if (state.selected != null) selectDestination(state.selected, true); // 重查后刷新已打开的详情

    const bandRows = cityRows();
    const nCities = bandRows.length;
    const nStops = bandRows.reduce((acc, r) => acc + [...state.stats.keys()].filter((k) => STATIONS[k].c === STATIONS[r.stopI].c && state.stats.get(k).typ >= 30).length, 0);
    const nowM = Math.floor((Date.now() - new Date(state.anchor || Date.now()).setHours(0, 0, 0, 0)) / 60000);
    const nowTxt = state.dateOff === 0 ? ` · 现在 ${fmtClock(nowM)}` : "";
    const pastWarn = state.dateOff === 0 && state.fromMin < nowM - 2 ? ` · 已自动从现在 ${fmtClock(nowM)} 起算（你设的时段起点更早，其间班次已发车不计）` : "";
    if (nStops === 0) {
      setStatus("当前条件下时间预算带内没有可达目的地。可放宽预算/时段，或切换到明天全天。", true);
    } else {
      setStatus(`✓ 今天是 ${anchorDateStr(0)}${nowTxt} · 查询 ${anchorDateStr(state.dateOff)} ${fmtClock(state.dateOff * 1440 + state.fromMin)}–${fmtClock(state.dateOff * 1440 + state.untilMin)} · 预算带内 ${nCities} 城（${nStops} 站）${pastWarn}${state.conLabel ? " · 已加载 B 端条件" : ""} · 引擎 ${((data.stats.ms || 0) / 1000).toFixed(1)}s`);
    }
    loadDepartures(f);
  } catch (err) {
    setStatus(`查询失败：${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadDepartures(fromAbs) {
  if (!state.origin) return;
  try {
    const f2 = state.dateOff === 0 ? Math.max(fromAbs, Math.floor((Date.now() - new Date(state.anchor || Date.now()).setHours(0, 0, 0, 0)) / 60000)) : fromAbs;
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
function cityRows() {
  const sizeTh = Number($("size-sel").value) || 0;
  const region = $("region-sel") ? $("region-sel").value : "all";
  const maxKm = $("maxkm-input") && $("maxkm-input").value ? Number($("maxkm-input").value) : 0;
  const oa = originAnchor();
  const byCity = new Map();
  for (const [stopI, st] of state.stats) {
    if (state.origin && STATIONS[stopI].c === state.origin.city) continue;
    if (st.typ < 30) continue; // 30分钟内的通勤小站不算旅行目的地
    if (!inBandQ(st)) continue;
    if (sizeTh > 0 && STATIONS[stopI].d < sizeTh) continue;
    if (region !== "all" && oa && oa.prov) {
      const pv = STATIONS[stopI].p;
      if (region === "prov" && pv !== oa.prov) continue;
      if (region === "out" && pv === oa.prov) continue;
    }
    const km = oa ? haversineKm(oa.la, oa.lo, STATIONS[stopI].la, STATIONS[stopI].lo) : null;
    if (maxKm > 0 && km != null && km > maxKm) continue;
    const c = STATIONS[stopI].c;
    const row = { stopI, st, km, prov: STATIONS[stopI].p };
    if (!byCity.has(c)) byCity.set(c, row);
    else {
      const cur = byCity.get(c);
      // 代表站: 典型耗时最短; 若他站耗时差距<=15分钟, 取班次更多的枢纽站
      if (st.typ < cur.st.typ - 15) byCity.set(c, row);
      else if (st.typ <= cur.st.typ + 15 && STATIONS[stopI].d > STATIONS[cur.stopI].d) byCity.set(c, row);
    }
  }
  let rows = Array.from(byCity.values());
  // 城市级约束: 取同城各站"最晚可行出发"的最大值(同城内可乘地铁移动)
  for (const r of rows) {
    const c = STATIONS[r.stopI].c;
    r.conMax = -1; r.conStop = null; r.firstArr = null;
    for (const [stopI, st2] of state.stats) {
      if (STATIONS[stopI].c !== c) continue; // 同城全部可达站(不限带内), 与详情口径一致
      if (r.firstArr == null || st2.firstArr < r.firstArr) r.firstArr = st2.firstArr;
      const v = state.conLabel ? state.conLabel[stopI] : -1;
      if (v != null && v > r.conMax) { r.conMax = v; r.conStop = stopI; r.conArr = state.conArr ? state.conArr[stopI] : null; }
    }
  }
    state.rowTotal = rows.length; // 勾选"只看满足约束"前的总数, 供标题对比
  const stayTh = state.constraint.on && state.constraint.name ? state.constraint.stayMin : 0;
  if (stayTh > 0) rows = rows.filter((r) => r.conMax >= 0 && r.firstArr != null && r.conMax - r.firstArr >= stayTh);
  if (state.constraint.on && state.constraint.name && state.constraint.only) {
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
  const rows = cityRows();
  $("list-toggle").classList.remove("hidden");
  $("list-toggle").textContent = "收起列表 ▼";
  $("list-panel").classList.remove("hidden");
  const conOn = state.constraint.on && state.constraint.name;
  const sizeTh = Number($("size-sel").value) || 0;
  const region = $("region-sel") ? $("region-sel").value : "all";
  const maxKm = $("maxkm-input") && $("maxkm-input").value ? Number($("maxkm-input").value) : 0;
  const oa = originAnchor();
  const total = rows.length;
  const onlyOn = conOn && state.constraint.only;
  $("list-title").textContent = `预算带 ${fmtDur(state.bmin)}–${fmtDur(state.bmax)} 内${onlyOn && state.rowTotal != null ? ` ${state.rowTotal} 城` : ""}${onlyOn ? `，满足 B 端条件 ${total} 城` : ` ${total} 城`} · 带 ≈ 者略快于下限${sizeTh > 0 ? " · 已按车站规模过滤" : ""}`;
  const max = 300;
  // 主表: 预算带内
  const mainRows = rows.slice(0, max).map((r) => rowHtml(r, conOn));
  // 附表: 更快到达(典型低于下限) —— 预算语义偏"上限"的用户不应漏掉这些选择
  let fastRows = [];
  if (state.bmin > 0) {
    const below = new Map();
    for (const [stopI, st] of state.stats) {
      if (state.origin && STATIONS[stopI].c === state.origin.city) continue;
      if (st.typ >= state.bmin - 30 || st.typ < 30) continue; // 30分钟内的市郊通勤站不算"旅行目的地"
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
    ? `<tr><td colspan="8" class="st" style="padding:14px 8px">当前条件下没有目的地同时满足 A 端与 B 端条件。可放宽预算/换乘上限；B 端也可放宽"到 B 时长/截止时间"，或取消勾选"只看同时满足 B 端条件"再逐个核对各城的"最晚可行出发"。</td></tr>`
    : "";
  $("list-body").innerHTML = emptyMsg + mainRows.join("") +
    (fastRows.length ? `<tr class="faster-sep"><td colspan="8">以下更快到达（典型耗时低于预算下限 ${fmtDur(state.bmin)}，同样符合"预算=上限"的理解）</td></tr>` : "") +
    fastRows.join("") + (rows.length > max ? `<tr><td colspan="8" class="st">…带内共 ${rows.length} 城，仅显示前 ${max}</td></tr>` : "");
  [...$("list-body").querySelectorAll("tr[data-stop]")].forEach((tr) => {
    tr.onclick = () => selectDestination(Number(tr.dataset.stop));
  });
}

function rowHtml(r, conOn, faster) {
  const s = STATIONS[r.stopI], st = r.st;
  const tag = conOn ? conTagByMax(r.conMax, r.conMax >= 0 && r.firstArr != null ? r.conMax - r.firstArr : null) : null;
  const tip = faster ? ` title="典型耗时低于预算下限；若预算按上限理解，它也是符合预算的选择"` : "";
  return `<tr data-stop="${r.stopI}"${faster ? ` class="faster"` : ""}>
      <td><b>${s.c}</b><br><span class="st">${s.n} · ${s.d}班/日${st.dir ? "" : "（无直达）"}</span></td>
      <td class="prov">${s.p || ""}</td>
      <td class="km">${r.km != null ? r.km + "km" : ""}</td>
      <td class="num">${fmtDur(st.fast)}</td>
      <td class="num"${tip}><b>${fmtDur(st.typ)}</b>${st.typ < state.bmin ? ' <span title="典型耗时快于预算下限——若预算按上限理解，它同样符合；这些目的地集中在列表下方"更快到达"区">≈</span>' : ""}</td>
      <td class="num">${st.cnt}</td>
      <td class="num">${st.dir || "—"}</td>
      <td>${tag ? `<span class="tag ${tag.cls}" title="${tag.cls === "bad" ? "无可行衔接：或返程发车早于可到达时刻，或换乘≤2次内无解。点行看详情。" : "最晚可行出发时刻（同城各站最大值）。在地时长按「最早到达 × 最晚返程」的乐观配对估算（上限口径），且同城口径可含快于预算下限的车站"}">${tag.txt}</span>` : `<span class="tag na">—</span>`}</td>
    </tr>`;
}

/* ================= 详情 ================= */
function selectDestination(stopI, force) {
  const st = state.stats.get(stopI);
  if (!st && !force) return;
  const s = STATIONS[stopI];
  state.selected = stopI;
  $("detail").classList.remove("hidden");
  $("d-title").textContent = `${s.c} · ${s.n}`;
  // 同城其他可达车站切换（不同车站的班次可能差异很大）
  const siblings = [];
  for (let i = 0; i < STATIONS.length; i++) {
    if (i !== stopI && STATIONS[i].c === s.c && state.stats.has(i)) siblings.push(i);
  }
  $("d-chips").innerHTML = siblings.length
    ? `同城车站：` + siblings.slice(0, 8).map((i) =>
        `<button type="button" class="chip stnchip" data-s="${i}">${STATIONS[i].n} ${fmtDur(state.stats.get(i).typ)}</button>`).join("")
      + (siblings.length > 8 ? ` …` : "")
    : "";
  [...$("d-chips").querySelectorAll(".stnchip")].forEach((b) => {
    b.onclick = () => selectDestination(Number(b.dataset.s));
  });
  const inBand = st && inBandQ(st);
  $("d-sub").textContent = st
    ? `典型 ${fmtDur(st.typ)} · ${inBand ? (st.typ < state.bmin ? "典型略低于预算下限（弹性内）" : "在预算带内") : (st.typ < state.bmin ? "耗时低于预算下限" : "耗时超出预算上限")}${st.js[0] ? (() => { const na = state.dateOff === 0 ? Math.floor((Date.now() - new Date(state.anchor || Date.now()).setHours(0, 0, 0, 0)) / 60000) : -1; const nx = na >= 0 ? (st.js.find(j => j[0] >= na) || st.js[0]) : st.js[0]; return ` · ${state.dateOff === 0 ? "下一班" : "首班"} ${fmtAbs(nx[0])}（自 ${STATIONS[nx[5]].n} 出发）`; })() : ""}`
    : "当前条件下不可达";
  if (!st) { $("d-stats").innerHTML = ""; $("d-strip").innerHTML = ""; $("d-itin").innerHTML = ""; $("d-const").classList.add("hidden"); return; }

  $("d-stats").innerHTML = [
    ["最快", fmtDur(st.fast), "全天最优方案的耗时"],
    ["典型(中位)", fmtDur(st.typ), "主档方案耗时的中位数。主档 = 耗时不超过 min(预算上限, 最快+2小时) 的方案，慢车/超预算方案已剔除"],
    ["P90 耗时", fmtDur(st.p90), "主档方案耗时的 90 分位——错过最优车次后大约会变成多久"],
    ["主档方案数", st.cnt, "主档（同上定义）内的不劣方案数，近似当日可选班次"],
    ["直达班次", st.dir, "主档方案中无需换乘的班次数"],
    ["末班出发(主档)", st.lastDep != null ? fmtAbs(st.lastDep) : "—", "主档方案里最晚的出发时刻；更晚的慢/超预算车见下方说明"],
  ].map(([k, v, tip]) => `<div class="cell" title="${tip || ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")
    + `<div class="cell" id="d-fare" title="按典型方案的实际经由里程 × 分席别费率粗略估算（二等座/硬座口径）。往返两个方向选取的典型车次席别可能不同（如去 G 回 D），估算价随之不同。GTFS 无票价数据，仅供量级参考，以 12306 为准。"><div class="k">里程·票价(二等座, 估)</div><div class="v">…</div></div>`
    + (st.slowCnt > 0 ? `<p class="mini" style="grid-column:1/-1;margin:2px 0 0">另有 ${st.slowCnt} 班更慢或超预算的方案（${st.slowCnt === 1 ? "出发" : "最晚"} ${st.slowLastDep != null ? fmtAbs(st.slowLastDep) : ""}）${st.slowLastDep != null && st.slowLastDep >= d1Abs() ? "，已超出下方时间轴范围" : ""}，淡色显示且不计入上述统计。</p>` : "");
  // 里程/票价估算(取耗时最接近典型值的方案)
  try {
    const durs2 = st.js.slice().sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
    const rep = durs2.reduce((p, c) => Math.abs(c[1] - c[0] - st.typ) < Math.abs(p[1] - p[0] - st.typ) ? c : p, durs2[0]);
    const f = state.dateOff * 1440 + state.fromMin, t = state.dateOff * 1440 + state.untilMin;
    api(`/api/itinerary?o=${state.origin.stops.join(",")}&f=${f}&t=${t}&cls=${state.cls}&st=${rep[4]}&s=${stopI}&j=${rep[2]}`).then((r) => {
      const el = $("d-fare");
      if (el && r && r.kmTotal != null) {
        el.innerHTML = `<div class="k">里程·票价(二等座, 估)</div><div class="v">${Math.round(r.kmTotal)}km · ≈¥${r.fareEst}</div>`;
      } else if (el) { el.style.display = "none"; }
    }).catch(() => { const el = $("d-fare"); if (el) el.style.display = "none"; });
  } catch (e) { /* 忽略 */ }

  // 约束块
  const c = state.constraint;
  const conOn = c.on && c.name;
  if (conOn && c.stops.includes(stopI)) {
    const el0 = $("d-const");
    el0.classList.remove("hidden");
    el0.className = "d-const ok";
    el0.innerHTML = `<b>这里就是对端 B（${c.name}）本身</b>——它已在 B 端圈内，无需另查衔接。`;
  } else if (conOn) {
    const tag = conTag(stopI); // 本站口径
    // 同城口径(与列表一致): 最晚出发取各站最大, 到达取各站最早
    let cityMax = -1, cityFirst = null;
    for (let i = 0; i < STATIONS.length; i++) {
      if (STATIONS[i].c !== s.c || !state.stats.has(i)) continue;
      const st2 = state.stats.get(i);
      if (cityFirst == null || st2.firstArr < cityFirst) cityFirst = st2.firstArr;
      const v = state.conLabel ? state.conLabel[i] : -1;
      if (v > cityMax) cityMax = v;
    }
    const cityTag = conTagByMax(cityMax, cityMax >= 0 && cityFirst != null ? cityMax - cityFirst : null);
    const el = $("d-const");
    el.classList.remove("hidden");
    el.className = `d-const ${cityTag.cls}`;
    const dName = c.name;
    const dTime = c.timeMin == null ? "" : fmtClock(c.timeMin), dDay = anchorDateStr(c.dateOff);
    const byText = c.timeMin == null ? `${dDay}当天内` : `${dDay} ${dTime} 前`;
    el.innerHTML = cityTag.cls === "bad"
      ? `<b>B 端条件：无法在 ${byText}从 ${s.c} 到达 ${dName}</b>——发车早于可到达时刻，或${c.xf === 0 ? "无直达班次" : c.xf > 0 ? `换乘≤${c.xf}次内无解` : "无可行衔接"}（本站 ${s.n}：${tag.txt}）`
      : cityTag.cls === "ok"
        ? `<b>B 端条件：</b>（同城口径）${cityTag.txt}，${byText}可达 <b>${dName}</b>${state.conArr && state.conArr[stopI] >= 0 ? `<span class="mini">（该班 ${fmtClock(state.conArr[stopI])} 到）</span>` : ""}<span class="mini">（本站 ${s.n}：${tag.txt}）</span><br>
           <span class="mini">（按时刻表${c.cls && c.cls !== "all" ? (c.cls === "gdc" ? "高铁动车" : "普速") : "全部"}班次计算${c.dur > 0 ? `，到 B 限时 ${fmtDur(c.dur)}` : ""}${c.xf >= 0 ? `，${c.xf === 0 ? "仅直达" : `换乘 ≤${c.xf} 次`}` : ""}，同站换乘已留 15 分钟衔接；提前购票仍建议留余量${c.stops.length > 1 ? `；B 含 ${c.stops.length} 站（${c.stops.slice(0, 4).map((i) => STATIONS[i].n).join("、")}${c.stops.length > 4 ? "…" : ""}），到站≠到家，请留意市内接驳` : ""}）</span><br>
           <button type="button" class="ghost" id="btn-xleg">查看 ${s.c}（各站）→ ${dName} 的方案</button>`
        : `<b>B 端条件（注意）：</b>（同城口径）${cityTag.txt}——才能${byText}到达 <b>${dName}</b><span class="mini">（本站 ${s.n}：${tag.txt}）</span><br>
           <span class="mini">（按时刻表${c.cls && c.cls !== "all" ? (c.cls === "gdc" ? "高铁动车" : "普速") : "全部"}班次计算${c.dur > 0 ? `，到 B 限时 ${fmtDur(c.dur)}` : ""}${c.xf >= 0 ? `，${c.xf === 0 ? "仅直达" : `换乘 ≤${c.xf} 次`}` : ""}，同站换乘已留 15 分钟衔接）</span><br>
           <button type="button" class="ghost" id="btn-xleg">查看 ${s.c}（各站）→ ${dName} 的方案</button>`;
    const b = $("btn-xleg");
    if (b) b.onclick = () => loadXLeg(stopI);
  } else {
    $("d-const").classList.add("hidden");
  }

  renderStrip(st.js, null, { coreCut: st.coreCut });
  $("d-itin").innerHTML = "";

  // 选中环
  if (selectedRing) map.removeLayer(selectedRing);
  const [la, lo] = wgs2gcj(s.la, s.lo);
  selectedRing = L.circleMarker([la, lo], {
    renderer: sharedRenderer, radius: 13, color: "#111", weight: 2.5, fillOpacity: 0,
    dashArray: "4 3",
  }).addTo(map);
  map.panTo([la, lo], { animate: true });
}

function renderStrip(js, container, opts) {
  const el = container || $("d-strip");
  opts = opts || {};
  if (!js || !js.length) { el.innerHTML = `<p class="mini">无可行方案</p>`; return; }
  const W = 404, padL = 6, padR = 6;
  const dayStart = opts.dayStart != null ? opts.dayStart : state.dateOff * 1440 + state.fromMin;
  const coreCut = opts.coreCut != null ? opts.coreCut : null;
  // 主档方案用于限制横轴范围: 慢/超预算方案不拉伸坐标轴
  const coreJs = coreCut != null ? js.filter((j) => j[1] - j[0] <= coreCut) : js;
  const refJs = coreJs.length ? coreJs : js;
  let d0 = Math.min(refJs[0][0], dayStart);
  let d1 = Math.max(refJs[refJs.length - 1][1], d0 + 360);
  const hiddenSlow = coreCut != null ? js.filter((j) => j[1] - j[0] > coreCut && j[0] >= d1) : [];
  // 向整点对齐
  d0 = Math.floor(d0 / 60) * 60;
  d1 = Math.ceil(d1 / 60) * 60;
  const lanes = [];
  const bars = [];
  let minDur = Infinity;
  for (const j of js) minDur = Math.min(minDur, j[1] - j[0]);
  const slowCut = coreCut != null ? coreCut : minDur + 120;
  for (const j of js) {
    if (j[0] >= d1) continue; // 域外慢方案不画, 计入 hiddenSlow 说明
    let li = lanes.findIndex((end) => end + 4 <= j[0]);
    if (li < 0) { lanes.push(j[1]); li = lanes.length - 1; } else lanes[li] = j[1];
    bars.push({ j, li });
  }
  const bottomPad = hiddenSlow.length ? 18 : 6;
  const H = 26 + lanes.length * 16 + bottomPad;
  const x = (t) => padL + ((t - d0) / (d1 - d0)) * (W - padL - padR);
  let g = "";
  const day0 = Math.floor(dayStart / 1440) * 1440; // 查询日 00:00, "次日"以它为基准
  const midnight = day0 + 1440;
  if (d0 < midnight && d1 > midnight) {
    g += `<line x1="${x(midnight)}" y1="18" x2="${x(midnight)}" y2="${H - bottomPad + 2}" stroke="#b9c4cf" stroke-width="1" stroke-dasharray="3 3"/>
          <text x="${x(midnight)}" y="14" font-size="9" fill="#8a97a5" text-anchor="middle">午夜</text>`;
  }
  for (let t = d0; t <= d1; t += 120) {
    if (t === midnight) continue; // 午夜线已标
    const lbl = t >= midnight ? `次日${fmtClock(t)}` : fmtClock(t);
    g += `<line x1="${x(t)}" y1="20" x2="${x(t)}" y2="${H - bottomPad + 2}" stroke="#e3e8ee" stroke-width="1"/>
          <text x="${x(t)}" y="14" font-size="10" fill="#7b8a99" text-anchor="middle">${lbl}</text>`;
  }
  const multiOrigin = state.origin && state.origin.stops.length > 1;
  const rects = bars.map((b, i) => {
    const [dep, arr, legs, ft, st, os] = b.j;
    const dur = arr - dep;
    const w = Math.max(Math.min(x(arr), W - padR) - x(dep), 3.5);
    const trip = NAMES[ft] || "";
    const slow = dur > slowCut;
    const pre = opts.labelOf ? opts.labelOf(b.j) : (multiOrigin && os != null ? `自${STATIONS[os].n} ` : "");
    const suf = opts.arrOf ? opts.arrOf(b.j, i) : "";
    const y = 26 + b.li * 16;
    const nowAbs0 = state.dateOff === 0 ? Math.floor((Date.now() - new Date(state.anchor || Date.now()).setHours(0, 0, 0, 0)) / 60000) : -1;
    const departed = dep < nowAbs0 && nowAbs0 >= 0;
    const label = w >= 40 ? `<text x="${x(dep) + 3}" y="${y + 8.5}" font-size="9" fill="${departed ? "#9aa7b4" : "#fff"}" style="pointer-events:none">${fmtClock(dep)}${w >= 58 ? "→" + fmtClock(arr) : ""}${w >= 110 ? " " + (NAMES[ft] || "") : ""}</text>` : "";
    // 命中区比可见条更宽更高, 便于点击; 悬停提示挂在命中区上
    return `<g><rect class="bar" data-i="${i}" x="${x(dep) - 2}" y="${y - 3}" width="${Math.max(w, 12) + 4}" height="18" fill="transparent">
      <title>${departed ? "【已发车】" : ""}${pre}${trip} ${fmtAbs(dep)}→${fmtAbs(arr)} · ${fmtDur(dur)} · ${legs === 1 ? "直达" : `换乘${legs - 1}次`}${slow ? " · 慢/超预算方案" : ""}${suf}</title></rect>
      <rect x="${x(dep)}" y="${y}" width="${w}" height="12" rx="3" pointer-events="none"
      fill="${departed ? "#b9c4cf" : TRA_COLOR[Math.min(legs, 3) - 1]}" fill-opacity="${departed ? 0.35 : (slow ? 0.25 : 0.92)}" stroke="#2b2b2b" stroke-width="0.5"${departed ? ' stroke-dasharray="3 2"' : ""}/>${label}</g>`;
  }).join("");
  const cap = hiddenSlow.length ? `<text x="${W - padR}" y="${H - 5}" font-size="9.5" fill="#8a97a5" text-anchor="end">另有 ${hiddenSlow.length} 班慢/超预算车未画出（最晚 ${fmtAbs(hiddenSlow[hiddenSlow.length - 1][0])} 出发）</text>` : "";
  // 班次文字列表: 车次/时刻/耗时/换乘/到达站一目了然
  const listRows = bars.map((b, i) => {
    const [dep, arr, legs, ft, st, os] = b.j;
    const dur = arr - dep;
    const pre2 = opts.labelOf ? opts.labelOf(b.j) : (multiOrigin && os != null ? `自${STATIONS[os].n} ` : "");
    const suf2 = opts.arrOf ? opts.arrOf(b.j, i) : "";
    return `<div class="jrow" data-i="${i}">${pre2}<b>${NAMES[ft] || ""}</b> ${fmtClock(dep)}→${fmtClock(arr)} · ${fmtDur(dur)} · ${legs === 1 ? "直达" : `换乘${legs - 1}次`}${suf2}</div>`;
  }).join("");
  el.innerHTML = (opts.title ? `<p class="mini">${opts.title}</p>` : "") +
    `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${g}${rects}${cap}</svg>` +
    `<details class="jlist"><summary>${opts.listTitle || "以文字查看全部"} ${bars.length} 班<span class="mini">（同一列车跨线/上下行可能显示双号，如 G3287/G3290，为同一班车）</span></summary><div class="jrows">${listRows}</div></details>`;
  el.querySelectorAll(".bar").forEach((r) => {
    r.onclick = () => {
      const i = Number(r.dataset.i);
      if (opts.onBar) opts.onBar(js[i], opts.stops ? opts.stops[i] : null);
      else loadItinerary(js[i], state.selected);
    };
  });
  el.querySelectorAll(".jrow").forEach((r) => {
    r.onclick = () => {
      const i = Number(r.dataset.i);
      if (opts.onBar) opts.onBar(js[i], opts.stops ? opts.stops[i] : null);
      else loadItinerary(js[i], state.selected);
    };
  });
}

async function loadItinerary(j, stopI, ctx) {
  const [dep, arr, legs, ft, st] = j;
  const o = (ctx ? ctx.o : state.origin.stops).join(",");
  const f = ctx ? ctx.f : state.dateOff * 1440 + state.fromMin;
  const t = ctx ? ctx.t : state.dateOff * 1440 + state.untilMin;
  const target = stopI != null ? stopI : state.selected;
  if (target == null) return;
  $("d-itin").innerHTML = `<p class="mini">加载行程…</p>`;
  try {
    const r = await api(`/api/itinerary?o=${o}&f=${f}&t=${t}&cls=all&st=${st}&s=${target}&j=${legs}`);
    const el = $("d-itin");
    if (!r.legs.length) { el.innerHTML = `<p class="mini">行程重构失败</p>`; return; }
    let html = `<h4>行程详情 <span class="mini">${fmtAbs(r.legs[0].dep)} 出发 → ${fmtAbs(r.legs[r.legs.length - 1].arr)} 到达 · 共 ${fmtDur(r.legs[r.legs.length - 1].arr - r.legs[0].dep)}${r.legs.length > 1 ? ` · 换乘${r.legs.length - 1}次` : " · 直达"}</span></h4><div class="itin">`;
    r.legs.forEach((l, i) => {
      if (i > 0) {
        const wait = l.dep - r.legs[i - 1].arr;
        html += `<div class="transfer">🔁 ${STATIONS[l.from].n} 换乘 · 停留 ${fmtDur(wait)}</div>`;
      }
      html += `<div class="leg">
        <div class="t1"><span class="tripno cls-${l.cls}">${l.trip}</span><span class="mini">${fmtDur(l.arr - l.dep)}</span></div>
        <div class="rt"><span>${fmtAbs(l.dep)} <b>${STATIONS[l.from].n}</b></span><span>→</span><span><b>${STATIONS[l.to].n}</b> ${fmtAbs(l.arr)}</span></div>
        ${l.mids.length > 2 ? `<details class="midsbox"><summary>经停 ${l.mids.length - 2} 站</summary><div class="mids">${l.mids.slice(1, -1).map((m) => `${STATIONS[m.s].n} ${fmtAbs(m.a)}`).join(" · ")}</div></details>` : ""}
      </div>`;
    });
    html += `</div>`;
    el.innerHTML = html;
  } catch (e) {
    $("d-itin").innerHTML = `<p class="mini" style="color:#b91c1c">行程加载失败：${e.message}</p>`;
  }
}

async function loadXLeg(stopI) {
  // 查看 同城各站 -> 约束目的地 的方案（次日窗口, 含在截止前到达的）
  const c = state.constraint;
  const el = $("d-const");
  const btn = $("btn-xleg");
  if (btn) { btn.disabled = true; btn.textContent = "计算中…"; }
  try {
    const city = STATIONS[stopI].c;
    const origins = [];
    for (let i = 0; i < STATIONS.length; i++) {
      if (STATIONS[i].c === city && state.stats.has(i)) origins.push(i);
    }
    if (!origins.length) origins.push(stopI);
    const f = c.dateOff * 1440 + 6 * 60;
    const t = Math.max(conAbs(), f + 120);
    const data = await api(`/api/reach?o=${origins.join(",")}&f=${f}&t=${t}&cls=all`);
    // 汇总目的地城市所有站的方案（出发在窗口内且在截止时间前到达的）
    let all = [], allStops = [];
    const T = conAbs();
    for (const [s2, list] of data.journeys) {
      if (!c.stops.includes(s2)) continue;
      list.forEach((j) => {
        if (j[1] <= T && j[0] >= f && j[0] <= t) { all.push(j); allStops.push(s2); }
      });
    }
    // 按出发时间重排
    const order = all.map((_, i) => i).sort((a, b) => all[a][0] - all[b][0]);
    all = order.map((i) => all[i]); allStops = order.map((i) => allStops[i]);
    if (!all.length) {
      el.insertAdjacentHTML("beforeend", `<p><b>该时段无 ${city} → ${c.name} 的可行方案。</b><span class="mini">（查询条件：${anchorDateStr(c.dateOff)} 06:00 起、${fmtAbs(T)} 前到达；可行班次可能都在更早时段，或需换乘超出衔接限制）</span></p>`);
    } else {
      const durs = all.map((x) => x[1] - x[0]).sort((a, b) => a - b);
      const med = durs[Math.floor(durs.length / 2)];
      const cut = Math.max(durs[0], Math.min(durs[0] + 120, T - f));
      el.insertAdjacentHTML("beforeend",
        `<p class="mini">查询条件：${anchorDateStr(c.dateOff)} 06:00 起，自 ${city}（各站）出发、${fmtAbs(T)} 前到达 ${c.name}。
         最快 <b>${fmtDur(durs[0])}</b> · 典型 ${fmtDur(med)} · 方案 ${all.length} 个（含 ${all.filter((x) => x[2] === 1).length} 直达）</p>`);
      const holder = document.createElement("div");
      el.insertAdjacentElement("beforeend", holder);
      renderStrip(all, holder, {
        dayStart: f,
        coreCut: cut,
        stops: allStops,
        ctx: { o: origins, f, t },
        labelOf: (j) => `自${STATIONS[j[5]].n} `,
        arrOf: (j, i) => ` ${fmtClock(j[1])} 到${STATIONS[allStops[i]].n}`,
        onBar: (j, s2) => loadItinerary(j, s2, { o: origins, f, t }),
        listTitle: "以文字查看返程",
      });
    }
  } catch (e) {
    el.insertAdjacentHTML("beforeend", `<p class="mini" style="color:#b91c1c">查询失败：${e.message}</p>`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = `查看 ${STATIONS[stopI].n} → ${c.name} 的方案`; }
  }
}

/* ================= 图例 ================= */
function updateLegend() {
  $("legend").classList.remove("hidden");
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
  attachCombo("origin-input", "origin-drop", "origin-chosen", (it) => {
    if (!it) {
      state.origin = null;
      $("origin-stns").classList.add("hidden"); $("origin-stns").innerHTML = "";
      renderOrigin(); return;
    }
    state.origin = {
      name: it.name, city: it.type === "city" ? it.name : STATIONS[it.stops[0]].c,
      allStops: it.stops.slice(), stops: it.stops.slice(),
    };
    renderOrigin();
    renderStationChecks("origin-stns", state.origin, () => { if (state.queried) runQuery(); });
  });
  attachCombo("dest-input", "dest-drop", "dest-chosen", (it) => {
    if (!it) {
      state.constraint.name = null; state.constraint.stops = []; state.constraint.allStops = [];
      $("dest-stns").classList.add("hidden"); $("dest-stns").innerHTML = "";
      return;
    }
    const det = $("detail"); if (det) det.classList.add("hidden");
    state.constraint.name = it.name;
    state.constraint.allStops = it.stops.slice();
    state.constraint.stops = it.stops.slice();
    renderStationChecks("dest-stns", state.constraint, () => { if (state.queried) runQuery(); });
    $("constraint-box").open = true;
  });

  $("date-sel").onchange = (e) => {
    state.dateOff = Number(e.target.value);
    if (state.constraint.dateOff < state.dateOff) { // B 端日期不早于 A 端出发日
      state.constraint.dateOff = state.dateOff;
      $("cdate-sel").value = String(state.dateOff);
    }
    const av = timeToMin($("arrive-by").value);
    state.arriveBy = av == null ? null : state.dateOff * 1440 + av;
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
    $("budget-label").textContent = `${fmtDur(a)} – ${fmtDur(b)}`;
    syncPresetChips();
  }
  bmin.oninput = () => { syncBudget(); if (state.queried) { renderMapResult(); renderList(); } };
  bmax.oninput = () => { syncBudget(); if (state.queried) { renderMapResult(); renderList(); } };
  document.querySelectorAll(".chip[data-budget]").forEach((b) => {
    b.onclick = () => {
      const [a, c] = b.dataset.budget.split(",").map(Number);
      bmin.value = a; bmax.value = c; syncBudget();
      if (state.queried) { renderMapResult(); renderList(); }
    };
  });

  document.querySelectorAll('input[name=cls]').forEach((r) => r.onchange = (e) => { state.cls = e.target.value; if (state.queried) runQuery(); });
  document.querySelectorAll('input[name=tra]').forEach((r) => r.onchange = (e) => {
    state.maxTra = Number(e.target.value);
    if (state.queried) { computeStats(); renderMapResult(); renderList(); if (state.selected != null) selectDestination(state.selected, true); }
  });

  $("arrive-by").onchange = (e) => {
    const v = timeToMin(e.target.value);
    state.arriveBy = v == null ? null : state.dateOff * 1440 + v;
    if (state.queried) { computeStats(); renderMapResult(); renderList(); if (state.selected != null) selectDestination(state.selected, true); }
  };

  $("cstay-sel").onchange = (e) => { state.constraint.stayMin = Number(e.target.value); renderList(); };
  $("cdur-sel").onchange = (e) => { state.constraint.dur = Number(e.target.value); if (state.queried) runQuery(); };
  $("cxf-sel").onchange = (e) => { state.constraint.xf = Number(e.target.value); if (state.queried) runQuery(); };
  $("ccls-sel").onchange = (e) => { state.constraint.cls = e.target.value; if (state.queried) runQuery(); };
  $("cdate-sel").onchange = (e) => { state.constraint.dateOff = Number(e.target.value); if (state.queried) runQuery(); };
  // "不晚于"可清空(=当天不限); 清空也是一次合法变更, 需触发重查
  $("ctime-input").onchange = (e) => { state.constraint.timeMin = timeToMin(e.target.value); if (state.queried) runQuery(); };
  let ctimeDeb = null; // 输入过程中防抖重查: 不必等失焦/回车
  $("ctime-input").addEventListener("input", (e) => {
    clearTimeout(ctimeDeb);
    ctimeDeb = setTimeout(() => {
      const v = timeToMin(e.target.value);
      if (v !== state.constraint.timeMin) { state.constraint.timeMin = v; if (state.queried) runQuery(); }
    }, 700);
  });
  $("ctfrom-input").onchange = (e) => { state.constraint.tFromMin = timeToMin(e.target.value); if (state.queried) runQuery(); };
  let ctfromDeb = null;
  $("ctfrom-input").addEventListener("input", (e) => {
    clearTimeout(ctfromDeb);
    ctfromDeb = setTimeout(() => {
      const v = timeToMin(e.target.value);
      if (v !== state.constraint.tFromMin) { state.constraint.tFromMin = v; if (state.queried) runQuery(); }
    }, 700);
  });
  $("constr-only").onchange = (e) => { state.constraint.only = e.target.checked; if (state.queried) { renderMapResult(); renderList(); } };
  // 约束启用 = 选择了目的地即启用
  const obs = new MutationObserver(() => {
    const on = !!state.constraint.name;
    if (on !== state.constraint.on) { state.constraint.on = on; if (state.queried) runQuery(); }
  });
  obs.observe($("dest-chosen"), { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });

  $("colorby-sel").onchange = (e) => { state.colorBy = e.target.value; updateLegend(); if (state.queried) renderMapResult(); };
  $("sort-sel").onchange = () => { $("sort-sel").dataset.touched = "1"; renderList(); };
  $("size-sel").onchange = () => renderList();
  $("region-sel").onchange = () => renderList();
  $("maxkm-input").onchange = () => renderList();

  $("btn-query").onclick = runQuery;
  $("d-close").onclick = () => { $("detail").classList.add("hidden"); if (selectedRing) { map.removeLayer(selectedRing); selectedRing = null; } };
  $("list-toggle").onclick = () => {
    const p = $("list-panel");
    p.classList.toggle("hidden");
    $("list-toggle").textContent = p.classList.contains("hidden") ? "目的地列表 ▲" : "收起列表 ▼";
  };

  $("btn-help").onclick = () => $("help-overlay").classList.remove("hidden");
  $("help-close").onclick = () => { $("help-overlay").classList.add("hidden"); try { localStorage.setItem("railHelpDismissed", "1"); } catch (e) { } };
  $("help-demo").onclick = () => { $("help-overlay").classList.add("hidden"); demoFill(); };
  $("btn-demo").onclick = demoFill;

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
function applyNowPreset() {
  const now = new Date();
  setWindow(Math.min(now.getHours() * 60 + now.getMinutes(), 23 * 60), END_OF_DAY);
  $("date-sel").value = "0";
  state.dateOff = 0;
}

function demoFill() {
  // 示例：长沙 · 3–4h · 明晚 19:00 前到上海
  const cs = cityIndex.find((c) => c.name === "长沙");
  const ds = cityIndex.find((c) => c.name === "上海");
  if (!cs || !ds) { setStatus("示例城市未找到", true); return; }
  const oi = $("origin-input");
  oi.classList.add("hidden");
  const oc = $("origin-chosen");
  oc.classList.remove("hidden");
  oc.innerHTML = `<span title="${cs.stops.map((x) => STATIONS[x].n).join("、")}">长沙（${cs.stops.length} 站）</span><button type="button">✕</button>`;
  oc.querySelector("button").onclick = () => {
    oc.classList.add("hidden"); oi.classList.remove("hidden"); oi.value = ""; state.origin = null;
    $("origin-stns").classList.add("hidden"); $("origin-stns").innerHTML = ""; renderOrigin();
  };
  state.origin = { name: "长沙", city: "长沙", allStops: cs.stops.slice(), stops: cs.stops.slice() };
  renderOrigin();
  renderStationChecks("origin-stns", state.origin, () => { if (state.queried) runQuery(); });

  $("budget-min").value = 180; $("budget-max").value = 240;
  $("budget-min").dispatchEvent(new Event("input"));

  const di = $("dest-input");
  di.classList.add("hidden");
  const dc = $("dest-chosen");
  dc.classList.remove("hidden");
  dc.innerHTML = `<span title="${ds.stops.map((x) => STATIONS[x].n).join("、")}">上海（${ds.stops.length} 站）</span><button type="button">✕</button>`;
  dc.querySelector("button").onclick = () => {
    dc.classList.add("hidden"); di.classList.remove("hidden"); di.value = ""; state.constraint.name = null; state.constraint.stops = []; state.constraint.allStops = [];
    $("dest-stns").classList.add("hidden"); $("dest-stns").innerHTML = "";
  };
  state.constraint.name = "上海"; state.constraint.allStops = ds.stops.slice(); state.constraint.stops = ds.stops.slice(); state.constraint.on = true;
  renderStationChecks("dest-stns", state.constraint, () => { if (state.queried) runQuery(); });
  $("constraint-box").open = true;
  $("cdate-sel").value = "1"; state.constraint.dateOff = 1;
  $("ctime-input").value = "19:00"; state.constraint.timeMin = 19 * 60;

  applyNowPreset();
  runQuery();
}

/* ================= 启动 ================= */
async function boot() {
  try {
    state.anchor = new Date();
    const meta = await api("/api/meta");
    STATIONS = meta.stations; NAMES = meta.names; META = meta.meta;
    $("data-badge").textContent = `时刻表周更快照 ${(m => m ? `${m[1]}-${m[2]}-${m[3]}` : META.release)(META.release.match(/(\d{4})(\d{2})(\d{2})/))} · ${META.trips.toLocaleString()} 班/日 · ${META.stations.toLocaleString()} 站 · 购票以 12306 为准`;
    buildCityIndex();
    buildGrayLayer();
    refreshLabels();
    initEvents();
    fillDates(); // 14 天日期选项
    // 配色选择器
    const ps = $("palette-sel");
    Object.entries(PALETTES).forEach(([k, v]) => ps.add(new Option(v.name, k)));
    let pal = "rainbow";
    try { pal = localStorage.getItem("railPalette") || "rainbow"; } catch (e) { }
    ps.value = pal in PALETTES ? pal : "rainbow";
    setPalette(ps.value);
    ps.onchange = (e) => setPalette(e.target.value);
    const now = new Date();
    state.fromMin = Math.min(now.getHours() * 60 + now.getMinutes(), 23 * 60);
    state.untilMin = END_OF_DAY;
    $("from-time").value = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    $("until-time").value = "23:59";
    setStatus("选择出发地后点击「查询可达性」。首次使用可点「使用说明」或直接试示例场景。");
    let dismissed = false;
    try { dismissed = !!localStorage.getItem("railHelpDismissed"); } catch (e) { }
    if (!dismissed) $("help-overlay").classList.remove("hidden");
  } catch (e) {
    setStatus(`数据加载失败：${e.message}`, true);
  }
}
boot();
