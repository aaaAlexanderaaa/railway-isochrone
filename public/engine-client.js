// Role: 浏览器 Worker 生命周期和请求超时；不依赖 Node HTTP API。
// 契约：docs/specs/exploration.md；页面只通过 boot/query 使用引擎。
'use strict';
const RailAPI = (() => {
  let worker, seq = 0;
  const pending = new Map();
  function fail(error) {
    if (worker) worker.terminate();
    worker = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }
  function call(method, args = {}) {
    if (!worker) return Promise.reject(new Error('计算服务未就绪，请重新加载页面'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('计算超时，请重新加载页面')), 60000);
      pending.set(id, {resolve, reject, timer});
      worker.postMessage({id, method, args});
    });
  }
  async function boot() {
    worker = new Worker('engine-worker.js');
    worker.onerror = () => fail(new Error('计算服务加载失败，请重新加载页面'));
    worker.onmessageerror = () => fail(new Error('计算结果无法读取，请重新加载页面'));
    worker.onmessage = ({data}) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id); clearTimeout(p.timer);
      if (data.ok) p.resolve(data.result); else p.reject(new Error(data.error));
    };
    return call('boot', {netUrl: 'data/net.json'});
  }
  async function query(url) {
    const u = new URL(url, location.origin);
    const method = u.pathname.split('/').at(-1);
    if (['meta','reach','itinerary','constraint','departures'].includes(method)) {
      return call(method, Object.fromEntries(u.searchParams));
    }
    const r = await fetch(u);
    if (!r.ok) throw new Error(`请求失败 HTTP ${r.status}`);
    return r.json();
  }
  return {boot, query};
})();
