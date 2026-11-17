# Role: 按省级边界判断站点省份；不使用最近城市猜测。
# 契约 docs/specs/delivery.md；边界来源见 data/geography/README.md。
import json
from pathlib import Path


def inside_ring(lon, lat, ring):
    inside = False
    prev = ring[-1]
    for point in ring:
        x, y = point[:2]; px, py = prev[:2]
        if (y > lat) != (py > lat) and lon < (px - x) * (lat - y) / (py - y) + x:
            inside = not inside
        prev = point
    return inside


def load_provinces():
    data = json.loads((Path(__file__).resolve().parents[1] / 'data/geography/china.geojson').read_text())
    polygons = []
    for feature in data['features']:
        geometry = feature['geometry']
        parts = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
        for rings in parts:
            xs = [p[0] for p in rings[0]]; ys = [p[1] for p in rings[0]]
            polygons.append((feature['properties']['name_simplified_chinese'],
                             (min(xs), min(ys), max(xs), max(ys)), rings))
    return polygons


POLYGONS = load_provinces()


def province_at(lat, lon):
    for name, (left, bottom, right, top), rings in POLYGONS:
        if left <= lon <= right and bottom <= lat <= top and inside_ring(lon, lat, rings[0]):
            if not any(inside_ring(lon, lat, hole) for hole in rings[1:]):
                return name
    return None
