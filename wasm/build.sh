#!/usr/bin/env bash
set -euo pipefail

if ! command -v em++ >/dev/null 2>&1; then
  echo "Emscripten em++ was not found. Install/activate emsdk, then retry." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

em++ "${script_dir}/coordination.cpp" \
  -O3 \
  -std=c++17 \
  -sWASM=1 \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sENVIRONMENT=worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_alloy_coordination"]' \
  -o "${script_dir}/coordination.mjs"

echo "Built ${script_dir}/coordination.mjs and coordination.wasm"
