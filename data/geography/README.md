# 省级边界

`china.geojson` 来自 Code for Germany 的 click_that_hood 数据集，2026-11-17获取：
https://github.com/codeforgermany/click_that_hood/blob/main/public/data/china.geojson

上游元数据注明原始来源：https://github.com/okkervil/chinamaps 。保留上游仓库MIT许可
见LICENSE。坐标按GeoJSON经纬度使用；仅用于车站省份归属，地图边界绘制不依赖它。
省级边界可能存在精度误差；无法落入边界的站点使用已知城市明确映射，否则显示待核对。
禁止回退到最近城市，以免省界附近或错误城市归并污染其他站点。
