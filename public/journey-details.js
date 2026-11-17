// Role: 方案时间轴与完整行程展示；契约 docs/specs/exploration.md。
// 使用页面发布的 state / api 接口，不拥有查询输入。
"use strict";
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
  for (const [sourceIndex, j] of js.entries()) {
    if (j[0] >= d1) continue; // 域外慢方案不画, 计入 hiddenSlow 说明
    let li = lanes.findIndex((end) => end + 4 <= j[0]);
    if (li < 0) { lanes.push(j[1]); li = lanes.length - 1; } else lanes[li] = j[1];
    bars.push({ j, li, sourceIndex });
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
    // 去程默认标注终到站：本条时间轴的目的地由调用方传入（round-20 #6）
    const suf = opts.arrOf ? opts.arrOf(b.j, b.sourceIndex) : (opts.arrStation ? ` 到${opts.arrStation}` : "");
    const y = 26 + b.li * 16;
    const nowAbs0 = state.dateOff === 0 ? nowAbsMin() : -1;
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
    const suf2 = opts.arrOf ? opts.arrOf(b.j, b.sourceIndex) : (opts.arrStation ? ` 到${opts.arrStation}` : "");
    return `<div class="jrow" data-i="${i}">${pre2}<b>${NAMES[ft] || ""}</b> ${fmtClock(dep)}→${fmtClock(arr)} · ${fmtDur(dur)} · ${legs === 1 ? "直达" : `换乘${legs - 1}次`}${suf2}${dur > slowCut ? " · 慢/超预算，仅供参考" : ""}</div>`;
  }).join("");
  el.innerHTML = (opts.title ? `<p class="mini">${opts.title}</p>` : "") +
    `<div style="max-height:240px;overflow:auto"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${g}${rects}${cap}</svg></div>` +
    `<details class="jlist" open><summary>${opts.listTitle || "车次时刻（文字）"} ${bars.length} 班<span class="mini">（同一列车跨线可能显示双号，如 G3287/G3290，为同一班车）</span></summary><div class="jrows">${listRows}</div></details>`;
  el.querySelectorAll(".bar").forEach((r) => {
    r.onclick = () => {
      const i = bars[Number(r.dataset.i)].sourceIndex;
      if (opts.onBar) opts.onBar(js[i], opts.stops ? opts.stops[i] : null, i);
      else loadItinerary(js[i], state.selected);
    };
  });
  el.querySelectorAll(".jrow").forEach((r) => {
    r.onclick = () => {
      const i = bars[Number(r.dataset.i)].sourceIndex;
      if (opts.onBar) opts.onBar(js[i], opts.stops ? opts.stops[i] : null, i);
      else loadItinerary(js[i], state.selected);
    };
  });
}

async function loadItinerary(j, stopI, ctx) {
  const token = DetailSession.journey();
  const [dep, arr, legs, ft, st] = j;
  const o = (ctx ? ctx.o : state.origin.stops).join(",");
  const f = ctx ? ctx.f : state.dateOff * 1440 + state.fromMin;
  const t = ctx ? ctx.t : state.dateOff * 1440 + state.untilMin;
  const cls = ctx ? (ctx.cls || "all") : state.cls;
  const target = stopI != null ? stopI : state.selected;
  if (target == null) return;
  $("d-itin").innerHTML = `<p class="mini">加载行程…</p>`;
  try {
    const r = await api(`/api/itinerary?o=${o}&f=${f}&t=${t}&cls=${cls}&st=${st}&s=${target}&j=${legs}`);
    if (!DetailSession.currentJourney(token)) return;
    const el = $("d-itin");
    if (!r.legs.length) { el.innerHTML = `<p class="mini">行程重构失败</p>`; return; }
    let html = `<h4>行程详情 <span class="mini">${fmtAbs(r.legs[0].dep)} 出发 → ${fmtAbs(r.legs[r.legs.length - 1].arr)} 到达 · 共 ${fmtDur(r.legs[r.legs.length - 1].arr - r.legs[0].dep)}${r.legs.length > 1 ? ` · 换乘${r.legs.length - 1}次` : " · 直达"}</span></h4><div class="itin">`;
    r.legs.forEach((l, i) => {
      if (i > 0) {
        const wait = l.dep - r.legs[i - 1].arr;
        html += `<div class="transfer">🔁 ${STATIONS[l.from].n} 换乘 · 停留 ${fmtDur(wait)}</div>`;
      }
      html += `<div class="leg">
        <div class="t1"><span class="tripno cls-${l.cls}">${l.trip}</span><span class="mini">${fmtDur(l.arr - l.dep)}</span><span class="mini farebit" data-fareleg="${i}"></span></div>
        <div class="rt"><span>${fmtAbs(l.dep)} <b>${STATIONS[l.from].n}</b></span><span>→</span><span><b>${STATIONS[l.to].n}</b> ${fmtAbs(l.arr)}</span></div>
        ${l.mids.length > 2 ? `<details class="midsbox"><summary>经停 ${l.mids.length - 2} 站</summary><div class="mids">${l.mids.slice(1, -1).map((m) => `${STATIONS[m.s].n} ${fmtAbs(m.a)}`).join(" · ")}</div></details>` : ""}
      </div>`;
    });
    html += `</div>`;
    el.innerHTML = html;
    const fare = $("d-fare");
    if (fare) {
      fare.innerHTML = r.kmTotal > 0
        ? `<div class="k">当前行程里程·估算票价</div><div class="v">${Math.round(r.kmTotal)}km · ≈¥${r.fareEst}</div>`
        : `<div class="k">当前行程里程·票价</div><div class="v">暂无里程，票价请核对</div>`;
    }
    enrichFares(r.legs, token);
  } catch (e) {
    if (!DetailSession.currentJourney(token)) return;
    $("d-itin").innerHTML = `<p class="mini" style="color:#b91c1c">行程加载失败：${e.message}</p>`;
  }
}
