// Role: 在 Cloudflare 本地运行环境验证实际浏览器入口、Worker 与失败恢复。
// 契约：docs/specs/exploration.md；不依赖 Node 查询 API。
'use strict';
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const port = 8790, base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'pages', 'dev', 'public', '--port', String(port)], {stdio: ['ignore','pipe','pipe']});
let logs=''; for(const stream of [server.stdout,server.stderr]) stream.on('data',d=>{logs=(logs+d).slice(-5000);});
let browser;
async function ready() {
  for(let i=0;i<120;i++) {
    if(server.exitCode !== null) throw new Error(logs);
    try { if((await fetch(base)).ok) return; } catch (_) {}
    await new Promise(r=>setTimeout(r,500));
  }
  throw new Error('Wrangler 启动超时：'+logs);
}
(async()=>{
  await ready();
  browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:'America/Los_Angeles'});
  const page=await context.newPage(); const errors=[], railHTTP=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(/\/api\/(meta|reach|itinerary|constraint|departures)/.test(r.url()))railHTTP.push(r.url());});
  await page.goto(base);
  await page.locator('#data-badge').filter({hasText:'班/日'}).waitFor({timeout:30000});
  assert(await page.locator('#help-overlay').isHidden());
  await page.locator('#btn-demo').click();
  await page.waitForFunction(()=>document.querySelectorAll('#list-table tbody tr[data-stop]').length>0,{},{timeout:30000});
  await page.locator('#btn-table').click();
  await page.locator('#list-table tbody tr[data-stop]').first().click();
  await page.locator('#d-itin .leg').first().waitFor({timeout:15000});
  await page.locator('#btn-return-home').click();
  await page.locator('.vc-tra').selectOption('0');
  await page.locator('input.vc-arrby').fill('19:00');
  await page.locator('#btn-query').click();
  await page.waitForFunction(()=>document.querySelector('#btn-query').disabled === false,{},{timeout:30000});
  assert(!(await page.locator('#status').innerText()).includes('失败'));
  await page.locator('#list-table tbody tr[data-stop]').first().click();
  await page.locator('#xleg-out .jrow').first().waitFor({timeout:30000});
  const returnRows=await page.locator('#xleg-out .jrow').allTextContents();
  assert(returnRows.every(t=>t.includes('直达') && !t.includes('换乘')));
  assert(!(await page.locator('#d-fare').innerText()).includes('≈¥0'));
  assert.equal((await fetch(base+'/api/fare')).status,400);
  assert.deepEqual(railHTTP,[], '铁路查询不应回退到 Node HTTP API');
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric'}).formatToParts(new Date());
  const month = Number(parts.find(p=>p.type==='month').value), day = Number(parts.find(p=>p.type==='day').value);
  const todayText = await page.locator('#today-label').innerText();
  assert(todayText.includes('北京时间') && todayText.includes(`${month}/${day}`), todayText);
  const before=await page.locator('#origin-stns input:checked').evaluateAll(els=>els.map(e=>e.parentElement.textContent.trim()));
  await page.reload();
  await page.locator('#data-badge').filter({hasText:'班/日'}).waitFor();
  assert.deepEqual(await page.locator('#origin-stns input:checked').evaluateAll(els=>els.map(e=>e.parentElement.textContent.trim())),before);
  assert.equal(await page.locator('input.vc-arrby').inputValue(),'19:00');
  // 回归往返摘要一致性、午夜时段保留与辅助天气故障。
  await page.evaluate(()=>localStorage.clear());
  await page.route('**/api/weather/point?*',r=>r.fulfill({status:502,body:'unavailable'}));
  await page.reload();
  await page.locator('#data-badge').filter({hasText:'班/日'}).waitFor();
  assert(await page.locator('#help-overlay').isHidden());
  await page.locator('#origin-input').fill('上海');
  await page.locator('#origin-drop .item').filter({has:page.locator('.nm', {hasText:/^上海$/})}).first().click();
  assert((await page.locator('#origin-chosen').innerText()).startsWith('上海'));
  await page.locator('#date-sel').selectOption('1');
  await page.locator('#from-time').fill('21:00');
  await page.locator('#until-time').fill('22:00');
  await page.locator('[data-budget="0,120"]').click();
  await page.locator('#seg-cls label').filter({hasText:'高铁动车'}).click();
  assert(await page.locator('input[name="cls"][value="gdc"]').isChecked());
  await page.locator('#seg-tra label').filter({hasText:'仅直达'}).click();
  assert(await page.locator('input[name="tra"][value="0"]').isChecked());
  await page.locator('#btn-return-home').click();
  await page.locator('.vc-date').selectOption('2');
  assert.equal(await page.locator('.vc-from').inputValue(),'00:00');
  await page.locator('input.vc-arrby').fill('21:30');
  await page.locator('#btn-query').click();
  await page.waitForFunction(()=>document.querySelector('#btn-query').disabled===false,{},{timeout:30000});
  await page.locator('#btn-table').click();
  await page.locator('#list-body tr[data-stop]').filter({has:page.locator('td:first-child b', {hasText:/^苏州$/})}).first().click();
  await page.locator('#xleg-out .jrow').filter({hasText:'D3024'}).waitFor({timeout:30000});
  assert((await page.locator('#d-const').innerText()).includes('20:50'));
  const latestRow=page.locator('#xleg-out .jrow').filter({hasText:'D3024'});
  assert((await latestRow.innerText()).includes('20:50'));
  await latestRow.click();
  await page.locator('#d-itin .tripno').filter({hasText:'D3024'}).waitFor();
  assert((await page.locator('#d-itin').innerText()).includes('苏州'));
  assert((await page.locator('#xleg-out').innerText()).includes('00:00 起'));
  assert(await page.locator('#d-strip').evaluate(el=>!!(el.compareDocumentPosition(document.querySelector('#d-followup'))&Node.DOCUMENT_POSITION_FOLLOWING)));
  await page.locator('#d-wx-sec summary').click();
  await page.getByRole('button',{name:'重试天气'}).waitFor();
  assert((await page.locator('#d-wx').innerText()).includes('暂不可用'));
  assert(!(await page.locator('#d-wx-body').innerText()).includes('HTTP'));
  // 检查加载失败提示和重试入口在窄、宽窗口可见。
  for(const width of [540,800,1280,2560]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>DataStatus.fail('时刻表加载失败，请重新加载'));
    assert(await page.getByRole('button',{name:'重新加载',exact:true}).isVisible());
  }
  const invalid=await fetch(base+'/api/weather/point?la=bad&lo=120');
  assert.equal(invalid.status,400);
  const failure=await context.newPage();
  await failure.route('**/engine-worker.js',r=>r.abort());
  await failure.goto(base);
  await failure.locator('#data-badge').filter({hasText:'加载失败'}).waitFor({timeout:15000});
  assert(await failure.getByRole('button',{name:'重新加载',exact:true}).isVisible());
  assert.deepEqual(errors,[]);
  console.log('通过：Cloudflare Worker 查询、详情、北京时间、地点恢复、天气参数、加载失败与重试入口。');
})().catch(e=>{console.error(e); process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();
  server.kill('SIGTERM');
  await Promise.race([once(server,'exit'),new Promise(r=>setTimeout(r,3000))]);
  if(server.exitCode===null) server.kill('SIGKILL');
});
