// 通用浏览器驱动（支持常驻会话）
//   node browse.js start              启动常驻 headless Chromium (CDP :9223)
//   node browse.js stop               关闭
//   node browse.js run '<JSON动作数组>' 在常驻浏览器上执行动作
//   node browse.js run-once '<JSON>'  独立一次性会话执行
// 动作: goto/wait/click/clickText/fill/press/select/check/shot/eval/read/rows/exists/note
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const EXE = require("os").homedir().replace(/\\/g, "/") + "/AppData/Local/ms-playwright/chromium-1148/chrome-win/chrome.exe";
const PORT = 9223;
const PROFILE = path.join(__dirname, ".browse-profile");

async function getBrowser() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
  if (!r) throw new Error("常驻浏览器未启动，请先: node browse.js start");
  return chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
}

async function getPage(browser) {
  const ctx = browser.contexts()[0] || await browser.newContext();
  await ctx.route("**/*", (route) => route.continue()); // no-op
  let page = ctx.pages().find((p) => !p.url().startsWith("chrome-devtools"));
  if (!page) page = await ctx.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  return page;
}

async function runActions(page, actions) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + String(e).slice(0, 300)));
  fs.mkdirSync("shots", { recursive: true });
  const out = [];
  for (const a of actions) {
    const arg = a.arg == null ? "" : String(a.arg);
    const rec = { op: a.op, arg: a.arg == null ? undefined : String(a.arg).slice(0, 120) };
    try {
      switch (a.op) {
        case "note": rec.note = arg; break;
        case "goto": await page.goto(arg, { waitUntil: "domcontentloaded", timeout: 20000 }); rec.ok = true; break;
        case "wait": await page.waitForTimeout(Number(arg) || 500); rec.ok = true; break;
        case "click": await page.click(arg, { timeout: 8000 }); rec.ok = true; break;
        case "clickText": await page.locator(`text=${arg}`).first().click({ timeout: 8000 }); rec.ok = true; break;
        case "fill": { const [sel, ...rest] = arg.split("||"); await page.fill(sel, rest.join("||"), { timeout: 8000 }); rec.ok = true; break; }
        case "type": { const [sel, ...rest] = arg.split("||"); await page.type(sel, rest.join("||"), { delay: 60 }); rec.ok = true; break; }
        case "press": await page.keyboard.press(arg); rec.ok = true; break;
        case "select": { const [sel, val] = arg.split("||"); await page.selectOption(sel, val, { timeout: 8000 }); rec.ok = true; break; }
        case "check": await page.check(arg, { timeout: 8000 }); rec.ok = true; break;
        case "shot": { const f = path.join("shots", arg); await page.screenshot({ path: f, fullPage: !!a.full }); rec.file = f; break; }
        case "eval": rec.result = await page.evaluate(arg); break;
        // mouse: click||x,y / move||x,y / down / up —— 走 Playwright 受信输入，比 eval 派发合成事件更接近真实用户
        case "mouse": {
          const [act, xy] = arg.split("||");
          if (act === "click") { const [x, y] = xy.split(",").map(Number); await page.mouse.click(x, y); }
          else if (act === "move") { const [x, y] = xy.split(",").map(Number); await page.mouse.move(x, y); }
          else if (act === "down") await page.mouse.down();
          else if (act === "up") await page.mouse.up();
          else throw new Error("未知 mouse 动作: " + act);
          rec.ok = true; break;
        }
        case "read": { const r = await page.textContent(arg, { timeout: 8000 }); rec.text = (r || "").replace(/\s+/g, " ").trim().slice(0, a.max || 800); break; }
        case "rows": { const r = await page.$$eval(arg, (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim())); rec.count = r.length; rec.rows = r.slice(0, a.max || 30); break; }
        case "exists": rec.count = await page.locator(arg).count(); break;
        default: throw new Error("未知操作: " + a.op);
      }
    } catch (e) {
      rec.ok = false; rec.error = String(e.message || e).slice(0, 300);
      out.push(rec); break;
    }
    if (a.op !== "note") out.push(rec);
  }
  return { results: out, consoleErrors: errors };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === "start") {
    fs.mkdirSync(PROFILE, { recursive: true });
    const p = spawn(EXE, [
      "--headless=new", `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check",
      "--window-size=1440,900", "about:blank",
    ], { detached: true, stdio: "ignore" });
    p.unref();
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const ok = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
      if (ok) { console.log("browser ready on CDP :" + PORT); return; }
    }
    throw new Error("浏览器启动超时");
  }
  if (cmd === "stop") {
    const b = await getBrowser().catch(() => null);
    if (b) { await b.close(); console.log("browser closed"); } else console.log("not running");
    return;
  }
  if (cmd === "run") {
    const b = await getBrowser();
    const page = await getPage(b);
    const r = await runActions(page, JSON.parse(process.argv[3]));
    console.log(JSON.stringify(r, null, 1));
    await b.close(); // 断开连接但不关浏览器
    return;
  }
  if (cmd === "run-once") {
    const b = await chromium.launch({ headless: true, executablePath: EXE });
    const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
    const r = await runActions(page, JSON.parse(process.argv[3]));
    console.log(JSON.stringify(r, null, 1));
    await b.close();
    return;
  }
  throw new Error("用法: node browse.js start|stop|run '<JSON>'|run-once '<JSON>'");
}
main().catch((e) => { console.error("DRIVER FAIL:", e.message); process.exit(1); });
