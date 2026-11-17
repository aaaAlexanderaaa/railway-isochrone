// Role: 按需查询公布票价并回填当前行程；契约 docs/specs/exploration.md。
// 使用页面发布的 state / api 接口，不拥有查询输入。
"use strict";
// 12306 公布价富集：逐程按 (日期, 发到站) 懒查，命中则替换里程估算；
// 任何失败静默保留估算价——票价是增强不是依赖
function ymdForDayOff(dayOff) {
  // 查询日偏移 → 北京时间 YYYY-MM-DD（anchorDateStr 是"9/21 周一"展示格式，不能当参数用）
  const t = new Date(state.anchor.getTime() + (Number(dayOff) || 0) * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(t);
}
async function enrichFares(legs, token) {
  if (!legs.length) return;
  const byKey = new Map();
  legs.forEach((l, i) => {
    const day = Math.floor(l.dep / 1440);
    const date = ymdForDayOff(day);
    const key = date + "|" + STATIONS[l.from].n + "|" + STATIONS[l.to].n;
    if (!byKey.has(key)) byKey.set(key, { date, from: STATIONS[l.from].n, to: STATIONS[l.to].n });
  });
  const results = await Promise.all([...byKey.values()].map((q) =>
    api(`/api/fare?date=${encodeURIComponent(q.date)}&from=${encodeURIComponent(q.from)}&to=${encodeURIComponent(q.to)}`)
      .catch(() => null)));
  if (!DetailSession.currentJourney(token)) return;
  const keyBody = new Map();
  [...byKey.keys()].forEach((k, idx) => { if (results[idx] && results[idx].ok) keyBody.set(k, results[idx]); });
  if (!keyBody.size) return;
  const total = { sum: 0, n: 0 };
  legs.forEach((l, i) => {
    const span = document.querySelector(`[data-fareleg="${i}"]`);
    if (!span) return;
    const day = Math.floor(l.dep / 1440);
    const key = ymdForDayOff(day) + "|" + STATIONS[l.from].n + "|" + STATIONS[l.to].n;
    const body = keyBody.get(key);
    if (!body) return;
    // 车次匹配：斜杠双号（跨线变次）任一段命中即可
    const parts = String(l.trip).split("/");
    const row = body.list.find((r2) => parts.some((p) => r2.code === p || r2.code.startsWith(p + "/") || r2.code.endsWith("/" + p)));
    if (!row) return;
    const bits = [];
    const seat = row.prices.ze != null ? row.prices.ze : row.prices.yz; // 坐票口径：二等/硬座
    const secondary = row.prices.zy != null ? row.prices.zy : row.prices.yw; // 一等/卧铺参考
    if (seat != null) bits.push(`¥${seat}`);
    if (secondary != null) bits.push(`(一等/卧 ¥${secondary})`);
    if (bits.length) {
      span.textContent = bits.join(" ") + " ";
      span.title = "12306 公布票价（坐票为二等/硬座口径；实际以 12306 为准）";
      if (seat != null) { total.sum += seat; total.n++; }
    }
  });
  if (total.n === legs.length && total.n > 0) {
    const cell = $("d-fare");
    if (cell) {

      const kmEl = cell.querySelector(".v");
      if (kmEl && (kmEl.textContent.includes("≈") || kmEl.textContent.includes("暂无"))) {
        const sumTxt = Number.isInteger(total.sum) ? String(total.sum) : total.sum.toFixed(1); // 保留 .5 精度，与逐程数字一致（round-21 #5）
        cell.innerHTML = `<div class="k">票价(二等/硬座, 12306)</div><div class="v">¥${sumTxt}</div>`;
        cell.title = "按当前行程逐程取 12306 公布价（坐票口径）合计；余票/折扣以 12306 为准";
      }
    }
  }
}
