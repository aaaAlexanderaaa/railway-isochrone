// Role: 约束一致的返程方案过滤与展示；契约 docs/specs/exploration.md。
// 使用页面发布的 state / api 接口，不拥有查询输入。
"use strict";
async function loadXLeg(stopI) {
  const token = DetailSession.returns();
  // 查看 同城各站 -> 约束目的地 的方案（次日窗口, 含在截止前到达的）
  // 幂等：输出固定挂在 #xleg-out，重跑先清旧——此前每次点击都整段追加一份，
  // 落在密集面板下方看不见，用户感知为"死按钮"（round-20 验收问题 #1）
  const c = state.constraint;
  const el = $("d-followup");
  const btn = $("btn-xleg");
  const old = document.getElementById("xleg-out");
  if (old) old.remove();
  if (btn) { btn.disabled = true; btn.textContent = "计算中…"; }
  try {
    const city = STATIONS[stopI].c;
    const origins = [];
    for (let i = 0; i < STATIONS.length; i++) {
      if (STATIONS[i].c === city && state.stats.has(i)) origins.push(i);
    }
    if (!origins.length) origins.push(stopI);
    const f = c.dateOff * 1440 + (c.tFromMin ?? 0);
    const t = Math.min(conAbs(), c.dateOff * 1440 + (c.tUntilMin ?? 1439));
    const data = await api(`/api/reach?o=${origins.join(",")}&f=${f}&t=${t}&cls=${c.cls || "all"}`);
    if (!DetailSession.currentReturns(token)) return;
    // 汇总目的地城市所有站的方案（出发在窗口内且在截止时间前到达的）
    const rows = [], seen = new Set();
    const T = conAbs();
    const add = (data, ctx) => { for (const [s2, list] of data.journeys) {
      if (!c.stops.includes(s2)) continue;
      JourneyStats.filter(list, {from:f, until:t, maxTra:c.xf < 0 ? 2 : c.xf,
        arriveBy:T, bmax:c.dur, enforceBudget:true,
        now:c.dateOff === 0 ? nowAbsMin() : null}).forEach(j => {
          const arrival = state.stats.get(j[5])?.firstArr;
          const key = [s2, j[0], j[1], j[2], j[3], j[5]].join(':');
          if (arrival != null && j[0] > arrival && !seen.has(key)) {
            seen.add(key); rows.push({j, stop:s2, ctx});
          }
        });
    }};
    add(data, {o:origins, f, t, cls:c.cls || 'all'});
    // 全天抽样和同城最早到达会省略部分站的末班。逐站核验摘要承诺的最晚出发，
    // 并保留对应重构上下文，不能点击后又被另一个出发站的较快列车替换。
    for (const origin of origins) {
      const latest = state.conLabel?.[origin];
      if (latest == null || latest < f || latest > t) continue;
      const ctx = {o:[origin], f:latest, t:latest, cls:c.cls || 'all'};
      const exact = await api(`/api/reach?o=${origin}&f=${latest}&t=${latest}&cls=${ctx.cls}`);
      if (!DetailSession.currentReturns(token)) return;
      add(exact, ctx);
    }
    // 按出发时间重排
    rows.sort((a,b) => a.j[0] - b.j[0]);
    const all = rows.map(r=>r.j), allStops = rows.map(r=>r.stop);
    if (!all.length) {
      el.insertAdjacentHTML("beforeend", `<p id="xleg-out"><b>该时段无 ${city} → ${c.name} 的可行方案。</b><span class="mini">（查询条件：${anchorDateStr(c.dateOff)} ${fmtClock(f)} 起、${fmtAbs(T)} 前到达；可行班次可能都在更早时段，或需换乘超出衔接限制）</span></p>`);
    } else {
      const durs = all.map((x) => x[1] - x[0]).sort((a, b) => a - b);
      const med = durs[Math.floor(durs.length / 2)];
      const cut = Math.max(durs[0], Math.min(durs[0] + 120, T - f));
      const wrap = document.createElement("div");
      wrap.id = "xleg-out";
      el.insertAdjacentElement("beforeend", wrap);
      wrap.innerHTML = `<p class="mini">查询条件：${anchorDateStr(c.dateOff)} ${fmtClock(f)} 起，自 ${city}（各站）出发、${fmtAbs(T)} 前到达 ${c.name}。
         最快 <b>${fmtDur(durs[0])}</b> · 典型 ${fmtDur(med)} · 方案 ${all.length} 个（含 ${all.filter((x) => x[2] === 1).length} 直达）</p>`;
      const holder = document.createElement("div");
      wrap.appendChild(holder);
      renderStrip(all, holder, {
        dayStart: f,
        coreCut: cut,
        stops: allStops,
        ctx: { o: origins, f, t, cls: c.cls || "all" },
        // 远站标注：返程发车站距本详情锚站 >30km 时标出来——"最晚 18:05 走"如果
        // 发自 40km 外的青岛西，照排会误事（round-20 #5）
        labelOf: (j) => {
          const dep = STATIONS[j[5]];
          const km = haversineKm(STATIONS[stopI].la, STATIONS[stopI].lo, dep.la, dep.lo);
          return `自${dep.n}${km > 30 ? `（远·距${STATIONS[stopI].n}约${Math.round(km)}km）` : ""} `;
        },
        arrOf: (j, i) => ` ${fmtClock(j[1])} 到${STATIONS[allStops[i]].n}`,
        onBar: (j, s2, i) => loadItinerary(j, s2, rows[i].ctx),
        listTitle: c.name === state.origin.name ? "返程车次" : "后续行程车次",
      });
    }
  } catch (e) {
    if (!DetailSession.currentReturns(token)) return;
    el.insertAdjacentHTML("beforeend", `<p class="mini" id="xleg-out" style="color:#b91c1c">查询失败：${e.message}</p>`);
  } finally {
    if (btn && DetailSession.currentReturns(token)) { btn.disabled = false; btn.textContent = `查看 ${STATIONS[stopI].c}（各站）→ ${c.name} 的方案`; }
  }
}

/* ================= 图例 ================= */
