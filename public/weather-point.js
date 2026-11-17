// Role: 单点天气的有界请求、共享缓存与到达时刻取值。
// 契约 docs/specs/exploration.md；不触发全国天气网格下载。
'use strict';
const WeatherPoint = (() => {
  const cache = new Map(), pending = new Map();
  async function load(lat, lon) {
    const key = lat.toFixed(2) + ',' + lon.toFixed(2);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.pack;
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      const response = await fetch(`/api/weather/point?la=${lat.toFixed(3)}&lo=${lon.toFixed(3)}`,
        {signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error('天气服务暂不可用');
      const pack = await response.json();
      if (!pack.ok || !pack.times?.length || !pack.models?.length) throw new Error('暂无预报数据');
      cache.set(key, {at:Date.now(), pack});
      return pack;
    })();
    pending.set(key, request);
    try { return await request; } finally { pending.delete(key); }
  }
  async function arrival(lat, lon, time) {
    const pack = await load(lat, lon);
    const times = pack.times.map(t => Date.parse(t + '+08:00'));
    if (time < times[0] || time > times.at(-1) + 3600000) return null;
    let index = 0;
    for (let i=1;i<times.length;i++) if (Math.abs(times[i]-time) < Math.abs(times[index]-time)) index=i;
    const model = pack.models.find(m=>m.id==='best_match') || pack.models[0];
    if (!Number.isFinite(model.temp?.[index]) || !Number.isFinite(model.code?.[index])) return null;
    return {temp:Math.round(model.temp[index]), code:model.code[index], precip:model.precip?.[index] ?? null};
  }
  return {load, arrival};
})();
