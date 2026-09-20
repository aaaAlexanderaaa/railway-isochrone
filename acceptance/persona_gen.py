# -*- coding: utf-8 -*-
"""
随机身份验收 —— 用户画像生成器

纪律（用户 2026-09-19 指示 + template-project 纪律）:
- 验收必须是独立 subagent 完整使用产品。
- 随机的是【用户身份与需求】（本脚本），绝不随机/指定【操作路径】——
  subagent 拿到的只有"一个真实用户的问题 + 产品地址"，怎么用由它自己决定。
- 不通过 → 全量反馈所有问题 → 全部修复 → 换新的随机身份重新验收。

用法:
  python acceptance/persona_gen.py [round_id]   # 默认按已有轮次自动递增
输出:
  acceptance/rounds/round-<N>.md   (给 subagent 的完整任务书)
  终端打印 grader key（验收方核对用，绝不给 subagent）
"""
import json, os, random, sys, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROUNDS = os.path.join(ROOT, "acceptance", "rounds")
NET = os.path.join(ROOT, "public", "data", "net.json")

# ---------- 候选池 ----------
IDENTITIES = [
    ("出差销售", "我是做销售的，常年出差，这次路过{city}多留了一天，明天还得继续跑客户"),
    ("大学生", "我是大学生，刚考完试，想一个人出去走走，预算不多"),
    ("带娃家庭", "我带着六岁的孩子，行李不多但不想把时间全耗在赶车上"),
    ("自由职业者", "我是自由职业者，在{city}待烦了，想换个城市待一两天，电脑随身，上车能办公"),
    ("摄影爱好者", "我是摄影爱好者，想找个出片的地方待一天，拍完就走"),
    ("退休夫妇", "我们老两口退休了，时间充裕，但坐太久车吃不消"),
    ("第一次来", "我第一次来{city}，想顺便再去一个没去过的城市"),
    ("周末逃离", "我在{city}上班，这个周末临时不想宅在家里"),
    ("探亲转途", "我去{city}看朋友，还想顺路再逛一个城市"),
    ("数字游民", "我远程办公，最近住在{city}，想换个城市待一两天"),
]
TIME_SETTINGS = [
    ("now", "现在是{weekday}{hm}，"),
    ("tonight", "今晚{hm}前后我就想出发，"),
    ("tomorrow", "我打算明天白天出发，"),
    ("tomorrow_early", "明天一早我就想走，"),
]
BUDGET_RANGE = ["单程坐{b1}到{b2}个小时的火车都能接受", "车程控制在{b1}到{b2}小时之间吧"]
BUDGET_CAP = ["不想坐超过{b}个小时的车", "最多{b}个小时车程，再久受不了"]
BUDGET_LOOSE = ["大概{b}个小时左右的车程", "{b}个小时上下的样子"]
PREFS = [
    ("gdc", "尽量只坐高铁或动车"),
    ("any", "普速车也无所谓，能到就行"),
    ("direct", "最好全程直达，懒得换乘"),
    ("transfer1", "换一次车可以接受，两次就算了"),
    ("freq", "希望班次多一点，时间上灵活些，错过一趟不至于完蛋"),
    (None, "车次怎么坐都行"),
]
NO_CONSTRAINT = ["别的没什么安排，去哪都行", "之后行程随便，玩完再回来"]
RETURN_CONSTRAINT = [
    ("{day}{time}之前我必须回到{origin}，不能误事",),
    ("我{day}{time}前得赶回{origin}",),
]
ONWARD_CONSTRAINT = [
    ("{day}{time}前我必须到{dest}（那边有安排，不能迟到）",),
    ("{day}{time}前我要出现在{dest}",),
]
DAYS = ["明天", "后天", "周日晚"]
TIMES = ["12:00", "15:00", "17:00", "19:00", "20:00", "21:30"]

WEEKDAY = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def load_cities():
    with open(NET, encoding="utf-8") as f:
        d = json.load(f)
    agg = {}
    for s in d["stations"]:
        c = agg.setdefault(s["c"], 0)
        agg[s["c"]] = c + s["d"]
    # 取班次最多的 160 个城市作为出发地池（保证服务频率不至于太荒）
    top = sorted(agg.items(), key=lambda x: -x[1])[:160]
    # 大城市（后续行程目的地池，去掉边远小城）
    big = [c for c, deg in top[:60] if deg >= 200]
    return [c for c, _ in top], big


def hm_now(rng):
    # "现在"必须取真实时钟(取整到5分钟), 否则任务书时刻与页面时钟矛盾
    now = datetime.datetime.now()
    m = (now.minute // 5) * 5
    return f"{now.hour:02d}:{m:02d}"


def budget_sentence(rng):
    kind = rng.random()
    if kind < 0.4:
        b1 = rng.choice([1, 1, 2, 2, 3])
        b2 = b1 + rng.choice([1, 1, 2, 3])
        return rng.choice(BUDGET_RANGE).format(b1=b1, b2=b2), (b1, b2)
    if kind < 0.8:
        b = rng.choice([2, 3, 3, 4, 4, 5, 6])
        return rng.choice(BUDGET_CAP).format(b=b), (None, b)
    b = rng.choice([2, 3, 3, 4, 5])
    return rng.choice(BUDGET_LOOSE).format(b=b), (b - 1, b)


def gen(round_id):
    rng = random.Random(f"rail-radius-r{round_id}-{datetime.date.today().isoformat()}")
    cities, big = load_cities()
    origin = rng.choice(cities[:40]) if rng.random() < 0.7 else rng.choice(cities)
    ident_key, ident = rng.choice(IDENTITIES)
    t_key, t_tpl = rng.choice(TIME_SETTINGS)
    weekday = WEEKDAY[datetime.date.today().weekday()]
    time_part = hm_now(rng) if t_key == "now" else (f"{rng.randint(18,21):02d}:{rng.choice(['00','30'])}" if t_key == "tonight" else "")
    time_sent = t_tpl.format(weekday=weekday, hm=time_part)
    budget_sent, (bmin, bmax) = budget_sentence(rng)
    pref_key, pref_sent = rng.choice(PREFS)

    # 约束: 45% 无约束, 25% 返程, 30% 后续城市
    cr = rng.random()
    con_type, con_sent = "none", rng.choice(NO_CONSTRAINT)
    con_dest, con_day, con_time = None, None, None
    if cr < 0.45 + 0.25:
        con_type = "return"
        tpl = rng.choice(RETURN_CONSTRAINT)[0]
        con_day, con_time = rng.choice(DAYS), rng.choice(TIMES)
        con_sent = tpl.format(day=con_day, time=con_time, origin=origin)
    else:
        con_type = "onward"
        dests = [c for c in big if c != origin]
        con_dest = rng.choice(dests)
        tpl = rng.choice(ONWARD_CONSTRAINT)[0]
        con_day, con_time = rng.choice(DAYS), rng.choice(TIMES)
        con_sent = tpl.format(day=con_day, time=con_time, dest=con_dest)

    question = (
        f"{ident.format(city=origin)}。{time_sent}{budget_sent}，{pref_sent}。{con_sent}。"
        "帮我看看有哪些现实可行的选择？"
    )

    task = f"""# 验收任务书（round-{round_id}）

你是一位真实用户，正在做一次真实的临时出行决策。请只通过下面这个网页产品完成任务。

## 你的真实需求（这就是全部背景，没有其他隐藏信息）

「{question}」

产品地址：http://127.0.0.1:8787 （服务已在运行）

## 浏览器操作方式（工具说明，与产品无关）

工作目录：~/railway-map

常驻浏览器已启动，用下面的命令驱动（每次 run 都在同一浏览器会话里，页面状态保留）：

node browse.js run '<JSON动作数组>'

动作：
- {{"op":"goto","arg":"http://127.0.0.1:8787/"}}
- {{"op":"wait","arg":2000}}                     等待毫秒
- {{"op":"click","arg":"#css选择器"}}
- {{"op":"clickText","arg":"可见文字"}}
- {{"op":"type","arg":"#输入框||文字"}}
- {{"op":"fill","arg":"#输入框||文字"}}
- {{"op":"select","arg":"#下拉框||值"}}
- {{"op":"check","arg":"#复选框"}}
- {{"op":"read","arg":"#元素"}}                   读文本
- {{"op":"rows","arg":"行选择器"}}                读多行
- {{"op":"eval","arg":"JS表达式"}}                读页面状态（只读，不许改）
- {{"op":"shot","arg":"图.png"}}                  截图到 shots/
- {{"op":"note","arg":"备注"}}

## 规则

1. 只通过产品界面完成任务：禁止调用产品 HTTP API（/api/...）、禁止阅读或修改产品源代码、禁止重启服务、禁止修改任何文件。
2. 怎么用产品完全由你决定——像真人一样探索。如果一种操作方式不行，换你自己的另一种方式。
3. 你的目标是做出自己的出行决策，不是穷举产品功能。

## 交付报告（中文）

1. 你的出行决策：去哪（1–3 个候选 + 取舍理由）？具体怎么走（车次、时刻、换乘）？约束（如果有）怎么满足？
2. 你怎么用产品得出的结论：操作路径 + 哪些信息起了决定性作用。
3. 产品问题全量清单：任何困惑、要猜的地方、缺失的信息、错误或矛盾的数据、多余的负担——全部列出，不要省略。
4. 结论：以你的需求衡量，产品是否可用（可用/勉强可用/不可用）。
"""
    os.makedirs(ROUNDS, exist_ok=True)
    out = os.path.join(ROUNDS, f"round-{round_id}.md")
    with open(out, "w", encoding="utf-8") as f:
        f.write(task)
    key = {
        "round": round_id, "identity": ident_key, "origin": origin,
        "time_setting": t_key, "budget": [bmin, bmax], "pref": pref_key,
        "constraint": {"type": con_type, "dest": con_dest, "day": con_day, "time": con_time},
        "question": question,
    }
    key_path = os.path.join(ROUNDS, f"round-{round_id}-key.json")
    with open(key_path, "w", encoding="utf-8") as f:
        json.dump(key, f, ensure_ascii=False, indent=1)
    print(f"[round-{round_id}] 任务书 -> {out}")
    print("GRADER KEY (勿给 subagent):")
    print(json.dumps(key, ensure_ascii=False, indent=1))
    return key


if __name__ == "__main__":
    existing = [f for f in os.listdir(ROUNDS) if f.startswith("round-") and f.endswith("-key.json")] if os.path.isdir(ROUNDS) else []
    nums = [int(f.split("-")[1].split("-")[0]) for f in existing]
    rid = (max(nums) + 1) if nums else 1
    if len(sys.argv) > 1:
        rid = int(sys.argv[1])
    gen(rid)
