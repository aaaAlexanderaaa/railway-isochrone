// Role: 地点持久化与快照状态的边界验证；契约 docs/specs/exploration.md。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const Places=require('../public/places');
const {describe}=require('../public/data-status');
test('跨快照重排按站名恢复，旧下标不会换成别站',()=>{
  const old=[{n:'长沙南',c:'长沙'},{n:'杭州东',c:'杭州'}];
  const next=[{n:'杭州东',c:'杭州'},{n:'长安',c:'长安'},{n:'长沙南',c:'长沙'}];
  const saved=Places.encode({name:'长沙南',type:'stn',stops:[0]},old);
  assert(!('stops' in saved)); assert.deepEqual(Places.resolve(saved,next).stops,[2]);
  assert.deepEqual(Places.resolve({name:'长沙南',type:'stn',stops:[0]},next).stops,[2]);
  assert.equal(Places.resolve(saved,[next[0]]),null);
});
test('过期判断按北京时间的数据日期',()=>{
  assert.equal(describe({release:'gtfs-20261116-085531'},Date.parse('2026-11-16T16:00:00Z')).age,1);
  assert.equal(describe({release:'gtfs-20261004-052300'},Date.parse('2026-11-17T00:00:00Z')).stale,true);
});
