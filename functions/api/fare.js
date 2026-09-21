/**
 * Cloudflare Pages Function: 12306 公布票价按需查询。
 * GET /api/fare?date=YYYY-MM-DD&from=站名&to=站名
 * 12306 可能拒绝境外/数据中心 IP——失败返回 502，前端回退里程估算价。
 * 抓取/缓存逻辑唯一实现在 lib/fare12306.js（Node 与 CF 共用）。
 */
import FARE from "../../lib/fare12306.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const date = (url.searchParams.get("date") || "").trim();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !from || !to) {
    return new Response(JSON.stringify({ ok: false, error: "date/from/to 参数非法" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const cacheKey = new Request(url.origin + "/api/fare?k=" + encodeURIComponent(date + "|" + from + "|" + to), { method: "GET" });
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  } catch (e) { /* 无 Cache API 时直接拉 */ }
  try {
    const body = await FARE.queryFares(date, from, to);
    const res = new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=21600",
      },
    });
    try { context.waitUntil(caches.default.put(cacheKey, res.clone())); } catch (e) { /* ignore */ }
    return res;
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
