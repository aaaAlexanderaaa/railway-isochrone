#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""归档滚动不变量：满月才删，且始终留上一份。"""
from datetime import datetime
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from update_dataset import versions_to_delete, tag_date, RETENTION_DAYS


def v(tag):
    return {"id": tag, "date": tag_date(tag).strftime("%Y-%m-%d")}


def main():
    now = datetime(2026, 9, 20)
    versions = [
        v("gtfs-20260920-041346"),
        v("gtfs-20260913-040340"),
        v("gtfs-20260906-034836"),
        v("gtfs-20260830-043806"),
        v("gtfs-20260823-013921"),
        v("gtfs-20260801-000000"),  # 50 天前
        v("gtfs-20260701-000000"),  # 81 天前
    ]
    current = "gtfs-20260920-041346"
    doomed = versions_to_delete(versions, now, RETENTION_DAYS, current_id=current, keep_previous=True)
    # 31 天 cutoff = 2026-08-20。08-23 仍在窗口内；08-01 与 07-01 过期。
    # 上一份 09-13 即使过期也会留 —— 这里它未过期。
    assert "gtfs-20260801-000000" in doomed, doomed
    assert "gtfs-20260701-000000" in doomed, doomed
    assert "gtfs-20260823-013921" not in doomed, doomed
    assert "gtfs-20260913-040340" not in doomed, doomed
    assert "gtfs-20260920-041346" not in doomed, doomed  # current 已从候选去掉

    # 只有很老的上一份时：仍保留 previous，只删更早的
    old = [v("gtfs-20260601-000000"), v("gtfs-20260501-000000")]
    doomed2 = versions_to_delete(old, now, RETENTION_DAYS, current_id="gtfs-20260920-x", keep_previous=True)
    assert doomed2 == ["gtfs-20260501-000000"], doomed2

    # 窗口内全部保留
    fresh = [v("gtfs-20260913-040340"), v("gtfs-20260906-034836")]
    doomed3 = versions_to_delete(fresh, now, RETENTION_DAYS, current_id="gtfs-20260920-x")
    assert doomed3 == [], doomed3

    print("ok rotate invariants, retentionDays=", RETENTION_DAYS)


if __name__ == "__main__":
    main()
