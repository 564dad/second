#!/usr/bin/env bash
# 运行全部无头验证：物理引擎 24 项 + 页面逻辑 16 项。
# 若系统无 node，可用仓库内便携运行时（tools/node-*），或设置 NODE_BIN。
set -euo pipefail
cd "$(dirname "$0")/.."

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ]; then
  PORTABLE="$(ls tools/node-*/bin/node 2>/dev/null | head -1 || true)"
  if [ -n "$PORTABLE" ]; then NODE_BIN="$PORTABLE"; fi
fi
if [ -z "$NODE_BIN" ]; then
  echo "未找到 node。可安装 Node 18+，或下载便携版解压到 tools/ 后重试。" >&2
  exit 127
fi

echo "=== 物理引擎验证（tests/verify.js） ==="
"$NODE_BIN" tests/verify.js
echo
echo "=== 页面逻辑冒烟测试（tests/dom-harness.js） ==="
"$NODE_BIN" tests/dom-harness.js
echo
echo "全部测试通过。"
