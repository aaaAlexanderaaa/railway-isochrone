"use strict";
/** 12306 公布票价按需懒查（非官方接口）。
 * 供 server.js 与 Cloudflare Pages Function 共用（UMD）。
 *
 * 纪律：
 *  - 只在用户点开具体行程时逐 (日期, 发到站) 查询，不做批量爬取；
 *  - 站码表缓存 7 天，票价缓存 6 小时（公布价按日期浮动）；
 *  - 任何失败都抛错，由调用方回退到里程估算价——票价富集是增强，不是依赖。
 * 价格字段单位是 0.1 元（角），5 位补零字符串，如 "07950" = ¥795.0（京沪二等公布价实测吻合）。
 */
const FARE12306 = (function () {
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const STATION_JS = "https://kyfw.12306.cn/otn/resources/js/framework/station_name.js";
  const PRICE_URL = "https://kyfw.12306.cn/otn/leftTicketPrice/queryAllPublicPrice";
  // 展示口径：坐票（二等/硬座）为主，卧铺/商务为辅
  const FIELD_LABELS = {
    swz_price: "商务座", tz_price: "特等座", zy_price: "一等座", ze_price: "二等座",
    gr_price: "高级软卧", rw_price: "软卧", srrb_price: "动卧", yw_price: "硬卧",
    yz_price: "硬座", wz_price: "无座",
  };

  let telecodeMap = null, telecodeAt = 0;
  const fareCache = new Map(); // "date|from|to" -> { at, body }
  const inflight = new Map();
  const FARE_TTL = 6 * 60 * 60 * 1000;
  const TELECODE_TTL = 7 * 24 * 60 * 60 * 1000;
  const CACHE_MAX = 500;

  async function loadTelecodes(fetchImpl) {
    if (telecodeMap && Date.now() - telecodeAt < TELECODE_TTL) return telecodeMap;
    const f = fetchImpl || fetch;
    const r = await f(STATION_JS, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("station_name HTTP " + r.status);
    const js = await r.text();
    const map = new Map();
    for (const rec of js.split("@")) {
      const fld = rec.split("|");
      if (fld.length > 3 && /^[A-Z]{3}$/.test(fld[2] || "")) map.set(fld[1], fld[2]);
    }
    if (map.size < 1000) throw new Error("station_name 解析异常（" + map.size + " 站）");
    telecodeMap = map;
    telecodeAt = Date.now();
    return map;
  }

  function pickPrices(dto) {
    const out = {};
    for (const [k, label] of Object.entries(FIELD_LABELS)) {
      const v = Number(dto[k]);
      if (Number.isFinite(v) && v > 0) out[k.replace("_price", "")] = Math.round(v) / 10;
    }
    return out;
  }

  async function queryFares(date, fromName, toName, fetchImpl) {
    const key = date + "|" + fromName + "|" + toName;
    const hit = fareCache.get(key);
    if (hit && Date.now() - hit.at < FARE_TTL) return hit.body;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const f = fetchImpl || fetch;
      const codes = await loadTelecodes(f);
      const from = codes.get(fromName), to = codes.get(toName);
      if (!from || !to) {
        const err = new Error("站名不在 12306 站码表: " + (!from ? fromName : toName));
        err.status = 404;
        throw err;
      }
      const url = `${PRICE_URL}?leftTicketDTO.train_date=${encodeURIComponent(date)}&leftTicketDTO.from_station=${from}&leftTicketDTO.to_station=${to}&purpose_codes=ADULT`;
      const r = await f(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!r.ok) throw new Error("12306 HTTP " + r.status);
      const j = await r.json();
      const rows = (j && j.data) || [];
      const list = rows.map((row) => {
        const d = (row && row.queryLeftNewDTO) || {};
        return {
          code: d.station_train_code || "",
          dur: d.lishi || "",
          from: d.from_station_name || fromName,
          to: d.to_station_name || toName,
          prices: pickPrices(d),
        };
      }).filter((x) => x.code);
      const body = { ok: true, date, from: fromName, to: toName, count: list.length, list };
      fareCache.set(key, { at: Date.now(), body });
      if (fareCache.size > CACHE_MAX) {
        for (const [k2, v2] of fareCache) { if (fareCache.size <= CACHE_MAX) break; if (!inflight.has(k2)) fareCache.delete(k2); }
      }
      return body;
    })().catch((e) => { throw e; }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  return { queryFares, loadTelecodes, FIELD_LABELS };
})();

if (typeof module !== "undefined" && module.exports) module.exports = FARE12306;
