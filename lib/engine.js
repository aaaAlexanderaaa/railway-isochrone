// 铁路可达性引擎
// 输入: public/data/net.json (由 etl.py 生成)
// 核心:
//  - reach(): 按出发时刻采样做多轮(按乘车次数)最早到达搜索, 得到全天每个车站的
//             非支配方案集合 {出发, 到达, 乘车次数, 首程车次}
//  - constraint(): 反向扫描, 求每个车站"最晚何时出发仍能在截止时间前到达目的地"
//  - itinerary(): 单方案完整行程重构
//  - departures(): 车站近期发车时刻
"use strict";
const fs = require("fs");
const path = require("path");

const INF = 0x3fffffff;
const K_MAX = 3;          // 最多乘车次数: 直达/1换/2换
const MAX_SAMPLES = 190;  // 出发采样上限(近似全轮廓)
const XFER_MIN = 15;      // 同站换乘最短衔接时间(分钟): 到达后至少15分钟才能登上下一程
// 估算票价费率(元/公里, 二等座/硬座口径) —— GTFS 无票价, 按里程粗估, 非精确值
const FARE_RATE = { G: 0.46, D: 0.31, C: 0.42, Z: 0.15, T: 0.15, K: 0.15, Y: 0.2, S: 0.35, L: 0.15, O: 0.2 };

class Engine {
  constructor(netPath) {
    const t0 = Date.now();
    const d = JSON.parse(fs.readFileSync(netPath, "utf8"));
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
    const n = this.tstops.length - this.nTrips; // 连接数 = 总停站行 - 车次数
    const cArr = new Int32Array(n * DAYS), cDep = new Int32Array(n * DAYS);
    const cTrip = new Int32Array(n * DAYS), cFrom = new Int32Array(n * DAYS);
    const cTo = new Int32Array(n * DAYS);
    let ci = 0;
    for (let t = 0; t < this.nTrips; t++) {
      for (let k = this.off[t]; k < this.off[t + 1] - 1; k++) {
        const a = this.arr[k + 1], dp = this.dep[k];
        for (let o = 0; o <= (DAYS - 1) * 1440; o += 1440) {
          cArr[ci] = a + o; cDep[ci] = dp + o; cTrip[ci] = t; cFrom[ci] = this.tstops[k]; cTo[ci] = this.tstops[k + 1]; ci++;
        }
      }
    }
    const idx = new Int32Array(ci);
    for (let i = 0; i < ci; i++) idx[i] = i;
    const sorted = Array.from(idx).sort((x, y) => cArr[y] - cArr[x]);
    this.connIdx = Int32Array.from(sorted);
    this.cArr = cArr; this.cDep = cDep; this.cTrip = cTrip; this.cFrom = cFrom; this.cTo = cTo;
  }

  _classOk(ti, classFilter) {
    if (!classFilter || classFilter === "all") return true;
    const c = this.cls[ti];
    if (classFilter === "gdc") return c === "G" || c === "D" || c === "C";
    if (classFilter === "psk") return !(c === "G" || c === "D" || c === "C");
    return true;
  }

  _activeInstances(tFrom, tTo, classFilter) {
    const act = [];
    for (let t = 0; t < this.nTrips; t++) {
      if (!this._classOk(t, classFilter)) continue;
      const fd = this.tripFirstDep[t], ld = this.tripLastDep[t];
      // 日期实例覆盖查询窗所在的所有自然日(相对查询基准日)
      for (let o = Math.floor(tFrom / 1440) * 1440; o <= tTo; o += 1440) {
        if (ld + o >= tFrom && fd + o <= tTo) act.push((t << 4) | (o / 1440));
      }
    }
    return act;
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
            for (let o = Math.floor(tFrom / 1440) * 1440; o <= tTo; o += 1440) {
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
    const act = this._activeInstances(tFrom, tTo, classFilter);
    const samples = this._originSamples(origins, tFrom, tTo, classFilter);
    const nS = this.nStops;
    const tau = [], parTrip = [], parBoard = [], parOff = [];
    for (let j = 0; j <= K_MAX; j++) {
      tau.push(new Int32Array(nS).fill(INF));
      parTrip.push(new Int32Array(nS).fill(-1));
      parBoard.push(new Int32Array(nS).fill(-1));
      parOff.push(new Int32Array(nS));
    }
    const journeys = new Map(); // stop -> Map<key, tuple>
    const oset = new Set(origins);

    for (const t of samples) {
      for (let j = 0; j <= K_MAX; j++) tau[j].fill(INF);
      for (const s of origins) tau[0][s] = t;

      for (let j = 1; j <= K_MAX; j++) {
        tau[j].set(tau[j - 1]);
        let improved = false;
        for (const code of act) {
          const ti = code >> 4, o = (code & 15) * 1440;
          const buf = j === 1 ? 0 : XFER_MIN; // 首程进站不算换乘; 后续需换乘缓冲
          let boardK = -1;
          for (let k = this.off[ti]; k < this.off[ti + 1]; k++) {
            const s = this.tstops[k];
            if (boardK < 0) {
              if (tau[j - 1][s] + buf <= this.dep[k] + o) boardK = k;
              else continue;
            }
            if (k === boardK) continue; // 登车站本身不作为"乘坐后到达"松弛
            const ar = this.arr[k] + o;
            if (ar < tau[j][s]) {
              tau[j][s] = ar; parTrip[j][s] = ti; parBoard[j][s] = boardK; parOff[j][s] = o;
              improved = true;
            }
          }
        }
        if (!improved) break;
      }

      // 收集本采样点各站最优方案
      for (let s = 0; s < nS; s++) {
        if (oset.has(s)) continue;
        const best = tau[K_MAX][s];
        if (best >= INF) continue;
        let j = 0;
        while (tau[j][s] > best) j++;
        if (j === 0) continue; // 仅起点自身
        // 回溯(向后走, 最后记录的一段即首程); 跳过未被该层更新的空层
        let cur = s, jj = j;
        let firstTrip = -1, originStop = -1, depO = -1, legsUsed = 0;
        let guard = 0;
        while (jj > 0 && guard++ < 8) {
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
    const act = this._activeInstances(tFrom, tTo, classFilter);
    const nS = this.nStops;
    const tau = [], parTrip = [], parBoard = [], parOff = [];
    for (let j = 0; j <= K_MAX; j++) {
      tau.push(new Int32Array(nS).fill(INF));
      parTrip.push(new Int32Array(nS).fill(-1));
      parBoard.push(new Int32Array(nS).fill(-1));
      parOff.push(new Int32Array(nS));
    }
    for (const s of origins) tau[0][s] = sampleT;
    for (let j = 1; j <= jTarget; j++) {
      tau[j].set(tau[j - 1]);
      for (const code of act) {
        const ti = code >> 4, o = (code & 15) * 1440;
        const buf = j === 1 ? 0 : XFER_MIN;
        let boardK = -1;
        for (let k = this.off[ti]; k < this.off[ti + 1]; k++) {
          const s = this.tstops[k];
          const d = this.dep[k] + o;
          if (boardK < 0) {
            if (tau[j - 1][s] + buf > d) continue;
            boardK = k;
          }
          if (k === boardK) continue; // 登车站本身不松弛
          const ar = this.arr[k] + o;
          if (ar < tau[j][s]) { tau[j][s] = ar; parTrip[j][s] = ti; parBoard[j][s] = boardK; parOff[j][s] = o; }
        }
      }
    }
    // 回溯(跳过未被该层更新的空层)
    const legs = [];
    let cur = targetStop, jj = jTarget;
    let guard = 0;
    while (jj > 0 && guard++ < 8) {
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
  constraint(dests, T, tFloor, classFilter, maxTrips, maxDur) {
    const t0 = Date.now();
    // 分层反向扫描: 第 k 层 = 用 ≤k 段乘车到达 B 的最晚出发。
    // maxTrips<0 视为不限(取 6 层, 现实铁路链路足够); =0 即直达。
    // maxDur>0 时额外要求整段行程(arrB-dep)不超该分钟数; classFilter 逐连接生效。
    const n = this.nStops;
    const K = maxTrips != null && maxTrips >= 0 ? Math.min(8, maxTrips + 2) : 6;
    const lab = new Int32Array(K * n).fill(-1);
    const arrB = new Int32Array(K * n);
    const tripAt = new Int32Array(K * n).fill(-2); // -2=未标记, -1=终点种子
    for (const s of dests) for (let k = 0; k < K; k++) { lab[k * n + s] = T; tripAt[k * n + s] = -1; }
    const idx = this.connIdx, cArr = this.cArr, cDep = this.cDep;
    const cFrom = this.cFrom, cTo = this.cTo, cTrip = this.cTrip;
    const cfOk = !classFilter || classFilter === "all";
    for (let k = 1; k < K; k++) {
      const base = k * n, prev = base - n;
      for (let q = 0; q < idx.length; q++) {
        const i = idx[q];
        if (cArr[i] > T) continue; // 降序, 开头部分 continue 跳过
        if (!cfOk && !this._classOk(cTrip[i], classFilter)) continue;
        if (cDep[i] < tFloor) continue;
        const to = cTo[i];
        // 读 to 侧标签: 同层仅限同车次续乘(段数不变), 换车次读上一层并加换乘缓冲
        let slot = -1, buf = -1;
        if (lab[base + to] >= 0 && tripAt[base + to] === cTrip[i]) { slot = base + to; buf = 0; }
        else if (lab[prev + to] >= 0) {
          const tt = tripAt[prev + to];
          slot = prev + to; buf = (tt === -1 || tt === cTrip[i]) ? 0 : XFER_MIN;
        } else continue;
        if (cArr[i] + buf > lab[slot]) continue;
        const arrFinal = tripAt[slot] === -1 ? cArr[i] : arrB[slot]; // 该班到达 B 的绝对时刻
        if (maxDur > 0 && arrFinal - cDep[i] > maxDur) continue;
        const f = cFrom[i];
        if (cDep[i] > lab[base + f]) { lab[base + f] = cDep[i]; arrB[base + f] = arrFinal; tripAt[base + f] = cTrip[i]; }
      }
    }
    // 汇总各层取最晚
    const latest = new Int32Array(n).fill(-1);
    const arrAt = new Int32Array(n).fill(-1);
    for (let s = 0; s < n; s++) {
      let bd = -1, ba = -1;
      for (let k = 0; k < K; k++) if (lab[k * n + s] > bd) { bd = lab[k * n + s]; ba = arrB[k * n + s]; }
      latest[s] = bd; arrAt[s] = ba;
    }
    this.lastStats = { ms: Date.now() - t0 };
    return { latest, arrAt }; // latest[s]=从 s 出发的最晚绝对分钟(-1 不可行); arrAt[s]=该班到达 B 的时刻
  }

  // ---- 车站近期发车 ----
  departures(station, tFrom, count, classFilter) {
    const list = [];
    for (let q = this.stOff[station]; q < this.stOff[station + 1]; q++) {
      const t = this.stTrips[q];
      if (!this._classOk(t, classFilter)) continue;
      for (let k = this.off[t]; k < this.off[t + 1] - 1; k++) {
        if (this.tstops[k] === station) {
          for (let o = Math.floor(tFrom / 1440) * 1440; o <= tFrom + 1440; o += 1440) {
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

module.exports = { Engine };
