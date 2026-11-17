# 项目文档

铁路可达圈帮助用户按铁路时间预算选目的地，也支持多地出发的共同目的地。
当前优先保证时刻表更新、查询正确和 Cloudflare 可运行。

| 事实 | 唯一维护位置 |
|---|---|
| 工作规则与验收 | [AGENTS.md](../AGENTS.md) |
| 全局逻辑和模块关系 | [ARCHITECTURE.md](../ARCHITECTURE.md) |
| 数据生成和发布 | [delivery.md](specs/delivery.md) |
| 查询、存储和页面 | [exploration.md](specs/exploration.md) |
| 用户原话 | [sources.toml](sources.toml) |
| 当前任务和后续方向 | [work.toml](work.toml) |
| 模板采纳依据 | [discipline-adoption.md](discipline-adoption.md) |
| 历史 AI 检查记录说明 | [acceptance/README.md](../acceptance/README.md) |
| 质询和方向选择 | [2026-11-grill.md](reviews/2026-11-grill.md) |
| 本轮验证与外部边界 | [2026-11-delivery.md](reviews/2026-11-delivery.md) |

用平实中文写文档、界面和 CLI，同一概念用同一个名字。语言和验证规则以 AGENTS.md 为准。
README 提供运行入口，细节回链所属文档，不重复维护实现事实。
