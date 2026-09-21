/**
 * Cloudflare Pages Function: 代理中央气象台预警列表（浏览器直连无 CORS）。
 * 路由：GET /api/weather/alarms
 */
const UA = "railway-map/1.0 (weather overlay; +https://github.com/wensimehrp/chinese-railway-gtfs)";
const NMC = "https://www.nmc.cn/rest/findAlarm";

async function fetchPage(pageNo, pageSize) {
  const url = `${NMC}?pageNo=${pageNo}&pageSize=${pageSize}&signaltype=&signallevel=&province=`;
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`nmc HTTP ${r.status}`);
  return r.json();
}

export async function onRequestGet() {
  try {
    const first = await fetchPage(1, 200);
    const page = first && first.data && first.data.page;
    let list = (page && page.list) || [];
    const provinceAlarms = (first && first.data && first.data.provinceAlarms) || [];
    const totalPage = (page && page.totalPage) || 1;
    for (let p = 2; p <= Math.min(totalPage, 3); p++) {
      const more = await fetchPage(p, 200);
      const extra = more && more.data && more.data.page && more.data.page.list;
      if (extra && extra.length) list = list.concat(extra);
    }
    const body = JSON.stringify({
      ok: true,
      source: "nmc.cn",
      fetchedAt: new Date().toISOString(),
      count: list.length,
      list,
      provinceAlarms,
      stat: (first && first.data && first.data.stat) || null,
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err.message || err) }), {
      status: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}
