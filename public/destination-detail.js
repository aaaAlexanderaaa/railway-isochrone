// Role: 目的地详情摘要与同城站切换；契约 docs/specs/exploration.md。
// 使用页面发布的 state / api 接口，不拥有查询输入。
"use strict";
function selectDestination(stopI, force) {
  DetailSession.select();
  const st = state.stats.get(stopI);
  if (!st && !force) return;
  const s = STATIONS[stopI];
  state.selected = stopI;
  $("d-followup").innerHTML = "";
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
    ? `典型 ${fmtDur(st.typ)} · ${inBand ? (st.typ < state.bmin ? "典型略低于预算下限（弹性内）" : "在预算带内") : (st.typ < state.bmin ? "耗时低于预算下限" : "耗时超出预算上限")}${st.js[0] ? (() => { const na = state.dateOff === 0 ? nowAbsMin() : -1; const nx = na >= 0 ? (st.eligible.find(j => j[0] >= na) || st.eligible[0] || st.js[0]) : (st.eligible[0] || st.js[0]); return ` · ${state.dateOff === 0 ? "下一班" : "首班"} ${fmtAbs(nx[0])}（自 ${STATIONS[nx[5]].n} 出发）`; })() : ""}`
    : "当前条件下不可达";
  if (!st) { $("d-stats").innerHTML = ""; $("d-strip").innerHTML = ""; $("d-itin").innerHTML = ""; $("d-wx-body").innerHTML = ""; $("d-const").classList.add("hidden"); return; }

  $("d-stats").innerHTML = [
    ["最快", fmtDur(st.fast), "全天最优方案的耗时"],
    ["常用耗时", fmtDur(st.typ), "预算内、且不比最快方案多花2小时的车次，取耗时中位数"],
    ["可选方案", st.cnt, "预算内且耗时不超过最快方案2小时的方案数"],
    ["直达班次", st.dir, "常用方案中无需换乘的班次数"],
    ["最晚出发", st.lastDep != null ? fmtAbs(st.lastDep) : "—", "常用方案里最晚的出发时刻；更晚的慢/超预算车见下方说明"],
  ].map(([k, v, tip]) => `<div class="cell" title="${tip || ""}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")
    + `<div class="cell" id="d-wx" title="到达车站附近的逐小时预报，仅供参考"><div class="k">到达时天气(估)</div><div class="v">加载中</div></div>`
    + `<div class="cell" id="d-fare" title="按典型方案的实际经由里程 × 分席别费率粗略估算（二等座/硬座口径）。往返两个方向选取的典型车次席别可能不同（如去 G 回 D），估算价随之不同。GTFS 无票价数据，仅供量级参考，以 12306 为准。"><div class="k">里程·票价(二等座, 估)</div><div class="v">…</div></div>`
    + (st.slowCnt > 0 ? `<p class="mini" style="grid-column:1/-1;margin:2px 0 0">另有 ${st.slowCnt} 班更慢或超预算的方案（${st.slowCnt === 1 ? "出发" : "最晚"} ${st.slowLastDep != null ? fmtAbs(st.slowLastDep) : ""}）${st.slowLastDep != null && st.slowLastDep >= d1Abs() ? "，已超出下方时间轴范围" : ""}，超预算车次不在下方展示。</p>` : "");
  // 到达时天气：详情页多模型气象图（温度/湿度/降水/天气类型/逐小时悬停数值）
  syncStarBtn();
  {
    const wxBody = $("d-wx-body");
    if (wxBody) {
      if (typeof Weather !== "undefined" && Weather.pointChart) {
        Weather.pointChart(wxBody, s.la, s.lo, { arrAbs: st.firstArr != null ? st.firstArr : null });
      } else {
        wxBody.innerHTML = `<p class="mini">天气组件未加载</p>`;
      }
    }
  }
  {
    const wxEl = $("d-wx");
    if (wxEl) {
      const arriveMin = st.firstArr != null ? st.firstArr : state.dateOff * 1440 + state.fromMin + st.typ;
      if (typeof Weather !== "undefined" && Weather.arrivalWx) {
        Weather.arrivalWx(s.la, s.lo, arriveMin).then((w) => {
          if (w) wxEl.innerHTML = `<div class="k">到达时天气(估)</div><div class="v">${w.txt} ${w.temp}°C</div>`;
          else wxEl.innerHTML = '<div class="k">到达时天气</div><div class="v">暂无预报</div>';
        }).catch(() => { wxEl.innerHTML = '<div class="k">到达时天气</div><div class="v">暂不可用</div>'; });
      } else wxEl.style.display = "none";
    }
  }

  // 约束块
  const c = state.constraint;
  const conOn = c.on && c.name;
  if (conOn && c.stops.includes(stopI)) {
    const el0 = $("d-const");
    el0.classList.remove("hidden");
    el0.className = "d-const ok";
    el0.innerHTML = `<b>这里就是必须赶到的「${c.name}」本身</b>——已经在目的地上，无需另查衔接。`;
  } else if (conOn) {
    const tag = conTag(stopI); // 本站口径
    // 同城口径(与列表一致): 最晚出发取各站最大, 到达取各站最早
    let cityMax = -1, cityFirst = null, cityMaxStop = stopI;
    for (let i = 0; i < STATIONS.length; i++) {
      if (STATIONS[i].c !== s.c || !state.stats.has(i)) continue;
      const st2 = state.stats.get(i);
      if (cityFirst == null || st2.firstArr < cityFirst) cityFirst = st2.firstArr;
      const v = state.conLabel ? state.conLabel[i] : -1;
      if (v > cityMax && st2.firstArr < v) { cityMax = v; cityMaxStop = i; }
    }
    const cityTag = conTagByMax(cityMax, cityMax >= 0 && cityFirst != null ? cityMax - cityFirst : null);
    const el = $("d-const");
    el.classList.remove("hidden");
    el.className = `d-const ${cityTag.cls}`;
    const dName = c.name;
    const dTime = c.timeMin == null ? "" : fmtClock(c.timeMin), dDay = anchorDateStr(c.dateOff);
    const byText = c.timeMin == null ? `${dDay}当天内` : `${dDay} ${dTime} 前`;
    el.innerHTML = cityTag.cls === "bad"
      ? `<b>赶到「${dName}」：无法在 ${byText}从 ${s.c} 到达</b>——未找到同时满足时段、${c.dur > 0 ? `≤${fmtDur(c.dur)}预算、` : ""}${c.xf === 0 ? "直达" : `换乘限制`}与到达截止的方案（本站 ${s.n}：${tag.txt}）`
      : cityTag.cls === "ok"
        ? `<b>赶到「${dName}」：</b>（同城口径）${cityTag.txt}，${byText}可达 <b>${dName}</b>${state.conArr && state.conArr[cityMaxStop] >= 0 ? `<span class="mini">（自 ${STATIONS[cityMaxStop].n} 出发，该班 ${fmtClock(state.conArr[cityMaxStop])} 到）</span>` : ""}<span class="mini">（本站 ${s.n}：${tag.txt}）</span><br>
           <span class="mini">（按时刻表${c.cls && c.cls !== "all" ? (c.cls === "gdc" ? "高铁动车" : "普速") : "全部"}班次计算${c.dur > 0 ? `，赶到该地限时 ${fmtDur(c.dur)}` : ""}${c.xf >= 0 ? `，${c.xf === 0 ? "仅直达" : `换乘 ≤${c.xf} 次`}` : ""}，同站换乘已留 15 分钟衔接；提前购票仍建议留余量${c.stops.length > 1 ? `；该地含 ${c.stops.length} 站（${c.stops.slice(0, 4).map((i) => STATIONS[i].n).join("、")}${c.stops.length > 4 ? "…" : ""}），到站≠到家，请留意市内接驳` : ""}）</span><br>
           <button type="button" class="ghost" id="btn-xleg">重算并跳到 ${s.c}（各站）→ ${dName} 的方案</button>`
        : `<b>赶到「${dName}」（注意）：</b>（同城口径）${cityTag.txt}——才能${byText}到达 <b>${dName}</b><span class="mini">（本站 ${s.n}：${tag.txt}）</span><br>
           <span class="mini">（按时刻表${c.cls && c.cls !== "all" ? (c.cls === "gdc" ? "高铁动车" : "普速") : "全部"}班次计算${c.dur > 0 ? `，赶到该地限时 ${fmtDur(c.dur)}` : ""}${c.xf >= 0 ? `，${c.xf === 0 ? "仅直达" : `换乘 ≤${c.xf} 次`}` : ""}，同站换乘已留 15 分钟衔接）</span><br>
           <button type="button" class="ghost" id="btn-xleg">重算并跳到 ${s.c}（各站）→ ${dName} 的方案</button>`;
    const b = $("btn-xleg");
    if (b) b.onclick = () => loadXLeg(stopI).then(() => {
      const o = document.getElementById("xleg-out");
      if (o) o.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    loadXLeg(stopI);
  } else {
    // 多圈形态：各视图对该城市的可行性摘要（2026-09-24 等时圈改造）
    const elc = $("d-const");
    const vh = Views.detailBlock(s.c, stopI);
    if (vh) {
      elc.classList.remove("hidden");
      elc.className = "d-const";
      elc.innerHTML = `<b>⊕ 各项出行条件</b><br>${vh}`;
    } else elc.classList.add("hidden");
  }

  bindViewJourneys(s.c);
  renderStrip(st.eligible, null, { coreCut: st.coreCut, listTitle: "去程车次", arrStation: STATIONS[stopI].n });
  if (st.eligible && st.eligible.length) loadItinerary(st.eligible[0], stopI);
  else $("d-itin").innerHTML = `<p class="mini">${st.local ? "你已在当地，无需乘车。" : "当前预算内没有方案；下方更慢车次仅供放宽预算时参考。"}</p>`;

  // 选中环
  if (selectedRing) map.removeLayer(selectedRing);
  const [la, lo] = wgs2gcj(s.la, s.lo);
  selectedRing = L.circleMarker([la, lo], {
    renderer: sharedRenderer, radius: 13, color: "#111", weight: 2.5, fillOpacity: 0,
    dashArray: "4 3",
  }).addTo(map);
  map.panTo([la, lo], { animate: true });
}
