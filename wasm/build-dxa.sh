#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
thread_flags=()
output_name=dxa-kernel
runtime_methods='["UTF8ToString"]'
if [[ "${1:-}" == --threaded ]]; then
  # The module starts with an empty pool. JavaScript preloads new Workers into
  # this same module/heap asynchronously before entering synchronous C++ work,
  # so growing the pool never depends on a blocked coordinator event loop.
  thread_flags=(-pthread '-sPTHREAD_POOL_SIZE=Module.dxaPoolSize || 0'
    -sPTHREAD_POOL_SIZE_STRICT=2 -sDEFAULT_PTHREAD_STACK_SIZE=2097152)
  output_name=dxa-kernel-threaded
  runtime_methods='["UTF8ToString","PThread"]'
elif [[ $# -gt 0 ]]; then
  echo 'Usage: build-dxa.sh [--threaded]' >&2
  exit 1
fi
if command -v em++ >/dev/null 2>&1; then
  compiler=(em++)
elif [[ -f /workspace/.tools/wasm-sdk/usr/share/emscripten/em++.py ]]; then
  export EM_CONFIG=/workspace/.tools/emscripten-config
  export LD_LIBRARY_PATH="/workspace/.tools/wasm-sdk/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
  compiler=(python3 /workspace/.tools/wasm-sdk/usr/share/emscripten/em++.py)
else
  echo 'Install Emscripten (tested: Debian 3.1.69 / LLVM 19) to rebuild DXA.' >&2
  exit 1
fi
dxa_root="$project_root/third_party/dxa"
(cd "$dxa_root" && sha256sum --check --quiet SHA256SUMS)
export EMCC_CORES="${EMCC_CORES:-3}"
mapfile -t sources < <(find "$dxa_root/upstream" "$dxa_root/compat" "$dxa_root/geometry" -name '*.cpp' -print | sort)
"${compiler[@]}" "$project_root/wasm/dxa.cpp" "${sources[@]}" \
  -I "$dxa_root" -I "$dxa_root/upstream" -I "$dxa_root/compat" -I "$dxa_root/geometry" \
  -O3 -std=c++17 -fexceptions "${thread_flags[@]}" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 -sINITIAL_MEMORY=33554432 \
  -sSTACK_SIZE=2097152 -sFILESYSTEM=0 -sDISABLE_EXCEPTION_CATCHING=0 \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_alloy_dxa_analyze","_alloy_dxa_last_error","_alloy_dxa_set_threads","_alloy_dxa_thread_count","_alloy_dxa_cancel_ptr","_alloy_dxa_reset_cancel"]' \
  "-sEXPORTED_RUNTIME_METHODS=$runtime_methods" \
  -o "$project_root/src/analysis/$output_name.mjs"
chmod 644 "$project_root/src/analysis/$output_name.mjs" "$project_root/src/analysis/$output_name.wasm"
if [[ -f "$project_root/src/analysis/$output_name.worker.js" ]]; then
  chmod 644 "$project_root/src/analysis/$output_name.worker.js"
fi
