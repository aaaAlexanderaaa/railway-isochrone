# 铁路可达圈

按出发地、日期和乘车时间预算探索铁路目的地；查看车次、换乘和返程衔接，
也可以叠加不同出发地寻找大家都能到达的城市。铁路查询在浏览器 Worker 中运行，
Cloudflare Pages 提供静态站点，Pages Functions 提供可选天气与公布票价代理。

## 本地运行

需要 Node.js 22+、Python 3.10+；建议 Node.js 24、Python 3.12。

```bash
npm ci
npm run build
npm start
# http://127.0.0.1:8787
```

Cloudflare 运行环境预览（同样不需要账号）：

```bash
npm run pages:dev
# http://127.0.0.1:8787
```

`npm run build` 同步 `lib/engine.js` 到浏览器副本，并校验路网、归档清单和 Pages
单文件大小。不要手改 `public/engine.js`。项目架构与模块所有者见
[ARCHITECTURE.md](ARCHITECTURE.md)。

## 部署 Cloudflare Pages

推荐使用 **Direct Upload 项目 + GitHub Actions**，代码发布和数据更新走同一套验证。
Wrangler 固定版本包含在开发依赖与锁文件中。

1. 首次用自己的 Cloudflare 账号运行以下命令创建项目（已有项目跳过 create）：

   ```bash
   npx wrangler login
   npx wrangler pages project create railway-map --production-branch main
   npm test
   npm run build
   npm run pages:build
   npm run deploy -- --project-name railway-map --branch main
   ```

2. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 设置：

   | 类型 | 名称 | 内容 |
   |---|---|---|
   | Secret | `CLOUDFLARE_API_TOKEN` | 限定目标账号、具有 Account / Cloudflare Pages / Edit 的 API Token |
   | Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID |
   | Variable，可选 | `CF_PAGES_PROJECT` | Pages 项目名，默认 `railway-map` |

3. 将仓库改动推送到 `main`。`deploy-pages` 会安装依赖、运行测试、构建 Functions、
   在 Cloudflare 本地运行环境做浏览器检查，然后发布。也可在 Actions 手动运行。
   生产地址由 Wrangler 的部署结果给出。
4. 保持 GitHub Actions 启用，允许 `update-dataset` 的 `contents: write`；若 main
   有禁止机器人直推的分支保护，需要按团队策略给数据更新分支安排合并通道。
   工作流失败时在 GitHub 订阅 Actions 通知并查看失败步骤。

若使用 Cloudflare 的 Git integration：构建命令 `npm run build`，输出目录 `public`，
环境 Node.js 24。不要同时启用两套生产自动部署。推荐本仓库提供的 Actions 路径，
以便更新任务能明确等待并验证部署结果。

## 自动更新与回滚

`update-dataset` 每天北京时间 **14:23** 检查
[wensimehrp/chinese-railway-gtfs Releases](https://github.com/wensimehrp/chinese-railway-gtfs/releases)。
GitHub 计划任务可能延迟；公共仓库长期无活动也可能停用计划任务，需在 Actions 确认状态。

新版本在临时目录下载、ETL、结构校验并执行现实线路回归，通过后才替换当前快照、
原始 GTFS 和版本记录。失败保留旧文件。相同版本不重复构建；代码构建始终同步引擎。
上游站码别名合并和异常车次过滤计数保存在 `net.json` 的 `meta.quality`。

数据提交后**显式调用发布工作流**，不依赖 `GITHUB_TOKEN` 的 push 再触发工作流。
没有新数据也会重试发布，便于恢复此前的部署失败。凭据缺失会明确失败。

```bash
npm run update:data                         # 本地下载、验证、更新
python3 scripts/update_dataset.py --dry-run --skip-submodule
python3 scripts/update_dataset.py --rebuild-local  # 使用已下载原始GTFS重新生成并完整验证
DEPLOY=1 ./scripts/redeploy.sh              # 更新、完整验证、发布
```

归档在 `public/data/archive/`，从本地保存日起至少保留31天，并始终保留实际上一份；
`public/data/manifest.json` 记录当前与上一份版本。需要回滚时可重新生成已知版本：

```bash
python3 scripts/update_dataset.py --tag gtfs-20261004-052300 --skip-submodule
npm test
npm run deploy -- --project-name railway-map --branch main
```

也可在 Cloudflare Dashboard 回滚到先前成功的部署。回滚后暂时停用更新任务，防止
下次定时检查重新升级；修复后恢复任务。时刻表超过14天未更新会提示用户核对，
页面检测到新版本会提供重新加载入口，避免悄悄改变正在查看的行程。跨北京时间午夜
会保留已展示行程的日期，提示重新加载后再查询。

## 验证

```bash
npm test                      # 固定路网、现实线路、更新失败与归档边界
npm run build
npm run pages:build
npx playwright install chromium
npm run test:browser           # 自动启动 Wrangler，真实 Worker 查询与失败路径
node browse.js start          # 启动浏览器，复现具体界面问题
node browse.js run '[{"op":"goto","arg":"http://127.0.0.1:8787"}]'
node browse.js stop
```

Linux 缺少浏览器系统库时执行 `npx playwright install --with-deps chromium`。
可以通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定本机 Chromium。
验证规则见 [AGENTS.md](AGENTS.md#3-验证与审查)。根据改动运行相关检查，修复后用原输入复查。
历史 AI 检查记录见 [acceptance/README.md](acceptance/README.md)。

## 数据口径

- 时刻表是社区周更快照，按每日开行近似；日期和“现在”统一北京时间。
- 同站换乘至少15分钟，最多两次换乘；同城跨站接驳由用户自行安排。
- “典型”是主档方案耗时中位数，预算上限及车种/换乘过滤会改变统计。
  大站全天查询采用最多约190个出发样本，方案数是探索指标。
- 有经由里程时按席别费率估算票价；上游缺少里程时明确显示不可估算，可尝试查询公布票价。
  余票、临时停运和实际购票价格请在12306核对。
- 天气为 Open-Meteo 粗网格预报和中央气象台预警；天气失败不会阻止铁路查询。
- 城市采用人工映射和站名归并，省份按本地省级GeoJSON边界判断；地图高德瓦片使用 GCJ-02，站点已作坐标转换。
