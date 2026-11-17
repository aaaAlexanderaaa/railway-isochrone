// 铁路可达性引擎
// 输入: public/data/net.json (由 etl.py 生成)
// 核心:
//  - reach(): 按出发时刻采样做多轮(按乘车次数)最早到达搜索, 得到全天每个车站的
//             非支配方案集合 {出发, 到达, 乘车次数, 首程车次}
//  - constraint(): 反向扫描, 求每个车站"最晚何时出发仍能在截止时间前到达目的地"
//  - itinerary(): 单方案完整行程重构
//  - departures(): 车站近期发车时刻
"use strict";

const INF = 0x3fffffff;
const K_MAX = 3;          // 最多乘车次数: 直达/1换/2换
const MAX_SAMPLES = 190;  // 出发采样上限(近似全轮廓)
const XFER_MIN = 15;      // 同站换乘最短衔接时间(分钟): 到达后至少15分钟才能登上下一程
// 估算票价费率(元/公里, 二等座/硬座口径) —— GTFS 无票价, 按里程粗估, 非精确值
const FARE_RATE = { G: 0.46, D: 0.31, C: 0.42, Z: 0.15, T: 0.15, K: 0.15, Y: 0.2, S: 0.35, L: 0.15, O: 0.2 };

function loadNet(netPathOrData) {
  if (netPathOrData && typeof netPathOrData === "object") return netPathOrData;
  if (typeof netPathOrData !== "string") throw new Error("Engine 需要 net.json 路径或已解析对象");
  const fs = require("fs");
  return JSON.parse(fs.readFileSync(netPathOrData, "utf8"));
}

class Engine {
  constructor(netPathOrData) {
    const t0 = Date.now();
    const d = loadNet(netPathOrData);
    this.meta = d.meta;
    this.stations = d.stations; // {n,la,lo,c,d}
    this.names = d.names;
    this.cls = d.cls;
    this.off = Int32Array.from(d.off);
    this.dep = Int32Array.from(d.dep);
    this.arr = Int32Array.from(d.arr);
    this.dist = Float64Array.from(d.dist || []);
    this.tstops = Int32Array.from(d.stops);
    this.stOff = Int32Array.from(d.stOff);
    this.stTrips = Int32Array.from(d.stTrips);
    this.nTrips = this.off.length - 1;
    this.nStops = this.stations.length;
    this.tripFirstDep = new Int32Array(this.nTrips);
    this.tripLastDep = new Int32Array(this.nTrips);
    for (let t = 0; t < this.nTrips; t++) {
      this.tripFirstDep[t] = this.dep[this.off[t]];
      this.tripLastDep[t] = this.dep[this.off[t + 1] - 1];
    }
    this._buildConnections();
    // name -> station idx
    this.stIdxByName = new Map();
    this.stations.forEach((s, i) => this.stIdxByName.set(s.n, i));
    // city -> [idx]
    this.cityStops = new Map();
    this.stations.forEach((s, i) => {
      if (!this.cityStops.has(s.c)) this.cityStops.set(s.c, []);
      this.cityStops.get(s.c).push(i);
    });
    console.log(`[engine] loaded ${this.nStops} stations, ${this.nTrips} trips, ` +
      `${this.connIdx.length} conn-instances in ${Date.now() - t0}ms`);
  }

  // 相邻停站构成的有向连接; 每条连接展开 DAYS 个"日实例"(o=k*1440, k=0..DAYS-1),
  // 按绝对到达时间降序合并排序, 供反向扫描一次遍历。
  // 注意: 数组必须按 n*DAYS 分配 —— 越界写入会被 Int32Array 静默丢弃,
  // 曾因按旧的两日容量分配导致约束扫描只看到前 ~15k 条连接(往返检查全假阴性)。
  _buildConnections() {
    const DAYS = 14;
    const pastDays = Math.ceil(Math.max(...this.tripLastDep) / 1440);
    const n = (this.tstops.length - this.nTrips) * (DAYS + pastDays);
    const cArr = new Int32Array(n), cDep = new Int32Array(n);
    const cTrip = new Int32Array(n), cFrom = new Int32Array(n);
    const cTo = new Int32Array(n), cInstance = new Int32Array(n);
    let ci = 0;
    for (let t = 0; t < this.nTrips; t++) {
      for (let k = this.off[t]; k < this.off[t + 1] - 1; k++) {
        const a = this.arr[k + 1], dp = this.dep[k];
        for (let o = -pastDays * 1440; o <= (DAYS - 1) * 1440; o += 1440) {
          cArr[ci] = a + o; cDep[ci] = dp + o; cTrip[ci] = t; cFrom[ci] = this.tstops[k]; cTo[ci] = this.tstops[k + 1]; cInstance[ci] = t * (DAYS + pastDays) + o / 1440 + pastDays; ci++;
        }
      }
    }
    const idx = new Int32Array(ci);
    for (let i = 0; i < ci; i++) idx[i] = i;
    const sorted = Array.from(idx).sort((x, y) => cArr[y] - cArr[x]);
    this.connIdx = Int32Array.from(sorted);
    this.cInstance = cInstance; this.instanceCount = this.nTrips * (DAYS + pastDays);
    this.cArr = cArr; this.cDep = cDep; this.cTrip = cTrip; this.cFrom = cFrom; this.cTo = cTo;
  }

  _classOk(ti, classFilter) {
    if (!classFilter || classFilter === "all") return true;
    const c = this.cls[ti];
    if (classFilter === "gdc") return c === "G" || c === "D" || c === "C";
    if (classFilter === "psk") return !(c === "G" || c === "D" || c === "C");
    return true;
  }

  // 每日运行图直接计算最早可乘实例；不把首程出发窗口施加给换乘车。
  // 负偏移表示昨天/更早始发、今天途中上车的列车。
  _scanForward(origins, tFrom, tTo, classFilter, sampleT, layers = K_MAX) {
    const tau = [], parTrip = [], parBoard = [], parOff = [];
    for (let j = 0; j <= layers; j++) {
      tau.push(new Int32Array(this.nStops).fill(INF));
      parTrip.push(new Int32Array(this.nStops).fill(-1));
      parBoard.push(new Int32Array(this.nStops).fill(-1));
      parOff.push(new Int32Array(this.nStops));
    }
    const originSet = new Set(origins);
    for (const s of origins) tau[0][s] = sampleT;
    for (let j = 1; j <= layers; j++) {
      tau[j].set(tau[j - 1]);
      for (let ti = 0; ti < this.nTrips; ti++) {
        if (!this._classOk(ti, classFilter)) continue;
        let board = -1, offset = INF;
        for (let k = this.off[ti]; k < this.off[ti + 1]; k++) {
          const station = this.tstops[k];
          if (board >= 0) {
            const arrival = this.arr[k] + offset;
            if (arrival < tau[j][station]) {
              tau[j][station] = arrival;
              parTrip[j][station] = ti; parBoard[j][station] = board; parOff[j][station] = offset;
            }
          }
          if (tau[j - 1][station] >= INF || k === this.off[ti + 1] - 1 || (j > 1 && originSet.has(station))) continue;
          const ready = tau[j - 1][station] + (j === 1 ? 0 : XFER_MIN);
          const instance = Math.ceil((ready - this.dep[k]) / 1440) * 1440;
          if (j === 1 && this.dep[k] + instance > tTo) continue;
          if (instance < offset) { offset = instance; board = k; }
        }
      }
    }
    return {tau, parTrip, parBoard, parOff};
  }

  // 出发站集合当日在 [tFrom,tTo] 的出发时刻(采样点)
  _originSamples(originStops, tFrom, tTo, classFilter) {
    const set = new Set();
    for (const s of originStops) {
      for (let q = this.stOff[s]; q < this.stOff[s + 1]; q++) {
        const t = this.stTrips[q];
        if (!this._classOk(t, classFilter)) continue;
        for (let k = this.off[t]; k < this.off[t + 1] - 1; k++) { // 末站不可上车
          if (this.tstops[k] === s) {
            for (let o = Math.ceil((tFrom - this.dep[k]) / 1440) * 1440; this.dep[k] + o <= tTo; o += 1440) {
              const d = this.dep[k] + o;
              if (d >= tFrom && d <= tTo) set.add(d);
            }
          }
        }
      }
    }
    let list = Array.from(set).sort((a, b) => a - b);
    if (list.length > MAX_SAMPLES) {
      const stride = Math.ceil(list.length / MAX_SAMPLES);
      const kept = list.filter((_, i) => i % stride === 0);
      const last = list[list.length - 1];
      if (kept[kept.length - 1] !== last) kept.push(last);
      list = kept;
    }
    return list;
  }

  // ---- 正向可达性 ----
  // origins: 车站 idx 数组; tFrom/tTo: 绝对分钟(相对当日 00:00, 可 >1440)
  // 返回: { samples, journeys: Map<stopIdx, Array<[dep, arr, tripsUsed, firstTrip, sampleT, originStop]>> }
  reach(origins, tFrom, tTo, classFilter) {
    const t0 = Date.now();
    const samples = this._originSamples(origins, tFrom, tTo, classFilter);
    const nS = this.nStops;
    const journeys = new Map(); // stop -> Map<key, tuple>
    const oset = new Set(origins);

    for (const t of samples) {
      const {tau, parTrip, parBoard, parOff} = this._scanForward(origins, tFrom, tTo, classFilter, t);

      // 收集本采样点各站最优方案
      for (let s = 0; s < nS; s++) {
        if (oset.has(s)) continue;
        // 每个乘车层都保留：更慢但少换乘的方案也是非支配方案。
        for (let j = 1; j <= K_MAX; j++) {
        const best = tau[j][s];
        if (best >= INF || best >= tau[j - 1][s]) continue;
        // 回溯(向后走, 最后记录的一段即首程); 跳过未被该层更新的空层
        let cur = s, jj = j;
        let firstTrip = -1, originStop = -1, depO = -1, legsUsed = 0;
        let guard = 0;
        while (jj > 0 && guard++ < 8) {
          if (tau[jj][cur] === tau[jj - 1][cur]) { jj--; continue; }
      const ti = parTrip[jj][cur], b = parBoard[jj][cur];
          if (ti < 0 || b < 0) { jj--; continue; }
          firstTrip = ti;
          originStop = this.tstops[b];
          depO = this.dep[b] + parOff[jj][cur];
          cur = this.tstops[b];
          legsUsed++;
          jj--;
        }
        if (firstTrip < 0) continue;
        const key = `${depO}_${best}_${legsUsed}`;
        let m = journeys.get(s);
        if (!m) { m = new Map(); journeys.set(s, m); }
        if (!m.has(key)) m.set(key, [depO, best, legsUsed, firstTrip, t, originStop]);
        }
      }
    }

    // 整理为数组并按出发时间排序
    const out = new Map();
    for (const [s, m] of journeys) {
      out.set(s, Array.from(m.values()).sort((a, b) => a[0] - b[0]));
    }
    this.lastStats = { samples: samples.length, ms: Date.now() - t0, stops: out.size };
    return { samples, journeys: out };
  }

  // ---- 单方案行程重构 ----
  itinerary(origins, tFrom, tTo, classFilter, sampleT, targetStop, jTarget) {
    const {tau, parTrip, parBoard, parOff} = this._scanForward(origins, tFrom, tTo, classFilter, sampleT, jTarget);
    // 回溯(跳过未被该层更新的空层)
    const legs = [];
    let cur = targetStop, jj = jTarget;
    let guard = 0;
    while (jj > 0 && guard++ < 8) {
      if (tau[jj][cur] === tau[jj - 1][cur]) { jj--; continue; }
      const ti = parTrip[jj][cur], b = parBoard[jj][cur];
      if (ti < 0 || b < 0) { jj--; continue; }
      const o = parOff[jj][cur];
      const boardStop = this.tstops[b], alightStop = cur;
      const depAbs = this.dep[b] + o, arrAbs = tau[jj][cur];
      // 途中停站 + 里程
      const mids = [];
      let km = 0;
      for (let k = b; k < this.off[ti + 1]; k++) {
        if (this.tstops[k] === alightStop) {
          for (let q = b; q <= k; q++) mids.push({
            s: this.tstops[q], d: this.dep[q] + o, a: this.arr[q] + o,
          });
          km = Math.max(0, (this.dist[k] || 0) - (this.dist[b] || 0));
          break;
        }
      }
      legs.push({
        trip: this.names[ti], tripIdx: ti, cls: this.cls[ti],
        from: boardStop, to: alightStop, dep: depAbs, arr: arrAbs, mids, km,
      });
      cur = boardStop; jj--;
    }
    legs.reverse();
    const kmTotal = legs.reduce((a, l) => a + l.km, 0);
    const fareEst = Math.round(legs.reduce((a, l) => a + l.km * (FARE_RATE[l.cls] || 0.2), 0));
    return { legs, tripsUsed: legs.length, kmTotal, fareEst };
  }

  // ---- 反向: 最晚出发仍能赶上截止时间 ----
  // dests: 目的地车站 idx; T: 截止绝对分钟; tFloor: 允许的最早出发绝对分钟
  // maxTrips: 乘车段数上限(0=直达, <0=不限); maxDur: 第二程时长上限(分钟, 0=不限)
  // 换乘缓冲: 到达某站后换乘不同车次需间隔 XFER_MIN 分钟; 同车次续行无需缓冲
  constraint(dests, T, tFloor, classFilter, maxTrips, maxDur, departureUntil = T) {
    const t0 = Date.now();
    // 分层反向扫描: 第 k 层 = 用 ≤k 段乘车到达 B 的最晚出发。
    // maxTrips<0 使用全局最多三段乘车; =0 即直达。
    // maxDur>0 时额外要求整段行程(arrB-dep)不超该分钟数; classFilter 逐连接生效。
    const n = this.nStops;
    const rides = maxTrips != null && maxTrips >= 0 ? Math.min(K_MAX, maxTrips + 1) : K_MAX;
    const destSet = new Set(dests);
    let previous = Array.from({length: n}, () => []);
    const latest = new Int32Array(n).fill(-1), arrAt = new Int32Array(n).fill(-1);
    for (const s of dests) { latest[s] = T; arrAt[s] = T; }
    for (let layer = 1; layer <= rides; layer++) {
      const profiles = previous.map(p => p.slice());
      const onboard = new Int32Array(this.instanceCount).fill(INF);
      for (const i of this.connIdx) {
        const dep = this.cDep[i], arr = this.cArr[i], trip = this.cTrip[i];
        if (arr > T || dep < tFloor || !this._classOk(trip, classFilter)) continue;
        const from = this.cFrom[i], to = this.cTo[i], instance = this.cInstance[i];
        let final = onboard[instance];
        if (destSet.has(to)) final = Math.min(final, arr);
        for (const [nextDep, nextArr] of previous[to]) {
          if (arr + XFER_MIN <= nextDep) final = Math.min(final, nextArr);
        }
        if (final >= INF) continue;
        onboard[instance] = final;
        if (maxDur > 0 && final - dep > maxDur) continue;
        // 出发窗口只约束结果的首程；换乘仍可乘后续时段的列车。
        if (dep <= departureUntil && (dep > latest[from] || (dep === latest[from] && final < arrAt[from]))) {
          latest[from] = dep; arrAt[from] = final;
        }
        // 同站保留“更晚走”与“更早到”的 Pareto 组合，供前面的限时换乘使用。
        const profile = profiles[from];
        if (profile.some(([d, a]) => d >= dep && a <= final)) continue;
        profiles[from] = profile.filter(([d, a]) => !(d <= dep && a >= final));
        profiles[from].push([dep, final]);
      }
      previous = profiles;
    }
    this.lastStats = {ms: Date.now() - t0};
    return {latest, arrAt};
  }

  // ---- 车站近期发车 ----
  departures(station, tFrom, count, classFilter) {
    const list = [];
    for (let q = this.stOff[station]; q < this.stOff[station + 1]; q++) {
      const t = this.stTrips[q];
      if (!this._classOk(t, classFilter)) continue;
      for (let k = this.off[t]; k < this.off[t + 1] - 1; k++) {
        if (this.tstops[k] === station) {
          for (let o = Math.ceil((tFrom - this.dep[k]) / 1440) * 1440; this.dep[k] + o <= tFrom + 1440; o += 1440) {
            const d = this.dep[k] + o;
            if (d >= tFrom && d <= tFrom + 1440) {
              list.push({ trip: this.names[t], dep: d, terminal: this.tstops[this.off[t + 1] - 1], cls: this.cls[t] });
            }
          }
        }
      }
    }
    list.sort((a, b) => a.dep - b.dep);
    return list.slice(0, count);
  }
}

if (typeof module !== "undefined" && module.exports && typeof process !== "undefined") {
  module.exports = { Engine };
} else if (typeof self !== "undefined") {
  self.RailEngine = { Engine };
} else if (typeof window !== "undefined") {
  window.RailEngine = { Engine };
}
