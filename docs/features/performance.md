# Performance

## What the metrics show

The performance panel reports the current render/analysis timing and trajectory cache. Atom count, active overlays, number of displayed replicas, canvas resolution and the available GPU all affect interaction speed. Analysis timing includes different stages from drawing and should be interpreted separately.

## Workers and memory

Parsing runs in a structure Worker. Analyses share a bounded scheduler and process independent central-atom ranges in module Workers. The pool limits total concurrency to at most six Workers and at most the available hardware threads minus one, with a minimum of one. Memory estimates can further reduce parallel ranges.

Cross-origin isolated local servers can share input coordinate arrays through SharedArrayBuffer. Ordinary static hosting uses bounded private copies prepared with yields to the UI thread. Both paths calculate on this device. Each PTM Worker initializes its own reusable WebAssembly kernel.

An adaptive memory budget limits cached trajectory frames and results. Cancellation and source/frame/parameter ownership checks prevent late Worker messages from applying obsolete results. Closing the source stops playback and analysis, releases cached structure data, and restores the homepage. While GPU computing stays enabled, its device and compiled pipelines can be reused for the next source.

## Enable GPU computing

The **Enable GPU computing** switch beside **Light / Dark** is off by default. Turn it on to prefer WebGPU for supported analyses. The preference applies to the next calculation: completed results remain available, and clicking **Calculate** again uses the selected backend. JSON configuration export/import includes this preference; older configurations keep GPU computing off.

| Analysis | GPU computing enabled |
| --- | --- |
| Coordination number | WebGPU linked-cell neighbor search and atom counts |
| Total or element-pair RDF | WebGPU neighbor search and distance histogram |
| Local geometric shear | WebGPU neighbor geometry and per-atom shear |
| CNA, PTM, central symmetry, ideal/reference strain, bonds and displacement | Existing CPU implementation |

Algorithms without a GPU version continue to use their CPU implementation. When WebGPU, a suitable adapter or the required device limits are unavailable, supported analyses also fall back to CPU. Cancelling a calculation stops the job and retains the usual cancellation behavior. WebGPU requires a secure browser context: HTTPS or localhost.

## How the GPU backend works

GPU code lives in **`src/analysis/gpu/`**, separate from the CPU kernels. Both backends return the same analysis quantities to the scheduler, color legend and frame cache. Linked-cell search limits neighbor candidates; the implementation does not compare every atom with every other atom. This matters for large inputs such as the bundled 129,904-atom **Ni grain boundary** example, `examples/NiGB_minimized.cfg`.

A reusable GPU device and pipelines amortize initialization, while uploaded coordinate buffers can be reused across compatible analyses. GPU buffers are shared by GPU passes after an upload; JavaScript arrays and SharedArrayBuffer are not automatically the same memory as GPU buffers. Workgroup memory is local to a GPU workgroup. WebGPU is a cross-vendor API and does not require CUDA or an NVIDIA GPU.

Enabling GPU computing starts device initialization and common shader compilation in the background. Once a structure is loaded, the current frame's coordinates and element types are uploaded before background trajectory preparation. Preparation does not calculate analysis results. The renderer uses separate WebGL buffers, so displaying a structure and preparing WebGPU analysis are separate operations.

The GPU cache estimates the resident frame size and reserves space for calculation buffers. If the complete sequence fits its conservative budget, all frames are uploaded in the background. Otherwise, it keeps a window around the current frame, preferring the next and previous frames. Moving through the trajectory updates this window; foreground calculations take priority over background uploads. CPU and GPU caches have independent capacities, and reparsing a frame after CPU eviction still reuses its resident GPU data.

Standard WebGPU does not expose free VRAM. The cache starts with an allocation budget of 2 GiB for hardware or 128 MiB for a software adapter, including a calculation workspace reserve. This is a ceiling, not an upfront reservation: only the loaded frames and required calculation buffers consume memory. The cache checks individual buffer limits and, if an allocation runs out of memory, lowers its budget, evicts distant frames and retries once while protecting the current frame. Thus a GPU with less available memory can retain a smaller nearby-frame window. A frame that cannot be prepared safely uses the existing CPU fallback. Closing or changing the source clears structure buffers while retaining the GPU device and compiled pipelines; switching GPU computing off releases the GPU Worker after any accepted calculation finishes. A new cutoff can require a new neighbor index, and uncommon shader variants are still compiled on demand.

GPU arithmetic uses 32-bit floating point. CPU calculations retain their existing precision, so small differences can appear in continuous values and near distance thresholds. Uploads, shader compilation, reductions and result readback all contribute to elapsed time. Small structures may finish sooner on CPU, and enabling GPU computing does not guarantee a speedup. Compare the same file, cutoff and analysis parameters, reporting cold initialization separately from subsequent runs and distinguishing hardware adapters from software adapters. See [validation](../VALIDATION.md) for executed checks rather than treating software-adapter timing as a physical GPU benchmark.

## Compare CPU and GPU time

With Node.js 24 and Chrome/Chromium installed, run:

```bash
npm run test:gpu
npm run benchmark:gpu
# Select one calculation and save the report:
npm run benchmark:gpu -- --kernel=coordination --output=/tmp/alloyview-gpu.json
# Measure preparation separately, then calculate with preloaded inputs:
npm run benchmark:gpu -- --hardware --preload
# Explicit software execution checks when no physical adapter is available:
npm run benchmark:gpu -- --software
```

The benchmark loads `NiGB_minimized.cfg`, bypasses application result caches, checks CPU/GPU output agreement, and reports cold and warm wall times, adapter details and CPU fallback reasons. With `--preload`, preparation time is reported separately; the first calculation then uses the prepared device, common pipelines and resident frame. Its RDF cutoff respects the example's thin periodic Z cell. `test:gpu` uses a software adapter by default; pass `--hardware` to test a physical GPU. `benchmark:gpu` requests a hardware adapter by default. Hardware mode rejects software adapters; use `--software` explicitly for software execution checks.

On Linux, the headless runner enables the Vulkan backend for hardware mode and removes the inherited `DISPLAY` from the Chrome subprocess environment. A forwarded SSH/X11 display can otherwise cause ANGLE initialization to fail even when `nvidia-smi` detects the GPU. WebGPU uses the graphics driver and Vulkan rather than CUDA, so `nvidia-smi` alone does not verify this path. Failed adapter checks include Chrome's GPU initialization log. Install Chrome/Chromium or set `CHROME_PATH`; additional flags can be supplied as a JSON array in `ALLOYVIEW_CHROME_ARGS`.

The runner also enables `--enable-unsafe-webgpu`. A successful hardware benchmark confirms this configured browser can execute the kernels; it does not guarantee WebGPU is enabled in an ordinary browser. On GitHub Pages, enabling GPU computing automatically starts the same preparation and caching without a command-line benchmark, provided the visitor's browser supplies an adapter. See [WebGPU on GitHub Pages](../DEPLOYMENT.md#webgpu-on-github-pages) for deployment checks.

See Chrome's [headless WebGPU setup](https://developer.chrome.com/blog/supercharge-web-ai-testing) for the Vulkan launch flags and driver checks.

## Implementation

[Analysis scheduler](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js), [GPU backend](https://github.com/Yazhuo-Liu/AlloyView/tree/main/src/analysis/gpu), [cache policy](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/cache-policy.js), [validation guide](../VALIDATION.md).
