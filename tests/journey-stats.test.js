// Role: 统一统计与详情筛选的边界防护；契约 docs/specs/exploration.md。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const stats=require('../public/journey-stats');
const js=[[480,600,1],[490,680,1],[500,620,2],[510,750,1]];
test('返程详情同时执行直达、预算、最晚到达条件',()=>{
  assert.deepEqual(stats.filter(js,{from:400,until:700,maxTra:0,bmax:180,enforceBudget:true,arriveBy:700}),[js[0]]);
});
test('在地时间取预算内到达；不限预算不收窄主档',()=>{
  const trips=[[1,190,1],[100,220,1],[200,350,1]];
  const limited=stats.summarize(trips,{from:0,until:500,maxTra:0,bmax:180});
  assert.equal(limited.firstArr,220);
  const all=stats.summarize(trips,{from:0,until:500,maxTra:0,bmax:0});
  const wide=stats.summarize(trips,{from:0,until:500,maxTra:0,bmax:1440});
  assert.equal(all.typ,wide.typ);assert.equal(all.cnt,wide.cnt);
});
test('人在出发城市无需乘车，但不能伪造车次',()=>{
  const local=stats.atOrigin(480);assert.equal(local.typ,0);assert.equal(local.firstArr,480);
  assert.deepEqual(local.js,[]);assert.equal(local.cnt,0);
});
