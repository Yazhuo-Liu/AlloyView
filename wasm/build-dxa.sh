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
  echo 'Install Emscripten 3.1.69 to rebuild DXA, e.g. emsdk: ./emsdk install 3.1.69 && ./emsdk activate 3.1.69 && source ./emsdk_env.sh' >&2
  exit 1
fi
dxa_root="$project_root/third_party/dxa"
(cd "$dxa_root" && sha256sum --check --quiet SHA256SUMS)
export EMCC_CORES="${EMCC_CORES:-3}"
mapfile -t sources < <(find "$dxa_root/upstream" "$dxa_root/compat" "$dxa_root/geometry" -name '*.cpp' -print | sort)
"${compiler[@]}" "$project_root/wasm/dxa.cpp" "$project_root/wasm/dxa-local.cpp" "$project_root/wasm/dxa-classify.cpp" "${sources[@]}" \
  -I "$dxa_root" -I "$dxa_root/upstream" -I "$dxa_root/compat" -I "$dxa_root/geometry" \
  -O3 -flto -msimd128 -std=c++17 -fwasm-exceptions "${thread_flags[@]}" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 -sINITIAL_MEMORY=33554432 \
  -sSTACK_SIZE=2097152 -sFILESYSTEM=0 -fwasm-exceptions \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_alloy_dxa_analyze","_alloy_dxa_last_error","_alloy_dxa_set_threads","_alloy_dxa_thread_count","_alloy_dxa_cancel_ptr","_alloy_dxa_reset_cancel","_alloy_dxa_begin","_alloy_dxa_finish","_alloy_dxa_dispose","_alloy_dxa_binary_labels","_alloy_dxa_result_labels_ptr","_alloy_dxa_result_labels_count","_alloy_dxa_prepare","_alloy_dxa_import_local","_alloy_dxa_worker_snapshot","_alloy_dxa_release_worker_snapshot","_alloy_dxa_worker_vertex_count","_alloy_dxa_worker_tet_count","_alloy_dxa_worker_edge_count","_alloy_dxa_worker_transition_count","_alloy_dxa_worker_snapshot_bytes","_alloy_dxa_worker_alpha","_alloy_dxa_worker_vertex_ptr","_alloy_dxa_worker_tet_ptr","_alloy_dxa_worker_edge_ptr","_alloy_dxa_worker_transition_ptr","_alloy_dxa_import_regions","_alloy_dxa_worker_regions_ptr","_alloy_dxa_classify_range","_alloy_dxa_classify_error","_alloy_dxa_local_prepare","_alloy_dxa_local_identify","_alloy_dxa_local_structures_ptr","_alloy_dxa_local_neighbors_ptr","_alloy_dxa_local_neighbor_width","_alloy_dxa_local_max_distance","_alloy_dxa_local_error","_alloy_dxa_local_dispose"]' \
  "-sEXPORTED_RUNTIME_METHODS=$runtime_methods" \
  -o "$project_root/src/analysis/$output_name.mjs"
chmod 644 "$project_root/src/analysis/$output_name.mjs" "$project_root/src/analysis/$output_name.wasm"
if [[ -f "$project_root/src/analysis/$output_name.worker.js" ]]; then
  chmod 644 "$project_root/src/analysis/$output_name.worker.js"
fi
