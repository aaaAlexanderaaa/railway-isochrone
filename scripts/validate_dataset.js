// Role: 校验快照结构与索引，供更新和构建共用。
// 契约：docs/specs/delivery.md；不修改数据。
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
function validate(data) {
  const {meta, stations, off, stops, dep, arr, dist, names, cls, stOff, stTrips} = data;
  assert(meta && /^gtfs-\d{8}-\d{6}$/.test(meta.release), '缺少有效 release');
  assert(stations.length > 0 && names.length > 0, '路网为空');
  assert.equal(meta.stations, stations.length, '站数不匹配');
  assert.equal(meta.trips, names.length, '车次名称与车次行错位');
  assert.equal(off.length, names.length + 1, '车次偏移与名称错位');
  assert.equal(cls.length, names.length, '车种与车次错位');
  for (const a of [dep, arr, dist]) assert.equal(a.length, stops.length, '停站数组长度不一致');
  assert.equal(off[0], 0); assert.equal(off.at(-1), stops.length);
  assert.equal(stOff.length, stations.length + 1);
  assert.equal(stOff[0], 0); assert.equal(stOff.at(-1), stTrips.length);
  const ids = new Set();
  stations.forEach(s => {
    assert(s.n && s.c && Number.isFinite(s.la) && Number.isFinite(s.lo), '车站字段缺失');
    assert(Math.abs(s.la) <= 90 && Math.abs(s.lo) <= 180, '坐标越界');
    assert(!ids.has(s.n), `重复站名：${s.n}`); ids.add(s.n);
  });
  for (let t = 0; t < names.length; t++) {
    assert(off[t + 1] - off[t] >= 2, `车次 ${names[t]} 停站不足`);
    for (let k = off[t]; k < off[t + 1]; k++) {
      assert(Number.isInteger(stops[k]) && stops[k] >= 0 && stops[k] < stations.length, '站点索引越界');
      assert(Number.isInteger(dep[k]) && Number.isInteger(arr[k]) && dep[k] >= 0 && arr[k] >= 0, '时刻无效');
      assert(arr[k] <= dep[k], `车次 ${names[t]} 本站出发早于到达`);
      assert(Number.isFinite(dist[k]) && dist[k] >= 0, '里程无效');
      if (k < off[t + 1] - 1) assert(dep[k] <= arr[k + 1], `车次 ${names[t]} 到达早于出发`);
    }
  }
  for (let s = 0; s < stations.length; s++) {
    assert(stOff[s + 1] >= stOff[s], '站点偏移逆序');
    for (let i = stOff[s]; i < stOff[s + 1]; i++) {
      const t = stTrips[i];
      assert(Number.isInteger(t) && t >= 0 && t < names.length, '车次索引越界');
      assert(stops.slice(off[t], off[t + 1]).includes(s), '站点车次反向索引错位');
    }
  }
  return meta;
}
if (require.main === module) {
  const meta = validate(JSON.parse(fs.readFileSync(process.argv[2] || 'public/data/net.json', 'utf8')));
  console.log(`数据结构通过：${meta.release}，${meta.stations} 站 / ${meta.trips} 车次`);
}
module.exports = {validate};
