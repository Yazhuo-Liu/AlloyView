#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v em++ >/dev/null 2>&1; then
  compiler=(em++)
elif [[ -f /workspace/.tools/wasm-sdk/usr/share/emscripten/em++.py ]]; then
  export EM_CONFIG=/workspace/.tools/emscripten-config
  export LD_LIBRARY_PATH="/workspace/.tools/wasm-sdk/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  compiler=(python3 /workspace/.tools/wasm-sdk/usr/share/emscripten/em++.py)
else
  echo 'Install Emscripten (tested: Debian 3.1.69 / LLVM 19) to rebuild PTM.' >&2
  exit 1
fi
(cd "$project_root/third_party/ptm" && sha256sum --check --quiet SHA256SUMS)
# Compilation is capped for cloud machines; each live Worker gets its own Wasm
# instance. No pthread/shared-Wasm requirement on ordinary static hosting.
export EMCC_CORES="${EMCC_CORES:-3}"
"${compiler[@]}" "$project_root/wasm/ptm.cpp" "$project_root"/third_party/ptm/*.cpp \
  -I "$project_root/third_party/ptm" -O3 -std=c++17 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_alloy_ptm_init","_alloy_ptm_atom"]' \
  -o "$project_root/src/analysis/ptm-kernel.mjs"
chmod 644 "$project_root/src/analysis/ptm-kernel.mjs" "$project_root/src/analysis/ptm-kernel.wasm"
