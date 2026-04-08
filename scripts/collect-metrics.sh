#!/usr/bin/env bash
# 由 cron 调用。cron 默认 PATH 很短，常没有 node/npx，本脚本会尽量自动找 node。
#
# 若仍失败，在 crontab 或本脚本前 export 其一：
#   export NODE_BINARY=/usr/bin/node
#   或
#   export PATH=/usr/local/bin:/usr/bin
#
# crontab 示例：
#   * * * * * cd /opt/jupyterhub-ops && METRICS_SQLITE_PATH=/opt/jupyterhub/data/metrics.db ./scripts/collect-metrics.sh >> /var/log/jupyterhub-ops-metrics.log 2>&1
#
# 若 tsx 在服务器上报 esbuild TransformError，请在本机/服务器执行一次：
#   pnpm run build:collect-metrics
# 生成 scripts/collect-metrics.cjs 后，本脚本会优先用纯 node 运行，不再依赖 tsx。
# 更新代码后务必重新 build:collect-metrics，否则服务器仍在跑旧 bundle（易报 fetch is not defined）。
#
# Hub API 与 token 可用环境变量覆盖（与 cluster.ts 不一致时）：
#   export JHOPS_JUPYTERHUB_API_URL='http://127.0.0.1:8002/jupyterhub/hub/api/users'
#   export JHOPS_JUPYTERHUB_TOKEN='5b1682dcfca4461eb666851a8148bcb6'
# 排查 worker 上 docker stats 的 SSH 失败：export JHOPS_COLLECT_DEBUG=1
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 常见安装路径（cron 无 login shell 时仍能找到；含 /opt/nodejs/bin 等自定义安装）
export PATH="/opt/nodejs/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${PATH:-}"

resolve_node() {
  if [ -n "${NODE_BINARY:-}" ] && [ -x "$NODE_BINARY" ]; then
    echo "$NODE_BINARY"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for c in /opt/nodejs/bin/node /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
    if [ -x "$c" ]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

resolve_tsx_cli() {
  local f="$ROOT/node_modules/tsx/dist/cli.mjs"
  if [ -f "$f" ]; then
    echo "$f"
    return 0
  fi
  # pnpm：tsx 在 .pnpm/tsx@版本/node_modules/tsx/dist/cli.mjs
  if [ -d "$ROOT/node_modules/.pnpm" ]; then
    local g
    for g in "$ROOT/node_modules/.pnpm"/tsx@*/node_modules/tsx/dist/cli.mjs; do
      if [ -f "$g" ]; then
        echo "$g"
        return 0
      fi
    done
  fi
  return 1
}

NODE="$(resolve_node)" || {
  echo "collect-metrics: 找不到 node。请设置 NODE_BINARY=/绝对路径/node 或在 crontab 里设置 PATH。" >&2
  exit 1
}

BUNDLE="$ROOT/scripts/collect-metrics.cjs"
if [ -f "$BUNDLE" ]; then
  exec "$NODE" "$BUNDLE"
fi

CLI="$(resolve_tsx_cli)" || {
  echo "collect-metrics: 找不到 tsx（请先在该目录执行 pnpm install / npm install），或运行 pnpm run build:collect-metrics 生成 collect-metrics.cjs。" >&2
  exit 1
}

exec "$NODE" "$CLI" --tsconfig tsconfig.json scripts/collect-metrics.ts
