#!/usr/bin/env bash
# 数据集更新 +（可选）Cloudflare Pages 部署
#   ./scripts/redeploy.sh              # 只更新数据集
#   DEPLOY=1 ./scripts/redeploy.sh     # 更新后 wrangler pages deploy
#   ./scripts/redeploy.sh --tag gtfs-20260913-040340
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 "$ROOT/scripts/update_dataset.py" "$@"

if [[ "${DEPLOY:-0}" == "1" ]]; then
  if ! command -v wrangler >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
    echo "[redeploy] 未找到 wrangler/npx，跳过 Cloudflare 部署" >&2
    exit 1
  fi
  echo "[redeploy] Cloudflare Pages deploy (output=public/)"
  if command -v wrangler >/dev/null 2>&1; then
    wrangler pages deploy "$ROOT/public" --project-name "${CF_PAGES_PROJECT:-railway-map}"
  else
    npx wrangler pages deploy "$ROOT/public" --project-name "${CF_PAGES_PROJECT:-railway-map}"
  fi
fi

echo "[redeploy] 完成。本地预览: node server.js  → http://127.0.0.1:8787"
