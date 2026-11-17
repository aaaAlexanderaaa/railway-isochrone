// Role: 主查询与附加圈共享的方案过滤、预算统计。
// 契约：docs/specs/exploration.md；不读取 DOM 或修改查询输入。
'use strict';
const JourneyStats = (() => {
  function filter(journeys, opt) {
    return journeys.filter(j => j[0] >= opt.from && j[0] <= opt.until &&
      (opt.now == null || j[0] >= opt.now) && j[2] - 1 <= opt.maxTra &&
      (opt.arriveBy == null || j[1] <= opt.arriveBy) &&
      (!opt.enforceBudget || !(opt.bmax > 0) || j[1] - j[0] <= opt.bmax));
  }
  function summarize(journeys, opt) {
    const js = filter(journeys, opt);
    if (!js.length) return null;
    const pairs = js.map(j => [j[1] - j[0], j]).sort((a,b)=>a[0]-b[0]);
    const fast = pairs[0][0], upper = opt.bmax > 0 ? opt.bmax : Infinity;
    const cut = Math.max(fast, Math.min(upper, fast + 120));
    const core = pairs.filter(p => p[0] <= cut), rest = pairs.filter(p => p[0] > cut);
    const durs = core.map(p => p[0]);
    const eligible = js.filter(j => j[1] - j[0] <= upper);
    const med = durs.length % 2 ? durs[(durs.length-1)/2] : Math.round((durs[durs.length/2-1]+durs[durs.length/2])/2);
    return {typ:med, fast, p90:durs[Math.min(durs.length-1,Math.floor(durs.length*0.9))],
      cnt:core.length, dir:core.filter(p=>p[1][2]===1).length,
      firstArr: eligible.length ? Math.min(...eligible.map(j=>j[1])) : Infinity,
      firstDep: eligible.length ? eligible[0][0] : null,
      lastDep: Math.max(...core.map(p=>p[1][0])),
      slowCnt:rest.length, slowLastDep:rest.length?Math.max(...rest.map(p=>p[1][0])):null,
      coreCut:cut, js, eligible};
  }
  function atOrigin(from) {
    return {local:true, typ:0, fast:0, p90:0, cnt:0, dir:0, firstArr:from,
      firstDep:null, lastDep:null, slowCnt:0, slowLastDep:null, coreCut:0, js:[], eligible:[]};
  }
  return {filter, summarize, atOrigin};
})();
if (typeof module !== 'undefined') module.exports = JourneyStats;
