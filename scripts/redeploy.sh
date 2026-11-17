#!/usr/bin/env bash
# Role: 更新数据，并按 DEPLOY=1 运行经过测试的 Cloudflare 发布。
# 契约：docs/specs/delivery.md；凭据由环境提供。
set -euo pipefail
RAIL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIL_ROOT"
python3 scripts/update_dataset.py --skip-submodule "$@"
if [[ "${DEPLOY:-0}" == "1" ]]; then
  npm ci
  npm test
  npm run build
  npm run pages:build
  npm run test:browser
  npx --no-install wrangler pages deploy public --project-name "${CF_PAGES_PROJECT:-railway-map}" --branch main
fi
