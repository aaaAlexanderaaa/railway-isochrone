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

# 候选失败、替换失败与旧输入隔离：验证持久结果而非函数调用次数。
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import json
import zipfile
import subprocess
import update_dataset as updater

class UpdateSafety(unittest.TestCase):
    def test_province_boundaries(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from lib.provinces import province_at
        self.assertEqual(province_at(30.30972, 107.37373), '重庆')
        self.assertEqual(province_at(22.99743, 113.74045), '广东')

    def test_archive_age_and_actual_previous(self):
        versions = [dict(v('gtfs-20260601-000000'), builtAt='2026-09-19T00:00:00Z'),
                    v('gtfs-20260701-000000'), v('gtfs-20260501-000000')]
        doomed = versions_to_delete(versions, datetime(2026,9,20),
                                    previous_id='gtfs-20260501-000000')
        self.assertEqual(doomed, ['gtfs-20260701-000000'])

    def test_zip_only_extracts_expected_files(self):
        with tempfile.TemporaryDirectory() as temp:
            z = Path(temp)/'feed.zip'; dest=Path(temp)/'gtfs'
            with zipfile.ZipFile(z,'w') as f:
                for n in ['routes.txt','stops.txt','stop_times.txt','trips.txt']:
                    f.writestr('feed/'+n,'header\n')
                f.writestr('../escape','bad')
            updater.extract_gtfs(str(z),str(dest))
            self.assertEqual(len(list(dest.iterdir())),4)
            self.assertFalse((Path(temp)/'escape').exists())
            self.assertFalse((dest/'calendar_dates.txt').exists())

    def test_failed_validation_leaves_all_live_files_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); live=root/'public'/'data'; live.mkdir(parents=True)
            raw=root/'data'/'gtfs'; raw.mkdir(parents=True)
            (raw/'stops.txt').write_text('old raw')
            (root/'data'/'RELEASE').write_text('old release')
            (live/'net.json').write_text('old net')
            (live/'manifest.json').write_text(json.dumps({'current':'gtfs-20261004-052300','versions':[]}))
            before={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            release={'tag':'gtfs-20261116-085531','size':0,'zip_url':'https://example.invalid/feed.zip','published':''}
            with patch.multiple(updater, ROOT=str(root),PUB_DATA=str(live),NET_JSON=str(live/'net.json'),
                                MANIFEST=str(live/'manifest.json'),GTFS_DIR=str(raw),RELEASE_FILE=str(root/'data'/'RELEASE')):
                with patch.object(updater,'fetch_release',return_value=release), patch.object(updater,'download'), \
                     patch.object(updater,'extract_gtfs'), patch.object(updater,'run_etl'), \
                     patch.object(updater,'validate_candidate',side_effect=ValueError('invalid candidate')), \
                     patch.object(sys,'argv',['update','--skip-submodule']):
                    with self.assertRaisesRegex(ValueError,'invalid candidate'): updater.main()
            after={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            self.assertEqual(before,after)

    def test_partial_promotion_rolls_back(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp); live=root/'live'; live.mkdir(); (live/'net').write_text('old')
            raw=root/'raw'; raw.mkdir(); (raw/'stops').write_text('old')
            release=root/'release';release.write_text('old')
            staged=root/'staged';staged.mkdir(); (staged/'net').write_text('new')
            newraw=root/'newraw';newraw.mkdir(); (newraw/'stops').write_text('new')
            tmp=root/'tmp';tmp.mkdir(); replace=os.replace
            def failing(src,dst):
                if str(src)==str(staged): raise OSError('disk failure')
                return replace(src,dst)
            with patch.multiple(updater,PUB_DATA=str(live),GTFS_DIR=str(raw),RELEASE_FILE=str(release)), \
                 patch.object(updater.os,'replace',side_effect=failing):
                with self.assertRaises(OSError): updater.promote(str(staged),str(newraw),'gtfs-20261116-085531',str(tmp))
            self.assertEqual((live/'net').read_text(),'old');self.assertEqual((raw/'stops').read_text(),'old')
            self.assertEqual(release.read_text(),'old')

    def test_etl_aliases_and_filtered_trip_names_stay_aligned(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'stops.txt').write_text('stop_id,stop_name,stop_lat,stop_lon\nA,甲,30,110\nA2,甲,30,110\nB,乙,30.1,110\nC,丙,40,120\nX,西平西,22.99743,113.74045\n')
            (root/'trips.txt').write_text('trip_id,trip_short_name\nbad,G1\ngood,K2\nbadtime,K3\n')
            (root/'stop_times.txt').write_text('trip_id,stop_sequence,stop_id,arrival_time,departure_time\nbad,1,A,08:00:00,08:00:00\nbad,2,C,08:01:00,08:01:00\ngood,1,A2,09:00:00,09:00:00\ngood,2,B,10:00:00,00:00:00\nbadtime,1,A,08:00:00,08:00:00\nbadtime,2,B,09:00:00,08:59:00\nbadtime,3,C,12:00:00,12:00:00\n')
            subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/'etl.py'),str(root),str(root/'net.json')],
                           check=True,stdout=subprocess.DEVNULL,env={**os.environ,'GTFS_RELEASE':'gtfs-20261116-085531'})
            data=json.loads((root/'net.json').read_text())
            self.assertEqual(data['meta']['quality']['invalidTimeDropped'],1)
            self.assertEqual(data['arr'][-1],data['dep'][-1])
            self.assertEqual(data['names'],['K2']); self.assertEqual(data['cls'],['K'])
            self.assertEqual(data['stations'][3]['c'],'东莞')
            self.assertEqual(data['stations'][3]['p'],'广东')
            self.assertEqual(data['stops'],[0,1]); self.assertEqual(data['meta']['quality']['mergedStops'],1)

if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]])
