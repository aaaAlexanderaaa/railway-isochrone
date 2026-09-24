// 浏览器 QA: 打开产品 -> 示例场景 -> 详情 -> 行程, 每步截图 + 收集控制台错误
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  fs.mkdirSync(path.join("shots"), { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: require("os").homedir() + "\\AppData\\Local\\ms-playwright\\chromium-1148\\chrome-win\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 300)}`));

  await page.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: "shots/01-init-help.png" });

  // 关闭帮助
  await page.click("#help-close");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "shots/02-empty.png" });

  // 载入示例场景
  await page.click("#btn-demo");
  await page.waitForFunction(() => !document.getElementById("status").textContent.includes("计算中"), null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "shots/03-demo-result.png" });

  // 表格自 round-20 起默认收起，按需展开（已是展开态则跳过，避免反向收起）
  const tblHidden = await page.$eval("#list-panel", (el) => el.classList.contains("hidden"));
  if (tblHidden) await page.click("#btn-table");
  await page.waitForTimeout(400);

  const status = await page.textContent("#status");
  console.log("STATUS:", status);
  const listTitle = await page.textContent("#list-title");
  console.log("LIST:", listTitle);
  const rows = await page.$$eval("#list-body tr[data-stop]", (trs) => trs.slice(0, 12).map((tr) => tr.textContent.replace(/\s+/g, " ").trim()));
  rows.forEach((r) => console.log("  ROW:", r));

  // 点击列表第2行 -> 详情
  const trs = await page.$$("#list-body tr[data-stop]");
  if (trs.length > 1) {
    await trs[1].click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "shots/04-detail.png" });
    console.log("DETAIL TITLE:", await page.textContent("#d-title"));
    console.log("DETAIL SUB:", await page.textContent("#d-sub"));

    // 点击时间轴第一个方案条
    const bars = await page.$$("#d-strip .bar");
    console.log("BARS:", bars.length);
    if (bars.length) {
      await bars[Math.floor(bars.length / 2)].click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: "shots/05-itinerary.png" });
      const itin = await page.textContent("#d-itin");
      console.log("ITIN:", itin.replace(/\s+/g, " ").slice(0, 400));
    }

    // 约束段: 查看X->上海方案
    const xbtn = await page.$("#btn-xleg");
    if (xbtn) {
      await xbtn.click();
      await page.waitForTimeout(4000);
      await page.screenshot({ path: "shots/06-xleg.png" });
      const txt = await page.textContent("#d-const");
      console.log("XLEG:", txt.replace(/\s+/g, " ").slice(0, 500));
    }
  }

  console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
  await browser.close();
})().catch((e) => { console.error("QA FAILED:", e); process.exit(1); });
