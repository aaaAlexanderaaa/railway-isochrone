// Role: 固定小路网回归，验证首程时段、跨日、换乘和双向查询。
// 契约：docs/specs/exploration.md；固定数据与生产路网分离。
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Engine} = require('../lib/engine');
function fixture(trips) {
  const count = 1 + Math.max(...trips.flatMap(t => t.stops));
  const d = {meta: {}, stations: Array.from({length: count}, (_,i)=>({n:String(i),c:String(i)})),
    names: [], cls: [], off: [0], stops: [], dep: [], arr: [], dist: [], stOff: [0], stTrips: []};
  trips.forEach((t,i) => {
    d.names.push(t.name || `G${i}`); d.cls.push((t.name || 'G')[0]);
    d.stops.push(...t.stops); d.dep.push(...t.dep); d.arr.push(...(t.arr || t.dep));
    d.dist.push(...t.stops.map((_,i)=>i*10)); d.off.push(d.stops.length);
  });
  for(let s=0;s<count;s++) { trips.forEach((t,i)=>{if(t.stops.includes(s)) d.stTrips.push(i);}); d.stOff.push(d.stTrips.length); }
  return new Engine(d);
}
test('稀疏路网保留单趟直达，所有首程出发都在窗口内', () => {
  const e=fixture([{stops:[0,1],dep:[480,540]}]);
  assert.equal(e.reach([0],400,600,'all').journeys.get(1)[0][0],480);
  assert.equal(e.reach([0],481,600,'all').journeys.size,0);
});
test('同一时刻保留更慢的直达及更快的一次换乘，行程可重构', () => {
  const e=fixture([{stops:[0,1],dep:[480,600]},{stops:[0,2],dep:[480,510]}, {stops:[2,1],dep:[525,550]}]);
  const js=e.reach([0],480,480,'all').journeys.get(1);
  assert.deepEqual(js.map(j=>[j[1],j[2]]).sort((a,b)=>a[0]-b[0]),[[550,2],[600,1]]);
  for(const j of js) {
    const it=e.itinerary([0],480,480,'all',j[4],1,j[2]);
    assert.equal(it.legs.length,j[2]); assert.equal(it.legs[0].dep,j[0]); assert.equal(it.legs.at(-1).arr,j[1]);
  }
});
test('出发窗口只约束首程；换乘间隔不足15分钟不可行', () => {
  const e=fixture([{stops:[0,2],dep:[550,600]},{stops:[2,1],dep:[630,700]}, {stops:[2,3],dep:[614,650]}]);
  const r=e.reach([0],500,600,'all');
  assert.equal(r.journeys.get(1)[0][1],700);
  assert(r.journeys.get(3)[0][1]>=1440);
  for (const js of r.journeys.values()) for (const j of js) assert(j[0]>=500 && j[0]<=600);
});
test('昨天始发的跨日车可在今天途中上车，正反向和近期发车一致', () => {
  const e=fixture([{name:'K1',stops:[0,1,2],dep:[1380,1500,1560]}]);
  assert.equal(e.reach([1],0,120,'all').journeys.get(2)[0][0],60);
  assert.equal(e.departures(1,0,3,'all')[0].dep,60);
  assert.equal(e.constraint([2],120,0,'all',0,0).latest[1],60);
});
test('同车续乘不被其他列车的更晚标签覆盖；反向限时保留较早抵达路径', () => {
  const e=fixture([{stops:[0,1,2],dep:[480,510,600]}, {stops:[1,2],dep:[520,550]}]);
  assert.equal(e.constraint([2],600,0,'all',0,0).latest[0],480);
  assert.equal(e.constraint([2],600,0,'all',1,120).latest[0],480);
});
test('车种过滤与14天每日运行图一致', () => {
  const e=fixture([{stops:[0,1],dep:[480,540]},{name:'K1',stops:[0,2],dep:[500,600]}]);
  assert.equal(e.reach([0],400,600,'gdc').journeys.has(2),false);
  for(const day of [0,4,13]) assert.equal(e.reach([0],day*1440+480,day*1440+480,'gdc').journeys.get(1)[0][1],day*1440+540);
});
test('抵达查询的出发上限只约束首程，后续换乘可在时段后',()=>{
  const e=fixture([{stops:[0,1],dep:[480,540]},{stops:[1,2],dep:[570,630]},{stops:[0,2],dep:[550,620]}]);
  assert.equal(e.constraint([2],700,400,'all',1,0,500).latest[0],480);
  assert.equal(e.constraint([2],700,400,'all',0,0,500).latest[0],-1);
});
