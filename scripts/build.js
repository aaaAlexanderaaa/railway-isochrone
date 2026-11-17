// Role: 准备 Cloudflare 静态产物并验证部署边界。
// 契约：docs/specs/delivery.md；不下载或更新时刻表。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {validate} = require('./validate_dataset');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const meta = validate(JSON.parse(fs.readFileSync('public/data/net.json', 'utf8')));
const manifest = JSON.parse(fs.readFileSync('public/data/manifest.json', 'utf8'));
if (meta.release !== manifest.current) throw new Error('manifest 与当前路网版本不一致');
for (const entry of manifest.versions) {
  if (!fs.existsSync(path.join('public/data', entry.file))) throw new Error(`归档缺失：${entry.id}`);
}
fs.copyFileSync('lib/engine.js', 'public/engine.js');
for (const entry of fs.readdirSync('public', {recursive: true, withFileTypes: true})) {
  if (!entry.isFile()) continue;
  const name = path.join(entry.parentPath, entry.name);
  if (fs.statSync(name).size > 25 * 1024 * 1024) throw new Error(`超过 Pages 25 MiB 单文件限制：${name}`);
}
console.log(`Cloudflare 静态资源已准备：${meta.release}`);
