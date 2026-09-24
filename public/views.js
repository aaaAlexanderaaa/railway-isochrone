/* 等时圈视图（取数条件）+ 城市交集
 * 产品形态（2026-09-24 用户需求）：一个通用取数模板 = {方向(出发/抵达), 地点, 日期,
 * 时段, 预算上限, 车种, 换乘}。主表单即视图0；本模块管理附加视图 1..N，查询时逐一取数，
 * 城市级取交集——不同城市的朋友各建一个圈即可选共同能到的碰头地。
 * 出发视图 = 正向 reach()（富统计）；抵达视图 = 反向 constraint()（每站最晚出发、支持时长上限）。
 * 恰好只有一个抵达视图时，镜像回 state.constraint/conLabel，让既有「最晚 X 走」列、
 * 详情约束块、btn-xleg 返程衔接等链路原样工作（旧「必须赶到」功能是该形态的特例）。 */
"use strict";

const Views = (() => {
  const MAX_VIEWS = 4;
  const COLORS = ["#7c3aed", "#0891b2", "#e11d48", "#059669", "#d97706"];
  let nextId = 1;
  let views = [];   // 配置（持久化）
  let results = new Map(); // viewId -> {kind, ok, error?, stats?, latest?, arrAt?, cities:Set, byStop:Map}
  let intersect = null;    // Set<city> 主视图带内 ∩ 各启用视图

  /* ---------- 持久化 ---------- */
  function save() {
    try {
      localStorage.setItem("railViews", JSON.stringify(views.map((v) => ({
        id: v.id, dir: v.dir, name: v.name, stops: v.stops, city: v.city,
        dateOff: v.dateOff, fromMin: v.fromMin, untilMin: v.untilMin,
        bmax: v.bmax, cls: v.cls, maxTra: v.maxTra, arrBy: v.arrBy,
        color: v.color, visible: v.visible,
      }))));
    } catch (e) { /* ignore */ }
  }
  function load() {
    try {
      const a = JSON.parse(localStorage.getItem("railViews") || "[]");
      if (Array.isArray(a)) {
        views = a.filter((v) => v && v.name && Array.isArray(v.stops)).slice(0, MAX_VIEWS);
        views.forEach((v) => {
          v.id = Number(v.id) || nextId++;
          v.dateOff = Number(v.dateOff) || 1; v.fromMin = Number(v.fromMin) || 360;
          v.untilMin = Number(v.untilMin) || 1439; v.bmax = v.bmax == null ? 240 : Number(v.bmax); // 0=不限，合法值
          v.cls = v.cls || "all"; v.maxTra = v.maxTra == null ? 2 : Number(v.maxTra);
          v.arrBy = v.arrBy == null ? null : Number(v.arrBy);
          v.visible = v.visible !== false; v.color = v.color || COLORS[(v.id - 1) % COLORS.length];
          nextId = Math.max(nextId, v.id + 1);
        });
      }
    } catch (e) { views = []; }
  }

  const active = () => views.filter((v) => v.name && v.stops.length);
  const anyActive = () => active().length > 0;
  const intersectOn = () => anyActive() && !!document.getElementById("intersect-only")?.checked;

  function addView(preset) {
    if (views.length >= MAX_VIEWS) { setStatus(`最多叠加 ${MAX_VIEWS} 个圈（够 4 个朋友各建一个了）`, true); return null; }
    const v = Object.assign({
      id: nextId++, dir: "dep", name: null, stops: [], city: null,
      dateOff: (typeof state !== "undefined" && state.dateOff) || 1,
      fromMin: 6 * 60, untilMin: END_OF_DAY, bmax: 240,
      cls: "all", maxTra: 2, arrBy: null,
      color: COLORS[(nextId - 2) % COLORS.length], visible: true,
    }, preset || {});
    if (preset && preset.color) v.color = preset.color;
    views.push(v);
    save(); renderCards();
    return v;
  }
  function removeView(id) {
    views = views.filter((v) => v.id !== id);
    results.delete(id);
    save(); renderCards();
  }
  function patchView(id, patch, opts) {
    const v = views.find((x) => x.id === id);
    if (!v) return;
    Object.assign(v, patch);
    save();
    if (!opts || !opts.noRerender) renderCards();
    if (opts && opts.rerun && state.queried) runQuery();
  }

  /* ---------- 卡片 UI ---------- */
  function dateOptions(sel) {
    let html = "";
    for (let d = 0; d <= 13; d++) html += `<option value="${d}">${anchorDateStr(d)}</option>`;
    return html;
  }
  const BMAX_OPTS = [[0, "不限"], [60, "≤1h"], [90, "≤1.5h"], [120, "≤2h"], [180, "≤3h"], [240, "≤4h"], [300, "≤5h"], [360, "≤6h"], [480, "≤8h"], [720, "≤12h"], [1440, "≤24h"]];
  const TRA_OPTS = [[0, "直达"], [1, "≤1次"], [2, "≤2次"]];
  const CLS_OPTS = [["all", "全部"], ["gdc", "高铁动车"], ["psk", "普速"]];

  function renderCards() {
    const wrap = document.getElementById("views-list");
    if (!wrap) return;
    wrap.innerHTML = "";
    for (const v of views) wrap.appendChild(cardEl(v));
    const iw = document.getElementById("intersect-only-wrap");
    if (iw) iw.style.display = views.length ? "" : "none";
    // 交集开关文案随视图数变化
    const cb = document.getElementById("intersect-only");
    if (cb && cb.labels && cb.labels[0]) {
      cb.labels[0].childNodes[0].textContent = views.length > 1 ? " 只看各圈交集城市（地图高亮 + 列表按交集过滤）" : " 只看与主查询的交集城市";
    }
  }

  function cardEl(v) {
    const el = document.createElement("div");
    el.className = "view-card";
    el.dataset.id = v.id;
    const arrByTxt = v.arrBy == null ? "" : `${pad2(Math.floor(v.arrBy / 60))}:${pad2(v.arrBy % 60)}`;
    el.innerHTML = `
      <div class="vc-head">
        <span class="vc-dot" style="background:${v.color}"></span>
        <div class="seg vc-dir" data-id="${v.id}">
          <label><input type="radio" name="vdir-${v.id}" value="dep" ${v.dir === "dep" ? "checked" : ""}><span>出发</span></label>
          <label><input type="radio" name="vdir-${v.id}" value="arr" ${v.dir === "arr" ? "checked" : ""}><span>抵达</span></label>
        </div>
        <input class="vc-place" type="text" placeholder="城市或车站" autocomplete="off" value="${v.name || ""}">
        <button type="button" class="vc-del" title="删除这个圈">✕</button>
      </div>
      <div class="vc-body">
        <div class="crow vc-row1">
          <label class="vc-f">日期<br><select class="vc-date">${dateOptions()} </select></label>
          <label class="vc-f">时段<br><span class="timerange"><input type="time" class="vc-from" step="300"> – <input type="time" class="vc-until" step="300"></span></label>
          <label class="vc-f vc-arrby ${v.dir === "arr" ? "" : "hidden"}">不晚于<br><input type="time" class="vc-arrby" step="300" placeholder="23:59" title="该时刻前抵达目的地才算数；留空=当天不限"></label>
        </div>
        <div class="crow vc-row2">
          <label class="vc-f">预算<br><select class="vc-bmax"></select></label>
          <label class="vc-f">换乘<br><select class="vc-tra"></select></label>
          <label class="vc-f">车种<br><select class="vc-cls"></select></label>
          <label class="vc-f vc-foot-check"><input type="checkbox" class="vc-vis" ${v.visible ? "checked" : ""}>显示该圈</label>
        </div>
        <div class="vc-status mini"></div>
      </div>`;

    const $c = (cls) => el.querySelector("." + cls);
    $c("vc-date").value = String(v.dateOff);
    $c("vc-from").value = `${pad2(Math.floor(v.fromMin / 60) % 24)}:${pad2(v.fromMin % 60)}`;
    $c("vc-until").value = `${pad2(Math.floor(v.untilMin / 60) % 24)}:${pad2(Math.min(v.untilMin % 60, 59))}`;
    $c("vc-arrby").value = arrByTxt;
    // 预算选项随方向变化：出发圈无「不限」(无上限=全国)，抵达圈保留(旧「必须赶到」默认不限时长)
    const bmaxOpts = v.dir === "arr" ? BMAX_OPTS : BMAX_OPTS.filter((o) => o[0] > 0);
    if (v.dir === "dep" && !bmaxOpts.some((o) => o[0] === v.bmax)) v.bmax = 240;
    $c("vc-bmax").innerHTML = bmaxOpts.map(([val, txt]) => `<option value="${val}" ${v.bmax === val ? "selected" : ""}>${txt}</option>`).join("");
    $c("vc-tra").innerHTML = TRA_OPTS.map(([val, txt]) => `<option value="${val}" ${v.maxTra === val ? "selected" : ""}>${txt}</option>`).join("");
    $c("vc-cls").innerHTML = CLS_OPTS.map(([val, txt]) => `<option value="${val}" ${v.cls === val ? "selected" : ""}>${txt}</option>`).join("");

    const st = results.get(v.id);
    $c("vc-status").textContent = statusText(v, st);

    el.querySelector(".vc-del").onclick = () => {
      removeView(v.id);
      if (state.queried) runQuery();
    };
    el.querySelectorAll(`input[name=vdir-${v.id}]`).forEach((r) => r.onchange = (e) => {
      patchView(v.id, { dir: e.target.value }, { noRerender: true });
      renderCards(); // 预算选项随方向重算（抵达圈才允许「不限」）
      if (state.queried) runQuery();
    });

    // 地点：复用主输入的搜索逻辑（城市索引 + 车站），但挂在卡片输入框上
    const placeInput = $c("vc-place");
    attachPlaceSearch(placeInput, (it) => {
      patchView(v.id, {
        name: it.name, stops: it.stops.slice(),
        city: it.type === "city" ? it.name : STATIONS[it.stops[0]].c,
      }, { noRerender: true });
      placeInput.classList.remove("vc-bad");
      if (state.queried) runQuery();
      else setStatus(`已建好「${dirLabel(v)}${it.name}」圈。${views.length > 1 ? "多个圈会在查询后自动取交集。" : ""}调整日期/时段/预算后点「查询可达性」。`);
    });

    $c("vc-date").onchange = (e) => {
      const d = Number(e.target.value);
      const patch = { dateOff: d };
      if (d < state.dateOff) patch.dateOff = state.dateOff; // 不早于主查询出发日
      patchView(v.id, patch, { noRerender: true });
      e.target.value = String(patch.dateOff);
      if (patch.dateOff !== d) setStatus(`${dirLabel(v)}圈的日期不能早于主查询出发日（${anchorDateStr(state.dateOff)}），已改为该日。`, true);
      if (state.queried) runQuery();
    };
    const tmin = (val, fb) => { const m = timeToMin(val); return m == null ? fb : m; };
    $c("vc-from").onchange = (e) => { patchView(v.id, { fromMin: tmin(e.target.value, v.fromMin) }, { noRerender: true }); if (state.queried) runQuery(); };
    $c("vc-until").onchange = (e) => { patchView(v.id, { untilMin: tmin(e.target.value, v.untilMin) }, { noRerender: true }); if (state.queried) runQuery(); };
    $c("vc-arrby").onchange = (e) => { patchView(v.id, { arrBy: timeToMin(e.target.value) }, { noRerender: true }); if (state.queried) runQuery(); };
    $c("vc-bmax").onchange = (e) => { patchView(v.id, { bmax: Number(e.target.value) }, { noRerender: true }); if (state.queried) runQuery(); };
    $c("vc-tra").onchange = (e) => { patchView(v.id, { maxTra: Number(e.target.value) }, { noRerender: true }); if (state.queried) runQuery(); };
    $c("vc-cls").onchange = (e) => { patchView(v.id, { cls: e.target.value }, { noRerender: true }); if (state.queried) runQuery(); };
    $c("vc-vis").onchange = (e) => {
      patchView(v.id, { visible: e.target.checked }, { noRerender: true });
      renderOverlay();
    };
    return el;
  }

  function dirLabel(v) {
    return v.dir === "arr" ? `必须抵达${v.name || ""}·` : `自${v.name || ""}出发·`;
  }
  function statusText(v, st) {
    if (!v.name) return "待选地点";
    if (!st) return state.queried ? "本次未计算" : "点「查询可达性」后生效";
    if (st.error) return "❌ " + st.error;
    const n = st.cities ? st.cities.size : 0;
    if (st.kind === "arr") return `${n} 城可按时抵达（数字=满足该圈的城市数）`;
    return `${n} 城在预算内`;
  }

  /* 卡片地点搜索：下拉城市/车站（与主 combobox 同源，简化版——不依赖 attachCombo 的 DOM 结构） */
  function attachPlaceSearch(input, onPick) {
    let drop = null, timer = null, items = [], active = -1;
    function ensureDrop() {
      if (drop && drop.isConnected) return drop;
      drop = document.createElement("div");
      drop.className = "drop vc-drop hidden";
      input.parentNode.style.position = "relative";
      input.parentNode.appendChild(drop);
      return drop;
    }
    function renderList() {
      const d = ensureDrop();
      if (!items.length) { d.classList.add("hidden"); return; }
      d.innerHTML = items.map((it, i) => `
        <div class="item" data-i="${i}">
          <span class="nm">${it.name}</span>
          <span class="mt">${it.type === "city" ? `${it.stops.length} 个车站 · ${it.degree} 班/日` : `车站 · ${it.degree} 班/日`}</span>
        </div>`).join("");
      d.classList.remove("hidden");
      d.querySelectorAll(".item").forEach((el2) => {
        el2.onmousedown = (e) => { e.preventDefault(); pick(Number(el2.dataset.i)); };
      });
    }
    function pick(i) {
      const it = items[i];
      drop.classList.add("hidden");
      if (it) { input.value = it.name; onPick(it); }
    }
    function search(q) {
      q = (q || "").trim();
      if (!q) { items = []; renderList(); return; }
      const rank = (name) => name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 9;
      const cs = cityIndex.filter((c) => c.name.includes(q))
        .sort((a, b) => rank(a.name) - rank(b.name) || b.degree - a.degree).slice(0, 6)
        .map((c) => ({ type: "city", name: c.name, stops: c.stops.slice(), degree: c.degree }));
      const ss = STATIONS.map((s, i) => ({ i, ...s })).filter((s) => s.n.includes(q) && s.d > 0)
        .sort((a, b) => rank(a.n) - rank(b.n) || b.d - a.d).slice(0, 8 - Math.min(cs.length, 4))
        .map((s) => ({ type: "stn", name: s.n, stops: [s.i], degree: s.d }));
      items = [...cs, ...ss];
      renderList();
    }
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => search(input.value), 150);
    });
    input.addEventListener("focus", () => search(input.value));
    input.addEventListener("keydown", (e) => {
      if (!drop || drop.classList.contains("hidden")) return;
      if (e.key === "ArrowDown") active = Math.min(active + 1, items.length - 1);
      else if (e.key === "ArrowUp") active = Math.max(active - 1, 0);
      else if (e.key === "Enter" && active >= 0) { pick(active); e.preventDefault(); return; }
      else if (e.key === "Escape") { drop.classList.add("hidden"); return; }
      else return;
      [...drop.children].forEach((el2, i) => el2.classList.toggle("active", i === active));
      e.preventDefault();
    });
    input.addEventListener("blur", () => setTimeout(() => { if (drop) drop.classList.add("hidden"); }, 160));
  }

  /* ---------- 查询 ---------- */
  // 与主查询 computeStats 同口径的参数化版本（供出发视图复用）
  function statsFor(journeys, opt) {
    const out = new Map();
    const fAbs = opt.dateOff * 1440 + opt.fromMin;
    const tAbs = opt.dateOff * 1440 + opt.untilMin;
    for (const [stopI, js0] of journeys) {
      let js = js0.filter((x) => x[2] - 1 <= opt.maxTra);
      js = js.filter((x) => x[0] >= fAbs && x[0] <= tAbs);
      if (opt.dateOff === 0) {
        const nowAbs0 = nowAbsMin();
        js = js.filter((x) => x[0] >= nowAbs0);
      }
      if (!js.length) continue;
      const pairs = js.map((x) => [x[1] - x[0], x]).sort((a, b) => a[0] - b[0]);
      const cut = Math.max(pairs[0][0], Math.min(opt.bmax, pairs[0][0] + 120));
      const core = pairs.filter((p) => p[0] <= cut);
      const coreDurs = core.map((p) => p[0]);
      const med = coreDurs.length % 2
        ? coreDurs[(coreDurs.length - 1) / 2]
        : Math.round((coreDurs[coreDurs.length / 2 - 1] + coreDurs[coreDurs.length / 2]) / 2);
      out.set(stopI, {
        typ: med, fast: pairs[0][0], cnt: core.length,
        dir: core.filter((p) => p[1][2] === 1).length,
        lastDep: core.length ? Math.max(...core.map((p) => p[1][0])) : null,
        firstDep: js[0][0], firstArr: Math.min(...js.map((x) => x[1])),
        js,
      });
    }
    return out;
  }

  async function runAll(gen) {
    results = new Map();
    intersect = null;
    clearOverlay();
    for (const v of views) {
      if (!v.name || !v.stops.length) { results.set(v.id, null); continue; }
      try {
        if (v.dir === "dep") {
          const f = v.dateOff * 1440 + v.fromMin;
          const t = v.dateOff * 1440 + v.untilMin;
          if (t <= f) throw new Error("时段无效（结束需晚于开始）");
          const data = await api(`/api/reach?o=${v.stops.join(",")}&f=${f}&t=${t}&cls=${v.cls}`);
          if (gen !== queryGen) return;
          const stats = statsFor(new Map(data.journeys), v);
          const cities = new Set();
          const byStop = new Map();
          for (const [stopI, st] of stats) {
            if (st.typ < 30 || st.typ > v.bmax) continue; // 与主表同口径: <30 分钟是通勤距离
            cities.add(STATIONS[stopI].c);
            byStop.set(stopI, st);
          }
          results.set(v.id, { kind: "dep", ok: true, stats, cities, byStop, ms: data.stats ? data.stats.ms : null });
        } else {
          const T = v.dateOff * 1440 + (v.arrBy == null ? END_OF_DAY : v.arrBy);
          const floor = v.dateOff * 1440 + v.fromMin;
          const dur = v.bmax >= 1440 ? 0 : v.bmax;
          const data = await api(`/api/constraint?d=${v.stops.join(",")}&T=${T}&floor=${floor}&xf=${v.maxTra}&dur=${dur}&cls=${v.cls}`);
          if (gen !== queryGen) return;
          const cities = new Set();
          const byStop = new Map();
          for (let s = 0; s < data.latest.length; s++) {
            const latest = data.latest[s];
            if (latest == null || latest < floor || latest < 0) continue;
            const d = data.arrAt[s] - latest;
            if (d < 30) continue; // <30 分钟视为同城
            if (v.bmax > 0 && d > v.bmax + 30) continue; // 30 分钟弹性与主表一致; bmax=0 即不限时长
            cities.add(STATIONS[s].c);
            byStop.set(s, { latest, arrAt: data.arrAt[s], dur: d });
          }
          results.set(v.id, { kind: "arr", ok: true, latest: data.latest, arrAt: data.arrAt, cities, byStop });
        }
      } catch (e) {
        if (gen !== queryGen) return;
        results.set(v.id, { kind: v.dir, ok: false, error: String(e.message || e) });
      }
    }
    computeIntersect();
    syncLegacyConstraint();
    renderCards();
    renderOverlay();
  }

  // 主视图（当前查询的预算带）城市集 ∩ 各启用视图城市集
  function mainBandCities() {
    const set = new Set();
    for (const [stopI, st] of state.stats) {
      if (st.typ < 30) continue;
      if (!(st.typ >= state.bmin - 30 && st.typ <= state.bmax)) continue;
      set.add(STATIONS[stopI].c);
    }
    return set;
  }
  function computeIntersect() {
    const act = active();
    if (!act.length) { intersect = null; return; }
    let set = mainBandCities();
    for (const v of act) {
      const r = results.get(v.id);
      if (!r || !r.ok) { intersect = new Set(); return; } // 有圈没算成 → 交集不可信，按空集处理并靠状态提示
      set = new Set([...set].filter((c) => r.cities.has(c)));
    }
    intersect = set;
  }

  // 恰好一个抵达视图 = 旧「必须赶到」单约束形态：镜像回 state.constraint，
  // 让「最晚 X 走」列 / 详情约束块 / btn-xleg 返程衔接沿用既有链路
  function syncLegacyConstraint() {
    const act = active();
    const arrVs = act.filter((v) => v.dir === "arr");
    if (arrVs.length === 1 && act.length === 1) {
      const v = arrVs[0];
      const r = results.get(v.id);
      const prev = state.constraint;
      state.constraint = {
        on: true, name: v.name, stops: v.stops.slice(), allStops: v.stops.slice(),
        dateOff: v.dateOff, timeMin: v.arrBy, only: !!document.getElementById("intersect-only")?.checked,
        dur: v.bmax >= 1440 ? 0 : v.bmax, xf: v.maxTra, cls: v.cls,
        tFromMin: v.fromMin === 6 * 60 ? null : v.fromMin, stayMin: prev && prev.stayMin || 0,
      };
      state.conLabel = r && r.ok ? r.latest : null;
      state.conArr = r && r.ok ? r.arrAt : null;
    } else {
      state.constraint = { on: false, name: null, stops: [], allStops: [], dateOff: state.dateOff, timeMin: null, only: false, dur: 0, xf: -1, cls: "all", tFromMin: null, stayMin: 0 };
      state.conLabel = null;
      state.conArr = null;
    }
  }

  /* ---------- 地图叠加 ---------- */
  let layerViews = null, layerInter = null;
  function ensureLayers() {
    if (!layerViews) {
      layerViews = L.layerGroup().addTo(map);   // 各视图散点
      layerInter = L.layerGroup().addTo(map);   // 交集城市标记
    }
  }
  function clearOverlay() {
    if (layerViews) layerViews.clearLayers();
    if (layerInter) layerInter.clearLayers();
  }
  function renderOverlay() {
    ensureLayers();
    clearOverlay();
    if (!state.queried) return;
    for (const v of active()) {
      if (!v.visible) continue;
      const r = results.get(v.id);
      if (!r || !r.ok) continue;
      for (const [stopI, info] of r.byStop) {
        const s = STATIONS[stopI];
        const [la, lo] = wgs2gcj(s.la, s.lo);
        const tip = r.kind === "dep"
          ? `<b>${s.n}</b>（${s.c}）<br>自 ${v.name} 出发 · 典型 ${fmtDur(info.typ)}`
          : `<b>${s.n}</b>（${s.c}）<br>最晚 ${fmtAbs(info.latest)} 出发 · ${fmtDur(info.dur)} 抵达 ${v.name}`;
        const m = L.circleMarker([la, lo], r.kind === "dep"
          ? { renderer: sharedRenderer, radius: 4.5, color: "#333", weight: 0.6, fillColor: v.color, fillOpacity: 0.8 }
          : { renderer: sharedRenderer, radius: 5.5, color: v.color, weight: 2, fillColor: v.color, fillOpacity: 0.12 });
        m.bindTooltip(tip, { className: "stn-tip", direction: "top" });
        m.on("click", () => { lastLayerClickTs = Date.now(); onStationClick(stopI); });
        layerViews.addLayer(m);
      }
    }
    if (intersect && intersect.size) {
      const only = intersectOn();
      for (const c of intersect) {
        const stops = [];
        for (let i = 0; i < STATIONS.length; i++) if (STATIONS[i].c === c && state.stats.has(i)) stops.push(i);
        if (!stops.length) continue;
        stops.sort((a, b) => (state.stats.get(b).cnt || 0) - (state.stats.get(a).cnt || 0));
        const s = STATIONS[stops[0]];
        const [la, lo] = wgs2gcj(s.la, s.lo);
        const lines = active().map((v) => {
          const r = results.get(v.id);
          if (!r || !r.ok) return `${v.name} ×`;
          return r.kind === "dep"
            ? `${v.name}：典型 ${fmtDur(cityBestDep(r, c).typ)}`
            : `${v.name}：最晚 ${fmtClock(cityBestArr(r, c).latest)} 走`;
        });
        const m = L.circleMarker([la, lo], {
          renderer: sharedRenderer, radius: 9, color: "#111827", weight: 2.4,
          fillColor: "#ffffff", fillOpacity: 0.95,
        });
        m.bindTooltip(`<b>⊕ ${c} · 各圈交集</b><br>${lines.join("<br>")}<br><span style="opacity:.7">点击看详情</span>`, { className: "stn-tip inter-tip", direction: "top" });
        m.on("click", () => { lastLayerClickTs = Date.now(); onStationClick(stops[0]); });
        if (only || active().length > 1) layerInter.addLayer(m);
      }
    }
  }

  /* ---------- 表格/详情 ---------- */
  function cityBestDep(r, city) {
    let best = null;
    for (const [stopI, st] of r.byStop) {
      if (STATIONS[stopI].c !== city) continue;
      if (!best || st.typ < best.st.typ) best = { stopI, st };
    }
    return best || { stopI: -1, st: { typ: 0, cnt: 0, dir: 0 } };
  }
  function cityBestArr(r, city) {
    let best = null;
    for (const [stopI, info] of r.byStop) {
      if (STATIONS[stopI].c !== city) continue;
      if (!best || info.latest > best.info.latest) best = { stopI, info };
    }
    return best || { stopI: -1, info: { latest: -1, arrAt: -1, dur: 0 } };
  }

  // 列表行"后续约束/各圈情况"单元格
  function rowCell(city) {
    const act = active();
    if (!act.length) return null;
    const bits = act.map((v) => {
      const r = results.get(v.id);
      if (!r || !r.ok) return `<span class="tag na" title="该圈未算成">${v.name}×</span>`;
      if (!r.cities.has(city)) return `<span class="tag bad" title="该圈不含此城市">✗ ${v.name}</span>`;
      if (r.kind === "dep") {
        const b = cityBestDep(r, city);
        return `<span class="tag ok" title="自 ${v.name} 出发，典型 ${fmtDur(b.st.typ)}、方案 ${b.st.cnt}">● ${v.name} ${fmtDur(b.st.typ)}</span>`;
      }
      const b = cityBestArr(r, city);
      return `<span class="tag ok" title="最晚 ${fmtAbs(b.info.latest)} 出发、${fmtDur(b.info.dur)} 抵达 ${v.name}">● ${v.name} 最晚${fmtClock(b.info.latest)}走</span>`;
    });
    return bits.join(" ");
  }

  // 详情面板的视图摘要块（多视图形态下替代旧 d-const 单约束块）
  function detailBlock(city, stopI) {
    const act = active();
    if (!act.length) return "";
    const rows = act.map((v) => {
      const r = results.get(v.id);
      let body;
      if (!r || !r.ok) body = `<span class="tag bad">未算成：${r && r.error ? r.error : "—"}</span>`;
      else if (!r.cities.has(city)) body = `<span class="tag bad">此城不在该圈（超预算/时段或无班次）</span>`;
      else if (r.kind === "dep") {
        const b = cityBestDep(r, city);
        body = `在圈内 · 最优站 <b>${STATIONS[b.stopI].n}</b> · 典型 ${fmtDur(b.st.typ)} · 方案 ${b.st.cnt} · 直达 ${b.st.dir}`;
      } else {
        const b = cityBestArr(r, city);
        body = `可行 · <b>${STATIONS[b.stopI].n}</b> 最晚 ${fmtAbs(b.info.latest)} 出发、${fmtAbs(b.info.arrAt)} 抵达（${fmtDur(b.info.dur)}）`;
      }
      return `<div class="vrow"><span class="vc-dot" style="background:${v.color}"></span><b>${v.dir === "dep" ? "自 " + v.name + " 出发" : "必须抵达 " + v.name}</b>（${anchorDateStr(v.dateOff)} ${fmtClock(v.dateOff * 1440 + v.fromMin)}–${fmtClock(v.dateOff * 1440 + v.untilMin)} · 预算${v.bmax > 0 ? "≤" + fmtDur(v.bmax) : "不限"}）<br>${body}</div>`;
    }).join("");
    const interLine = intersect
      ? `<p class="mini">${intersect.has(city) ? "⊕ <b>该城在所有圈的交集内</b>" : "○ 该城不在交集内（至少一圈不含它）"} · 交集共 ${intersect.size} 城${intersectOn() ? " · 列表已按交集过滤" : ""}</p>`
      : "";
    return rows + interLine;
  }

  function summaryText() {
    const act = active();
    if (!act.length) return "";
    if (act.length === 1) {
      const v = act[0];
      const r = results.get(v.id);
      const n = r && r.ok ? r.cities.size : 0;
      return ` · ${v.dir === "arr" ? `抵达「${v.name}」圈 ${n} 城` : `「${v.name}」圈 ${n} 城`}`;
    }
    return ` · ${act.length + 1} 圈交集 ${intersect ? intersect.size : "?"} 城`;
  }

  function clearResults() {
    results = new Map();
    intersect = null;
    clearOverlay();
    renderCards();
  }
  function clearAll() {
    views = [];
    results = new Map();
    intersect = null;
    save();
    clearOverlay();
    renderCards();
  }

  return {
    load, save, addView, removeView, patchView, renderCards, runAll, clearResults, clearAll,
    renderOverlay, active, anyActive, intersectOn, rowCell, detailBlock, summaryText, syncLegacyConstraint,
    debugInfo() {
      const n = (lg) => (lg ? lg.getLayers().length : -1);
      return {
        views: views.length, active: active().length, intersect: intersect ? intersect.size : null,
        layerViews: n(layerViews), layerInter: n(layerInter),
        perView: views.map((v) => { const r = results.get(v.id); return { name: v.name, dir: v.dir, ok: !!(r && r.ok), err: r && r.error, cities: r && r.ok ? r.cities.size : null }; }),
      };
    },
    get intersect() { return intersect; },
    get views() { return views; },
    get results() { return results; },
  };
})();
