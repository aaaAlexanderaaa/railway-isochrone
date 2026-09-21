#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从上游 chinese-railway-gtfs 拉取最新 GTFS，重建 net.json，并按月滚动归档。

上游 git 仓库（本项目 submodule: vendor/chinese-railway-gtfs）本身不含时刻表，
GTFS 发布在 GitHub Releases 的 output_gtfs.zip。本脚本：

1. 可选更新 submodule 指针（跟踪上游仓库）
2. 下载最新（或指定）Release zip
3. 解压到 data/gtfs/ 并运行 etl.py
4. 当前 net.json 写入 public/data/net.json
5. 每个 release 在 public/data/archive/<tag>/ 留一份完整快照
6. 滚动删除：保留「至少一个月」(默认 31 天) 内的归档，并且始终保留上一份
   以便回滚。满 31 天之后的更早版本才会删。

用法:
  python3 scripts/update_dataset.py              # 拉 latest
  python3 scripts/update_dataset.py --tag gtfs-20260913-040340
  python3 scripts/update_dataset.py --rotate-only
  python3 scripts/update_dataset.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUB_DATA = os.path.join(ROOT, "public", "data")
ARCHIVE = os.path.join(PUB_DATA, "archive")
NET_JSON = os.path.join(PUB_DATA, "net.json")
MANIFEST = os.path.join(PUB_DATA, "manifest.json")
GTFS_DIR = os.path.join(ROOT, "data", "gtfs")
RELEASE_FILE = os.path.join(ROOT, "data", "RELEASE")
UPSTREAM_REPO = "wensimehrp/chinese-railway-gtfs"
SUBMODULE = os.path.join(ROOT, "vendor", "chinese-railway-gtfs")
RETENTION_DAYS = 31  # 至少一个月；满月之后才滚动删除
UA = "railway-map-dataset-updater/1.0"

TAG_RE = re.compile(r"gtfs-(\d{8})(?:-|$)")


def log(msg: str) -> None:
    print(f"[update-dataset] {msg}", flush=True)


def tag_date(tag: str) -> datetime | None:
    m = TAG_RE.search(tag or "")
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y%m%d")


def versions_to_delete(
    versions: list[dict[str, Any]],
    now: datetime,
    retention_days: int = RETENTION_DAYS,
    current_id: str | None = None,
    keep_previous: bool = True,
) -> list[str]:
    """决定哪些归档可以删。不变量：

    - 当前版本永不删（current 是 net.json，不在 archive 里也无所谓）
    - retention_days 内的全部保留
    - 若 keep_previous：当前之外、按日期最新的那一份始终保留（回滚）
    """
    dated: list[tuple[datetime, str, dict]] = []
    for v in versions:
        vid = v.get("id") or ""
        if current_id and vid == current_id:
            continue
        d = tag_date(vid)
        if d is None and v.get("date"):
            try:
                d = datetime.strptime(v["date"][:10], "%Y-%m-%d")
            except ValueError:
                d = None
        if d is None:
            continue
        dated.append((d, vid, v))
    dated.sort(key=lambda x: x[0], reverse=True)
    cutoff = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=retention_days)
    keep: set[str] = set()
    if keep_previous and dated:
        keep.add(dated[0][1])
    for d, vid, _ in dated:
        if d >= cutoff:
            keep.add(vid)
    return [vid for _, vid, _ in dated if vid not in keep]


def http_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def download(url: str, dest: str) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


def fetch_release(tag: str | None) -> dict[str, Any]:
    if tag:
        url = f"https://api.github.com/repos/{UPSTREAM_REPO}/releases/tags/{tag}"
    else:
        url = f"https://api.github.com/repos/{UPSTREAM_REPO}/releases/latest"
    rel = http_json(url)
    assets = rel.get("assets") or []
    zip_asset = next((a for a in assets if a.get("name") == "output_gtfs.zip"), None)
    if not zip_asset:
        raise SystemExit(f"release {rel.get('tag_name')} 没有 output_gtfs.zip")
    return {
        "tag": rel["tag_name"],
        "published": rel.get("published_at") or "",
        "zip_url": zip_asset["browser_download_url"],
        "size": zip_asset.get("size") or 0,
    }


def extract_gtfs(zip_path: str, dest_dir: str) -> None:
    os.makedirs(dest_dir, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gtfs-") as tmp:
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(tmp)
        # 若 zip 内有一层目录，找到含 stops.txt 的那一层
        root = tmp
        for dirpath, _dirnames, filenames in os.walk(tmp):
            if "stops.txt" in filenames and "trips.txt" in filenames:
                root = dirpath
                break
        else:
            raise SystemExit("zip 中未找到 stops.txt / trips.txt")
        wanted = ("agency.txt", "calendar.txt", "routes.txt", "stops.txt",
                  "stop_times.txt", "trips.txt", "feed_info.txt", "calendar_dates.txt")
        os.makedirs(dest_dir, exist_ok=True)
        for name in wanted:
            src = os.path.join(root, name)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(dest_dir, name))


def run_etl(release: str, out_json: str) -> None:
    env = os.environ.copy()
    env["GTFS_RELEASE"] = release
    with open(RELEASE_FILE, "w", encoding="utf-8") as f:
        f.write(release + "\n")
    cmd = [sys.executable, os.path.join(ROOT, "etl.py"), GTFS_DIR, out_json]
    log("运行 " + " ".join(cmd))
    subprocess.check_call(cmd, cwd=ROOT, env=env)


def load_manifest() -> dict[str, Any]:
    if os.path.isfile(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            return json.load(f)
    return {"retentionDays": RETENTION_DAYS, "current": None, "versions": []}


def save_manifest(m: dict[str, Any]) -> None:
    m["retentionDays"] = RETENTION_DAYS
    os.makedirs(PUB_DATA, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)
        f.write("\n")


def archive_current_if_needed(m: dict[str, Any]) -> None:
    """把正在使用的 net.json 收到 archive/（若尚未归档）。"""
    if not os.path.isfile(NET_JSON):
        return
    try:
        with open(NET_JSON, encoding="utf-8") as f:
            meta = json.load(f).get("meta") or {}
    except Exception:
        return
    tag = meta.get("release")
    if not tag or tag == "unknown":
        return
    dest_dir = os.path.join(ARCHIVE, tag)
    dest = os.path.join(dest_dir, "net.json")
    if os.path.isfile(dest):
        return
    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy2(NET_JSON, dest)
    entry = {
        "id": tag,
        "date": (tag_date(tag) or datetime.now()).strftime("%Y-%m-%d"),
        "stations": meta.get("stations"),
        "trips": meta.get("trips"),
        "file": f"archive/{tag}/net.json",
        "archivedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    versions = [v for v in m.get("versions") or [] if v.get("id") != tag]
    versions.insert(0, entry)
    m["versions"] = versions
    log(f"已归档当前数据集 {tag}")


def rotate_archives(m: dict[str, Any], dry_run: bool = False) -> list[str]:
    current = m.get("current")
    versions = m.get("versions") or []
    doomed = versions_to_delete(versions, datetime.now(), RETENTION_DAYS, current_id=current, keep_previous=True)
    if not doomed:
        log("归档无需滚动删除")
        return []
    kept = []
    for v in versions:
        vid = v.get("id")
        if vid in doomed:
            path = os.path.join(ARCHIVE, vid)
            log(f"{'将删除' if dry_run else '删除'} 过期归档 {vid}（>{RETENTION_DAYS} 天）")
            if not dry_run and os.path.isdir(path):
                shutil.rmtree(path)
        else:
            kept.append(v)
    if not dry_run:
        m["versions"] = kept
    return doomed


def sync_engine() -> None:
    src = os.path.join(ROOT, "lib", "engine.js")
    dst = os.path.join(ROOT, "public", "engine.js")
    if os.path.isfile(src):
        shutil.copy2(src, dst)
        log("已同步 lib/engine.js → public/engine.js")


def update_submodule() -> None:
    if not os.path.isdir(os.path.join(SUBMODULE, ".git")) and not os.path.isfile(os.path.join(ROOT, ".gitmodules")):
        log("无 submodule，跳过 git submodule update")
        return
    try:
        subprocess.check_call(
            ["git", "submodule", "update", "--init", "--remote", "--", "vendor/chinese-railway-gtfs"],
            cwd=ROOT,
        )
        log("submodule 已更新到上游最新提交（GTFS 本体仍来自 Releases）")
    except subprocess.CalledProcessError as e:
        log(f"submodule 更新失败（忽略，继续拉 Release）: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="更新铁路 GTFS 数据集并按月滚动归档")
    ap.add_argument("--tag", help="指定 release tag，默认 latest")
    ap.add_argument("--rotate-only", action="store_true", help="只做归档滚动，不拉新数据")
    ap.add_argument("--skip-submodule", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    m = load_manifest()
    if args.rotate_only:
        rotate_archives(m, dry_run=args.dry_run)
        if not args.dry_run:
            save_manifest(m)
        return 0

    if not args.skip_submodule:
        update_submodule()

    rel = fetch_release(args.tag)
    tag = rel["tag"]
    log(f"上游 release {tag}  ({rel['size']} bytes)  {rel['zip_url']}")
    if m.get("current") == tag and os.path.isfile(NET_JSON):
        log("已是当前版本，只检查归档滚动")
        rotate_archives(m, dry_run=args.dry_run)
        if not args.dry_run:
            save_manifest(m)
        return 0

    if args.dry_run:
        log("dry-run：将下载、ETL、归档 " + tag)
        doomed = versions_to_delete(m.get("versions") or [], datetime.now(), RETENTION_DAYS, current_id=tag)
        log("dry-run 将删除: " + (", ".join(doomed) if doomed else "(无)"))
        return 0

    archive_current_if_needed(m)

    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    zip_path = os.path.join(ROOT, "data", "output_gtfs.zip")
    log("下载 " + rel["zip_url"])
    download(rel["zip_url"], zip_path)
    extract_gtfs(zip_path, GTFS_DIR)

    tmp_out = os.path.join(PUB_DATA, f".net.{tag}.json")
    os.makedirs(PUB_DATA, exist_ok=True)
    run_etl(tag, tmp_out)

    dest_dir = os.path.join(ARCHIVE, tag)
    os.makedirs(dest_dir, exist_ok=True)
    shutil.copy2(tmp_out, os.path.join(dest_dir, "net.json"))
    shutil.move(tmp_out, NET_JSON)

    with open(NET_JSON, encoding="utf-8") as f:
        meta = json.load(f).get("meta") or {}
    entry = {
        "id": tag,
        "date": (tag_date(tag) or datetime.now()).strftime("%Y-%m-%d"),
        "stations": meta.get("stations"),
        "trips": meta.get("trips"),
        "file": f"archive/{tag}/net.json",
        "publishedAt": rel.get("published"),
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    versions = [v for v in m.get("versions") or [] if v.get("id") != tag]
    versions.insert(0, entry)
    m["current"] = tag
    m["updatedAt"] = entry["builtAt"]
    m["versions"] = versions
    rotate_archives(m)
    save_manifest(m)
    sync_engine()
    log(f"完成。当前 {tag} · 归档 {len(m['versions'])} 份 · 保留 ≥{RETENTION_DAYS} 天")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
