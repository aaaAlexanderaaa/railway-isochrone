// 引擎快速校验: 已知城市对耗时 + 性能
"use strict";
const { Engine } = require("./lib/engine");
const e = new Engine("public/data/net.json");

const idx = (n) => e.stIdxByName.get(n);
function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }
console.log("\n=== 正向可达: 长沙南, 今天 08:00-22:00, 全部车种 ===");
const r = e.reach([idx("长沙南")], 8 * 60, 22 * 60, "all");
console.log("stats:", e.lastStats);

function statsFor(name) {
  const s = idx(name);
  const js = r.journeys.get(s) || [];
  if (!js.length) return `${name}: 不可达?`;
  const durs = js.map(x => x[1] - x[0]).sort((a, b) => a - b);
  const med = durs[Math.floor(durs.length / 2)];
  return `${name}: 方案数=${js.length} 最快=${durs[0]}分 典型=${med}分 直达=${js.filter(x => x[2] === 1).length} ` +
    `末班出发=${Math.floor(js[js.length-1][0]/60)}:${String(js[js.length-1][0]%60).padStart(2,"0")}`;
}
for (const n of ["上海虹桥", "武汉", "广州南", "北京西", "杭州东", "贵阳北", "南京南", "郑州东", "南昌西", "厦门北", "宜昌东", "桂林西"]) {
  console.log(statsFor(n));
}

console.log("\n=== 城市起点: 长沙(长沙南+长沙), 08:00-22:00 ===");
const r2 = e.reach(e.cityStops.get("长沙"), 8 * 60, 22 * 60, "all");
console.log("stats:", e.lastStats);
const js2 = r2.journeys.get(idx("上海虹桥")) || [];
console.log("长沙→上海虹桥 方案数:", js2.length, "首方案:", JSON.stringify(js2[0]));

console.log("\n=== 行程重构: 长沙南→上海虹桥 最快方案 ===");
const j0 = js2.filter(x => (x[1] - x[0]) === Math.min(...js2.map(y => y[1] - y[0])))[0];
console.log("journey tuple:", j0);
const it = e.itinerary(e.cityStops.get("长沙"), 8 * 60, 22 * 60, "all", j0[4], idx("上海虹桥"), j0[2]);
for (const l of it.legs) {
  console.log(`  ${l.trip} ${e.stations[l.from].n} ${Math.floor(l.dep/60)}:${String(l.dep%60).padStart(2,"0")} -> ${e.stations[l.to].n} ${Math.floor(l.arr/60)}:${String(l.arr%60).padStart(2,"0")} (${l.mids.length} 停站)`);
}

console.log("\n=== 反向约束: 明天 19:00 前到 上海(城市) ===");
const c = e.constraint(e.cityStops.get("上海"), 1440 + 19 * 60, 6 * 60, "all");
console.log("stats:", e.lastStats);
let conFail = 0;
for (const n of ["杭州东", "长沙南", "贵阳北", "郑州东", "北京西", "广州南", "怀化南", "昆明南"]) {
  const v = c.latest[idx(n)];
  if (!(v > 0)) conFail++;
  console.log(`${n}: ${v < 0 ? "不可行" : `最晚 ${Math.floor(v/60)%24}:${String(v%60).padStart(2,"0")} 出发`}`);
}
assert(conFail === 0, "反向约束出现不可行/NaN(共" + conFail + "处)——constraint 返回形状或扫描回归");

console.log("\n=== 近期发车: 长沙南 ===");
for (const d of e.departures(idx("长沙南"), 8 * 60, 6, "all")) {
  console.log(`  ${Math.floor(d.dep/60)}:${String(d.dep%60).padStart(2,"0")} ${d.trip} → ${e.stations[d.terminal].n}`);
}

console.log("\n=== 高铁动车过滤: 长沙南 08:00-22:00 ===");
const r3 = e.reach([idx("长沙南")], 8 * 60, 22 * 60, "gdc");
console.log("stats:", e.lastStats);
console.log(statsFor("上海虹桥"));

console.log("\n=== 远期日守护: 第 4/7/13 天 长沙(城市) 08:00-22:00 gdc ===");
// 天偏移编码曾只有 2 位, dateOff>=4 溢出进车次号 -> 无班次/张冠李戴(2026-09-20 修复)
let refN = null, refFast = null;
for (const D of [4, 7, 13]) {
  const rd = e.reach(e.cityStops.get("长沙"), D * 1440 + 480, D * 1440 + 1320, "gdc");
  const j = rd.journeys.get(idx("上海虹桥"));
  const n = j ? j.length : 0;
  const fast = j ? Math.round(Math.min(...j.map((x) => x[1] - x[0]))) : -1;
  const dayOk = j ? Math.floor(Math.min(...j.map((x) => x[0])) / 1440) === D : false;
  console.log(`day+${D}: 方案数=${n} 最快=${fast}分 日期归属=${dayOk}`);
  assert(n > 0, "day+" + D + " 长沙→上海虹桥 应有方案, 实际 " + n);
  assert(fast >= 180 && fast <= 420, "day+" + D + " 最快应在 3–7h 现实区间, 实际 " + fast);
  assert(dayOk, "day+" + D + " 班次日期归属错误——天偏移编码回归");
  if (refN == null) { refN = n; refFast = fast; }
  else {
    assert(n === refN, "每日同图：day+" + D + " 方案数应与 day+4 相同 (" + refN + "), 实际 " + n);
    assert(fast === refFast, "每日同图：day+" + D + " 最快应与 day+4 相同 (" + refFast + "), 实际 " + fast);
  }
}
