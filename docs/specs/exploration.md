---
id: exploration
stage: usable
owns: [lib/engine.js, lib/fare12306.js, public/*.js, public/*.css, public/*.html, public/_headers, public/_routes.json, server.js, functions/**, test_engine.js, tests/**, acceptance/**, browse.js]
depends_on: []
sources: [SRC-001, SRC-002]
---
# 铁路目的地探索

承诺：按地点、北京时间、预算和换乘约束给出目的地和可检查的行程。快照日期
和估算性质明确可见；刷新和数据更新后地点仍指向原地点。

```mermaid
flowchart LR
  I[表单 / 保存地点] --> N[按当前站名解析]
  N --> W[Worker 引擎]
  W --> J[非支配方案]
  J --> F[预算与交集过滤]
  F --> L[地图 / 列表]
  L --> D[车次与换乘详情]
```

reach / itinerary / constraint / departures 仅消费路网和数字参数。
lib/engine.js 唯一拥有算法，构建同步浏览器副本。正向与反向换乘、车种、跨日语义
一致；连续乘车不能因另一辆车更新同站标签而丢失。现实线路和固定小路网共同回归。

站点数组下标只属于一个快照；主出发地、附加圈、收藏在当前站表按名称解析。
地点消失时明确提示重选。日期零值和午夜零值有效。
预算下限默认严格过滤，更近的目的地由显式开关展示；详情默认只展示预算上限内车次。
后续行程继承初始预算、车种和换乘偏好，之后各段条件独立；返回出发地才称为返程。
到达截止与出发时段同时生效，出发上限只约束首程。基础城市数与交集结果数分开计算。

大文件不新增独立职责：通信、版本展示、地点保存提取成模块，详情、时间轴、返程和票价已分别提取，后续拆分列表与天气绘制。CSS 逐步拆共享变量、布局和组件，地图宽度服从地图用途。

验证：按改动检查引擎/Worker 故障、跨快照恢复、无 Node API 的浏览器查询；
缺陷用原输入复查。验证与审查规则见 [AGENTS.md](../../AGENTS.md#3-验证与审查)。
`acceptance/` 保存历史 AI 检查资料；`persona_gen.py` 是停用提示入口，原生成器归档。

已载入行程的日期锚点固定；跨北京时间午夜提示重新加载并停用旧查询，避免日期选项、
行程和票价请求分裂。DetailSession拥有异步有效期，旧响应不能回写当前详情。
