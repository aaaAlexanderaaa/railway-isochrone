# -*- coding: utf-8 -*-
"""
Role: GTFS -> 紧凑路网 JSON；拥有过滤和索引对齐，契约 docs/specs/delivery.md。

用法: python etl.py [gtfs_dir] [out_json]
"""
import csv, json, os, re, sys
from collections import defaultdict
from lib.provinces import province_at

GTFS_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join("data", "gtfs")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join("public", "data", "net.json")

def hhmmss_to_min(s):
    h, m, sec = s.split(":")
    return int(h) * 60 + int(m)  # 秒级忽略（数据里基本为 00）

def haversine_km(la1, lo1, la2, lo2):
    import math
    r = 6371.0
    p1, p2 = math.radians(la1), math.radians(la2)
    dp = p2 - p1
    dl = math.radians(lo2 - lo1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))

# 物理速度守卫：相邻停站直线速度超过该值（km/h）即认为该车次时刻/停站数据损坏，
# 整趟丢弃。2026-09-24 round-26 验收发现 Y481/Y484（沈阳北 07:59→邯郸 09:45，
# 750km/106min）等旅游列车上游数据损坏，把物理不可能的"1h46 直达"灌进可达圈。
MAX_SEG_KMH = 400.0

# ---------- stops ----------
stations = []           # [name, lat, lon]
sid2idx = {}
station_by_name = {}
merged_stops = 0
with open(os.path.join(GTFS_DIR, "stops.txt"), encoding="utf-8") as f:
    for row in csv.DictReader(f):
        name, lat, lon = row["stop_name"], float(row["stop_lat"]), float(row["stop_lon"])
        if name in station_by_name:
            idx = station_by_name[name]
            old = stations[idx]
            if haversine_km(lat, lon, old[1], old[2]) > 0.5:
                raise ValueError(f"同名异地车站需人工核对: {name}")
            sid2idx[row["stop_id"]] = idx
            merged_stops += 1
            continue
        sid2idx[row["stop_id"]] = len(stations)
        station_by_name[name] = len(stations)
        stations.append([name, lat, lon])
print(f"stops: {len(stations)}, merged aliases: {merged_stops}")

# ---------- trips ----------
trip_names = []         # 车次号
trip_class = []         # 首字母类别
with open(os.path.join(GTFS_DIR, "trips.txt"), encoding="utf-8") as f:
    for row in csv.DictReader(f):
        if "DUMMY" in row["trip_id"]:
            continue
        raw = row["trip_short_name"].strip()
        # 形如 "09/S8512" 的日期前缀（极少量的市域车），展示名去掉前缀
        m = re.match(r"^\d+/(\w+)$", raw)
        name = m.group(1) if m else raw
        trip_names.append(name)
        c = name[0].upper() if name else "?"
        trip_class.append(c if c.isalpha() else "O")
print(f"trips: {len(trip_names)}")

# ---------- stop_times ----------
# 逐 trip 聚合（文件按 trip 连续存放，但用 dict 兜底）
per_trip = defaultdict(list)
with open(os.path.join(GTFS_DIR, "stop_times.txt"), encoding="utf-8") as f:
    for row in csv.DictReader(f):
        tid = row["trip_id"]
        if "DUMMY" in tid:
            continue
        try:
            dist = float(row.get("shape_dist_traveled") or 0)
        except ValueError:
            dist = 0.0
        per_trip[tid].append((
            int(row["stop_sequence"]),
            sid2idx[row["stop_id"]],
            hhmmss_to_min(row["arrival_time"]),
            hhmmss_to_min(row["departure_time"]),
            dist,
        ))

off = [0]
t_stops, t_dep, t_arr, t_dist = [], [], [], []
degree = [0] * len(stations)
monotonic_violations = 0
invalid_time_dropped = 0
terminal_times_normalized = 0
kept_names, kept_classes = [], []
missing_trips = 0
speed_trips_dropped = []   # (车次, 前站, 后站, km, dt分钟)
dropped_trip_ids = set()
# 用 trip_id 关联停站；只有实际保留的车次才进入全部并行数组。
trip_ids = []
with open(os.path.join(GTFS_DIR, "trips.txt"), encoding="utf-8") as f:
    for row in csv.DictReader(f):
        if "DUMMY" in row["trip_id"]:
            continue
        trip_ids.append(row["trip_id"])
assert len(trip_ids) == len(trip_names)

for i, tid in enumerate(trip_ids):
    rows = sorted(per_trip.get(tid, []))
    if len(rows) < 2:
        missing_trips += 1
        continue
    # 终点不允许上车，出发字段统一不早于到达。中途时刻逆序不能猜，整趟剔除。
    if rows[-1][3] < rows[-1][2]:
        r = rows[-1]
        rows[-1] = (r[0], r[1], r[2], r[2], r[4])
        terminal_times_normalized += 1
    violations = sum(r[3] < r[2] or (k > 0 and r[2] < rows[k - 1][3])
                     for k, r in enumerate(rows))
    if violations:
        invalid_time_dropped += 1
        monotonic_violations += violations
        continue
    # 物理速度守卫：任一相邻段超速 -> 整趟丢弃（数据损坏，宁可少一班不可错一班）
    bad_speed = False
    for k in range(1, len(rows)):
        a_name, a_la, a_lo = stations[rows[k - 1][1]]
        b_name, b_la, b_lo = stations[rows[k][1]]
        dt = rows[k][2] - rows[k - 1][3]  # 本站到达 - 前站出发
        if dt <= 0:
            continue  # 同站/零间隔交给单调性统计，不在此误杀
        km = haversine_km(a_la, a_lo, b_la, b_lo)
        if km / (dt / 60.0) > MAX_SEG_KMH:
            speed_trips_dropped.append((trip_names[i], a_name, b_name, round(km, 1), dt))
            bad_speed = True
            break
    if bad_speed:
        dropped_trip_ids.add(tid)
        continue
    seq = [r[1] for r in rows]
    deps = [r[3] for r in rows]
    arrs = [r[2] for r in rows]
    # 里程: 逐段累计(数据本身基本为累计值, 兜底重算)
    cum = 0.0
    dists = []
    prev = 0.0
    for r in rows:
        d = r[4]
        if d < prev:  # 非累计数据 -> 按段累加
            cum += max(d, 0)
        else:
            cum = d
        prev = d
        dists.append(round(cum, 1))
    for k in range(len(rows)):
        if k > 0 and (arrs[k] < deps[k - 1] or deps[k] < arrs[k]):
            monotonic_violations += 1
    t_stops.extend(seq); t_dep.extend(deps); t_arr.extend(arrs); t_dist.extend(dists)
    off.append(len(t_stops))
    kept_names.append(trip_names[i]); kept_classes.append(trip_class[i])
    for s in set(seq):
        degree[s] += 1

trip_names, trip_class = kept_names, kept_classes
print(f"invalid-time dropped: {invalid_time_dropped}, terminal departures normalized: {terminal_times_normalized}")
print(f"real trips with stop_times: {len(off)-1}, stop_times rows: {len(t_stops)}, monotonic violations: {monotonic_violations}, missing trips: {missing_trips}")
if speed_trips_dropped:
    print(f"speed-guard dropped {len(speed_trips_dropped)} trips (> {MAX_SEG_KMH}km/h):")
    for t in speed_trips_dropped[:10]:
        print(f"  {t[0]}: {t[1]} -> {t[2]} {t[3]}km/{t[4]}min")
    if len(speed_trips_dropped) > 10:
        print(f"  … 共 {len(speed_trips_dropped)} 趟")

# ---------- 城市分组 ----------
SUFFIX = ("东", "南", "西", "北")
# 主要枢纽城市手工归并（站名 -> 城市），覆盖清河/汉口/武昌等名称前缀法覆盖不了的情况
OVERRIDES = {
    "北京": "北京", "北京南": "北京", "北京西": "北京", "北京东": "北京", "北京北": "北京",
    "北京朝阳": "北京", "北京丰台": "北京", "清河": "北京", "北京城市副中心": "北京", "通州": "北京",
    "大兴机场": "北京", "顺义西": "北京", "怀柔南": "北京", "密云": "北京",
    "上海": "上海", "上海虹桥": "上海", "上海南": "上海", "上海西": "上海", "莘庄": "上海",
    "上海松江": "上海", "浦东机场": "上海",
    "广州": "广州", "广州南": "广州", "广州东": "广州", "广州白云": "广州", "庆盛": "广州", "新塘": "广州",
    "深圳": "深圳", "深圳北": "深圳", "深圳东": "深圳", "深圳西": "深圳", "福田": "深圳",
    "西丽": "深圳", "深圳坪山": "深圳", "平湖": "深圳", "机场北": "深圳", "沙井西": "深圳",
    "武汉": "武汉", "汉口": "武汉", "武昌": "武汉", "武汉东": "武汉", "武汉北": "武汉",
    "天河机场": "武汉", "左岭": "武汉", "乌龙泉南": "武汉",
    "长沙": "长沙", "长沙南": "长沙", "长沙西": "长沙", "尖山": "长沙", "树木岭": "长沙",
    "香樟路": "长沙", "洞井": "长沙", "长沙东": "长沙", "榔梨": "长沙",
    "成都东": "成都", "成都南": "成都", "成都西": "成都", "成都": "成都", "犀浦": "成都",
    "天府机场": "成都", "双流机场": "成都", "双流西": "成都", "成都天府": "成都", "迎宾路": "成都",
    "重庆北": "重庆", "重庆西": "重庆", "重庆沙坪坝": "重庆", "重庆": "重庆", "重庆东": "重庆",
    "江北机场": "重庆", "复盛": "重庆", "巴南": "重庆", "珞璜南": "重庆", "璧山": "重庆",
    "重庆南": "重庆", "石子山": "重庆", "赖家桥": "重庆", "黄茅坪": "重庆", "万盛": "重庆", "南川北": "重庆", "綦江东": "重庆", "赶水东": "重庆",
    "杭州东": "杭州", "杭州南": "杭州", "杭州西": "杭州", "杭州": "杭州", "余杭": "杭州",
    "南京南": "南京", "南京": "南京", "江宁": "南京", "南京东": "南京", "南京北": "南京", "溧水": "南京", "六合南": "南京",
    "西安北": "西安", "西安": "西安", "西安南": "西安", "西安东": "西安", "鄠邑": "西安",
    "咸阳西": "西安", "咸阳": "西安", "机场西": "西安", "阿房宫": "西安",
    "郑州": "郑州", "郑州东": "郑州", "郑州南": "郑州", "郑州航空港": "郑州",
    "天津": "天津", "天津西": "天津", "天津南": "天津", "天津北": "天津", "滨海": "天津", "滨海西": "天津", "军粮城北": "天津",
    "滨海东": "天津", "塘沽": "天津",
    "合肥": "合肥", "合肥南": "合肥", "合肥北": "合肥", "巢北": "合肥",
    "南昌": "南昌", "南昌西": "南昌", "南昌东": "南昌",
    "福州": "福州", "福州南": "福州", "长乐东": "福州", "长乐": "福州",
    "厦门": "厦门", "厦门北": "厦门", "厦门东": "厦门", "高崎": "厦门",
    "昆明": "昆明", "昆明南": "昆明", "昆明西": "昆明", "长水机场": "昆明",
    "贵阳": "贵阳", "贵阳北": "贵阳", "贵阳东": "贵阳", "双龙": "贵阳", "龙洞堡": "贵阳",
    "南宁": "南宁", "南宁东": "南宁", "南宁北": "南宁", "吴圩机场": "南宁",
    "石家庄": "石家庄", "石家庄东": "石家庄", "正定机场": "石家庄",
    "济南": "济南", "济南东": "济南", "济南西": "济南", "历城": "济南",
    "青岛": "青岛", "青岛北": "青岛", "红岛": "青岛", "青岛机场": "青岛",
    "沈阳": "沈阳", "沈阳南": "沈阳", "沈阳北": "沈阳", "沈阳西": "沈阳", "桃仙机场": "沈阳",
    "哈尔滨": "哈尔滨", "哈尔滨西": "哈尔滨", "哈尔滨北": "哈尔滨", "哈尔滨东": "哈尔滨", "太平桥": "哈尔滨",
    "长春": "长春", "长春西": "长春", "长春北": "长春", "龙嘉机场": "长春",
    "大连": "大连", "大连北": "大连", "金州": "大连", "周水子机场": "大连",
    "苏州": "苏州", "苏州北": "苏州", "苏州园区": "苏州", "苏州新区": "苏州", "阳澄湖": "苏州",
    "无锡": "无锡", "无锡东": "无锡", "无锡新区": "无锡", "惠山": "无锡",
    "常州": "常州", "常州北": "常州", "戚墅堰": "常州",
    "镇江": "镇江", "镇江南": "镇江", "丹徒": "镇江",
    "徐州": "徐州", "徐州东": "徐州",
    "洛阳": "洛阳", "洛阳龙门": "洛阳",
    "兰州": "兰州", "兰州西": "兰州", "兰州东": "兰州", "中川机场": "兰州", "福利区": "兰州", "陈官营": "兰州",
    "乌鲁木齐": "乌鲁木齐", "乌鲁木齐南": "乌鲁木齐",
    "呼和浩特": "呼和浩特",
    "太原": "太原", "太原南": "太原", "太原东": "太原",
    "宁波": "宁波", "宁波东": "宁波", "庄桥": "宁波",
    "温州": "温州", "温州南": "温州", "温州北": "温州", "瑞安": "温州", "苍南": "温州",
    "汕头": "汕头", "汕头南": "汕头", "潮阳": "汕头",
    "佛山": "佛山", "佛山西": "佛山",
    "东莞": "东莞", "虎门": "东莞",
    "绍兴": "绍兴", "绍兴北": "绍兴", "绍兴东": "绍兴",
    "嘉兴": "嘉兴", "嘉兴南": "嘉兴",
    "芜湖": "芜湖",
    "蚌埠": "蚌埠",
    "襄阳": "襄阳",
    "宜昌": "宜昌",
    "柳州": "柳州",
    "桂林": "桂林", "桂林北": "桂林",
    "岳阳": "岳阳",
    "衡阳": "衡阳",
    "株洲": "株洲",
    "湘潭": "湘潭",
    "九江": "九江",
    "赣州": "赣州",
    "珠海": "珠海", "珠海机场": "珠海",
    "惠州": "惠州", "惠州北": "惠州", "惠州南": "惠州",
    "中山西": "中山", "中山北": "中山",
    "遵义": "遵义", "遵义南": "遵义",
    "银川": "银川", "河东机场": "银川",
    "西宁": "西宁", "海东西": "西宁",
    "拉萨": "拉萨", "拉萨南": "拉萨",
    "贵阳": "贵阳",
    "海口": "海口", "海口东": "海口", "美兰机场": "海口",
    "三亚": "三亚", "亚龙湾": "三亚", "崖州": "三亚",
}


# 站名后缀不是行政区划：西平西属于东莞，不能归并河南西平并污染省份锚点。
OVERRIDES.update({
    "西平西": "东莞", "常平": "东莞", "常平东": "东莞", "常平南": "东莞",
    "麻涌": "东莞", "东莞西": "东莞", "东莞": "东莞", "东莞东": "东莞",
    "广州新塘": "广州", "广州大学城": "广州", "广州长隆": "广州", "琶洲": "广州",
    "番禺": "广州", "增城": "广州", "增城南": "广州", "南沙北": "广州", "南沙": "广州",
    "怀集": "肇庆", "郁南": "云浮",
    "横琴": "珠海", "三灶东": "珠海", "珠海长隆": "珠海", "深圳机场": "深圳",
    "陆丰南": "汕尾", "罗源": "福州", "平潭": "福州", "牟平": "烟台",
    "曹妃甸港": "唐山", "玉环": "台州",
})

# ---------- 站点省份（边界优先，明确城市映射兜底） ----------
CITY_PROV = {
    "哈尔滨": "黑龙江", "齐齐哈尔": "黑龙江", "大庆": "黑龙江", "牡丹江": "黑龙江", "佳木斯": "黑龙江",
    "长春": "吉林", "吉林": "吉林", "四平": "吉林", "延吉": "吉林", "通化": "吉林",
    "沈阳": "辽宁", "大连": "辽宁", "鞍山": "辽宁", "锦州": "辽宁", "丹东": "辽宁",
    "呼和浩特": "内蒙古", "包头": "内蒙古", "赤峰": "内蒙古", "通辽": "内蒙古", "呼伦贝尔": "内蒙古", "乌兰察布": "内蒙古",
    "石家庄": "河北", "唐山": "河北", "保定": "河北", "邯郸": "河北", "秦皇岛": "河北", "沧州": "河北", "张家口": "河北", "承德": "河北",
    "太原": "山西", "大同": "山西", "临汾": "山西", "运城": "山西", "晋中": "山西", "长治": "山西", "吕梁": "山西", "忻州": "山西",
    "济南": "山东", "青岛": "山东", "烟台": "山东", "潍坊": "山东", "临沂": "山东", "济宁": "山东", "淄博": "山东", "泰安": "山东", "威海": "山东", "德州": "山东", "菏泽": "山东",
    "郑州": "河南", "洛阳": "河南", "开封": "河南", "新乡": "河南", "安阳": "河南", "南阳": "河南", "信阳": "河南", "商丘": "河南", "焦作": "河南", "许昌": "河南", "周口": "河南", "驻马店": "河南", "三门峡": "河南",
    "南京": "江苏", "苏州": "江苏", "无锡": "江苏", "常州": "江苏", "镇江": "江苏", "南通": "江苏", "扬州": "江苏", "徐州": "江苏", "盐城": "江苏", "泰州": "江苏", "淮安": "江苏", "连云港": "江苏",
    "合肥": "安徽", "芜湖": "安徽", "蚌埠": "安徽", "安庆": "安徽", "阜阳": "安徽", "马鞍山": "安徽", "滁州": "安徽", "宿州": "安徽", "六安": "安徽", "亳州": "安徽", "池州": "安徽", "宣城": "安徽", "黄山": "安徽",
    "杭州": "浙江", "宁波": "浙江", "温州": "浙江", "嘉兴": "浙江", "湖州": "浙江", "绍兴": "浙江", "金华": "浙江", "衢州": "浙江", "台州": "浙江", "丽水": "浙江",
    "南昌": "江西", "九江": "江西", "赣州": "江西", "上饶": "江西", "宜春": "江西", "吉安": "江西", "抚州": "江西", "景德镇": "江西", "萍乡": "江西",
    "福州": "福建", "厦门": "福建", "泉州": "福建", "莆田": "福建", "漳州": "福建", "龙岩": "福建", "三明": "福建", "南平": "福建",
    "武汉": "湖北", "宜昌": "湖北", "襄阳": "湖北", "荆州": "湖北", "黄石": "湖北", "十堰": "湖北", "荆门": "湖北", "咸宁": "湖北", "鄂州": "湖北", "恩施": "湖北", "黄冈": "湖北",
    "长沙": "湖南", "株洲": "湖南", "湘潭": "湖南", "衡阳": "湖南", "岳阳": "湖南", "常德": "湖南", "张家界": "湖南", "益阳": "湖南", "郴州": "湖南", "永州": "湖南", "怀化": "湖南", "娄底": "湖南", "邵阳": "湖南",
    "广州": "广东", "深圳": "广东", "珠海": "广东", "汕头": "广东", "佛山": "广东", "韶关": "广东", "湛江": "广东", "肇庆": "广东", "江门": "广东", "茂名": "广东", "惠州": "广东", "梅州": "广东", "河源": "广东", "阳江": "广东", "清远": "广东", "东莞": "广东", "潮州": "广东", "揭阳": "广东", "云浮": "广东",
    "南宁": "广西", "柳州": "广西", "桂林": "广西", "梧州": "广西", "北海": "广西", "玉林": "广西", "百色": "广西", "贺州": "广西", "河池": "广西", "来宾": "广西", "崇左": "广西", "钦州": "广西", "贵港": "广西",
    "海口": "海南", "三亚": "海南", "儋州": "海南", "东方": "海南",
    "成都": "四川", "绵阳": "四川", "德阳": "四川", "宜宾": "四川", "南充": "四川", "达州": "四川", "乐山": "四川", "泸州": "四川", "自贡": "四川", "内江": "四川", "眉山": "四川", "广元": "四川", "遂宁": "四川", "资阳": "四川", "攀枝花": "四川", "雅安": "四川", "西昌": "四川",
    "贵阳": "贵州", "遵义": "贵州", "六盘水": "贵州", "安顺": "贵州", "毕节": "贵州", "铜仁": "贵州", "凯里": "贵州", "都匀": "贵州", "兴义": "贵州",
    "昆明": "云南", "曲靖": "云南", "大理": "云南", "丽江": "云南", "蒙自": "云南", "玉溪": "云南", "楚雄": "云南", "昭通": "云南", "保山": "云南", "普洱": "云南", "文山": "云南", "景洪": "云南",
    "拉萨": "西藏", "日喀则": "西藏", "林芝": "西藏", "那曲": "西藏", "昌都": "西藏",
    "西安": "陕西", "宝鸡": "陕西", "咸阳": "陕西", "渭南": "陕西", "汉中": "陕西", "安康": "陕西", "延安": "陕西", "榆林": "陕西",
    "兰州": "甘肃", "天水": "甘肃", "白银": "甘肃", "张掖": "甘肃", "酒泉": "甘肃", "嘉峪关": "甘肃", "武威": "甘肃", "定西": "甘肃", "陇南": "甘肃", "平凉": "甘肃", "庆阳": "甘肃",
    "西宁": "青海", "德令哈": "青海", "格尔木": "青海",
    "银川": "宁夏", "石嘴山": "宁夏", "吴忠": "宁夏", "固原": "宁夏", "中卫": "宁夏",
    "乌鲁木齐": "新疆", "吐鲁番": "新疆", "哈密": "新疆", "库尔勒": "新疆", "阿克苏": "新疆", "喀什": "新疆", "和田": "新疆", "伊宁": "新疆", "克拉玛依": "新疆", "昌吉": "新疆", "石河子": "新疆", "塔城": "新疆", "阿勒泰": "新疆", "博乐": "新疆", "库车": "新疆",
    "北京": "北京", "天津": "天津", "上海": "上海", "重庆": "重庆",
}

# 行政区划明确的补充映射，仅在省级边界未覆盖坐标时使用。
CITY_PROV.update({
    "东莞": "广东", "肇庆": "广东", "云浮": "广东", "汕尾": "广东",
    "衡水": "河北", "廊坊": "河北", "涿州": "河北", "霸州": "河北",
    "日照": "山东", "枣庄": "山东",
    "孝感": "湖北", "随州": "湖北",
    "阳泉": "山西", "晋城": "山西",
    "醴陵": "湖南", "吉首": "湖南", "凤凰古城": "湖南", "新晃": "湖南",
    "万州": "重庆", "黔江": "重庆", "永川": "重庆",
    "盘州": "贵州",
    "宜兴": "江苏", "太仓": "江苏", "海安": "江苏",
    "白城": "吉林", "扶余": "吉林",
    "山阳": "陕西", "漫川关": "陕西", "宁强": "陕西", "柞水": "陕西", "镇安": "陕西", "丹凤": "陕西", "商南": "陕西", "略阳": "陕西",
    "濮阳": "河南", "西平": "河南",
    "横店": "浙江",
    "香港西九龙": "香港",
})

def city_of(name):
    if name in OVERRIDES:
        return OVERRIDES[name]
    if len(name) >= 3 and name[-1] in SUFFIX:
        return name[:-1]
    return name

cities = []
for name, lat, lon in stations:
    cities.append(city_of(name))

provs = []
for i, (name, lat, lon) in enumerate(stations):
    c = cities[i]
    provs.append(("老挝" if name in {"磨丁", "孟赛", "琅勃拉邦", "万荣", "万象"} else None) or province_at(lat, lon) or CITY_PROV.get(c) or "待核对")
print(f"station regions: {len(provs)}, unmapped: {provs.count('待核对')}")

# ---------- station -> trips 索引 ----------
st_trips = [[] for _ in stations]
for ti in range(len(off) - 1):
    a, b = off[ti], off[ti + 1]
    seen = set()
    for k in range(a, b):
        s = t_stops[k]
        if s not in seen:
            seen.add(s)
            st_trips[s].append(ti)
st_off = [0]
st_flat = []
for lst in st_trips:
    st_flat.extend(lst)
    st_off.append(len(st_flat))

# ---------- 质量校验 ----------
def known_pair(a, b):
    ia = next((i for i, s in enumerate(stations) if s[0] == a), None)
    ib = next((i for i, s in enumerate(stations) if s[0] == b), None)
    if ia is None or ib is None:
        return f"{a}->{b}: 站缺失"
    best = None; cnt = 0
    for ti in range(len(off) - 1):
        seq = t_stops[off[ti]:off[ti + 1]]
        try:
            pa = seq.index(ia); pb = seq.index(ib)
        except ValueError:
            continue
        if pa < pb:
            cnt += 1
            dur = t_arr[off[ti] + pb] - t_dep[off[ti] + pa]
            if best is None or dur < best:
                best = dur
    if best is None:
        return f"{a}->{b}: 无直达"
    return f"{a}->{b}: 最快 {best//60}h{best%60:02d}m, 直达班次 {cnt}"

for pair in [("长沙南", "上海虹桥"), ("北京南", "上海虹" + "桥"), ("广州南", "长沙南"),
             ("北京西", "长沙南"), ("长沙南", "杭州东"), ("长沙南", "贵阳北"),
             ("长沙南", "郑州东"), ("长沙南", "南京南"), ("上海虹桥", "长沙南"),
             ("长沙南", "北京西")]:
    print(known_pair(*pair))

top = sorted(range(len(stations)), key=lambda i: -degree[i])[:60]
print("top stations by degree:")
print(" | ".join(f"{stations[i][0]}({degree[i]})" for i in top))

def detect_release():
    env = (os.environ.get("GTFS_RELEASE") or "").strip()
    if env:
        return env
    for cand in (
        os.path.join(os.path.dirname(os.path.abspath(GTFS_DIR)), "RELEASE"),
        os.path.join(GTFS_DIR, "RELEASE"),
        os.path.join("data", "RELEASE"),
    ):
        if os.path.isfile(cand):
            return open(cand, encoding="utf-8").read().strip() or "unknown"
    return "unknown"

def calendar_label():
    cal = os.path.join(GTFS_DIR, "calendar.txt")
    if not os.path.isfile(cal):
        return "每日开行（周更快照）"
    with open(cal, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return "每日开行（周更快照）"
    start = (rows[0].get("start_date") or "").strip()
    if len(start) == 8 and start.isdigit():
        return f"{start[:4]}-{start[4:6]}-{start[6:]} 起每日开行"
    return "每日开行（周更快照）"

# ---------- 输出 ----------
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
data = {
    "meta": {
        "source": "wensimehrp/chinese-railway-gtfs",
        "release": detect_release(),
        "calendar": calendar_label(),
        "builtAt": __import__("datetime").datetime.now().strftime("%Y-%m-%d"),
        "stations": len(stations),
        "trips": len(off) - 1,
        "quality": {"speedDropped": len(speed_trips_dropped), "missingTrips": missing_trips,
                    "monotonicViolations": monotonic_violations, "mergedStops": merged_stops,
                    "invalidTimeDropped": invalid_time_dropped, "terminalTimesNormalized": terminal_times_normalized,
                    "provinceUnmapped": sum(p == "待核对" for p in provs)},
    },
    "stations": [
        {"n": s[0], "la": round(s[1], 5), "lo": round(s[2], 5),
         "c": cities[i], "d": degree[i], "p": provs[i]}
        for i, s in enumerate(stations)
    ],
    "off": off, "dep": t_dep, "arr": t_arr, "dist": t_dist,
    "stops": t_stops,
    "names": trip_names, "cls": trip_class,
    "stOff": st_off, "stTrips": st_flat,
}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
print(f"wrote {OUT} ({os.path.getsize(OUT):,} bytes)")
