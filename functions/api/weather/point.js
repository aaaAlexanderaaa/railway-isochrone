/**
 * Cloudflare Pages Function: 单点多模型天气预报（Open-Meteo）。
 * GET /api/weather/point?la=&lo=
 * 浏览器直连 Open-Meteo 虽无 CORS 障碍，但经此端点可共享边缘缓存并统一模型清单。
 */
import WC from "../../../public/weather_core.js";

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const la = Number(url.searchParams.get("la")), lo = Number(url.searchParams.get("lo"));
  const bad = !Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180;
  if (bad) {
    return new Response(JSON.stringify({ ok: false, error: "la/lo 参数非法" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const key = la.toFixed(2) + "," + lo.toFixed(2);
  const cacheKey = new Request(url.origin + "/api/weather/point?k=" + encodeURIComponent(key), { method: "GET" });
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) return hit;
  } catch (e) { /* 无 Cache API 时直接拉 */ }

  try {
    const pack = await WC.fetchPoint(la, lo);
    pack.fetchedAt = new Date().toISOString();
    const res = new Response(JSON.stringify(pack), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=10800",
      },
    });
    try {
      context.waitUntil(caches.default.put(cacheKey, res.clone()));
    } catch (e) { /* ignore */ }
    return res;
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
