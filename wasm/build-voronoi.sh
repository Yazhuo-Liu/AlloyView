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
  echo 'Install Emscripten (tested: Debian 3.1.69 / LLVM 19) to rebuild Voronoi.' >&2
  exit 1
fi
(cd "$project_root/third_party/voro" && sha256sum --check --quiet SHA256SUMS)
export EMCC_CORES="${EMCC_CORES:-3}"
"${compiler[@]}" "$project_root/wasm/voronoi.cpp" \
  "$project_root/third_party/voro/cell.cc" "$project_root/third_party/voro/common.cc" \
  -I "$project_root/third_party/voro" -O3 -std=c++17 \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_alloy_voronoi_init","_alloy_voronoi_clip","_alloy_voronoi_radius_squared","_alloy_voronoi_summary","_alloy_voronoi_faces"]' \
  -o "$project_root/src/analysis/voronoi-kernel.mjs"
chmod 644 "$project_root/src/analysis/voronoi-kernel.mjs" "$project_root/src/analysis/voronoi-kernel.wasm"
