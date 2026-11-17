// Role: 展示时刻表日期、过期状态和新版本通知。
// 契约：docs/specs/exploration.md；刷新由用户决定，避免改变正在看的行程。
'use strict';
const DataStatus = (() => {
  const STALE_DAYS = 14;
  let current;
  function describe(meta, now = Date.now()) {
    const m = String(meta.release || '').match(/gtfs-(\d{4})(\d{2})(\d{2})/);
    const date = m ? `${m[1]}-${m[2]}-${m[3]}` : '未知日期';
    const age = m ? Math.max(0, Math.floor((now - Date.parse(`${date}T00:00:00+08:00`)) / 86400000)) : null;
    return {date, age, stale: age === null || age > STALE_DAYS};
  }
  function notice(text, reload = false) {
    const el = document.getElementById('data-notice');
    el.replaceChildren(document.createTextNode(text));
    el.hidden = !text;
    if (reload) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = '重新加载';
      b.onclick = () => location.reload(); el.append(' ', b);
    }
  }
  function show(meta) {
    current = meta.release;
    const {date, age, stale} = describe(meta);
    const badge = document.getElementById('data-badge');
    badge.textContent = `时刻表 ${date} · ${Number(meta.trips).toLocaleString('zh-CN')} 班/日 · ${Number(meta.stations).toLocaleString('zh-CN')} 站`;
    badge.title = `${meta.calendar || '每日运行图近似'} · ${current} · 购票以 12306 为准`;
    if (stale) notice(`时刻表${age === null ? '日期未知' : `已 ${age} 天未更新`}，可能与当前开行不同，请在 12306 核对车次。`);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    setInterval(check, 300000);
  }
  async function check() {
    try {
      const r = await fetch('data/manifest.json', {cache: 'no-cache'});
      if (!r.ok) return;
      const m = await r.json();
      if (m.current && m.current !== current) notice('有新的时刻表，重新加载后使用新数据。', true);
    } catch (_) { /* 离线时继续用已载入快照 */ }
  }
  function fail(message) {
    document.getElementById('data-badge').textContent = '时刻表加载失败';
    notice(message, true);
  }
  return {show, fail, describe, newDay: () => notice("北京时间已进入新一天。已展示行程的日期保持不变，请重新加载后继续查询。", true)};
})();
if (typeof module !== 'undefined') module.exports = DataStatus;
