# Performance

## What the metrics show

The performance panel reports the current render/analysis timing and trajectory cache. Atom count, active overlays, number of displayed replicas, canvas resolution and the available GPU all affect interaction speed. Analysis timing includes different stages from drawing and should be interpreted separately.

## Workers and memory

Parsing runs in a structure Worker. Analyses share a bounded scheduler and process independent central-atom ranges in module Workers. The pool limits total concurrency to at most six Workers and at most the available hardware threads minus one, with a minimum of one. Memory estimates can further reduce parallel ranges.

Cross-origin isolated local servers can share input coordinate arrays through SharedArrayBuffer. Ordinary static hosting uses bounded private copies prepared with yields to the UI thread. Both paths calculate on this device. Each PTM Worker initializes its own reusable WebAssembly kernel.

An adaptive memory budget limits cached trajectory frames and results. Cancellation and source/frame/parameter ownership checks prevent late Worker messages from applying obsolete results. Closing the source stops playback and analysis, releases cached structure data, and restores the homepage. While GPU acceleration stays enabled, its device and compiled pipelines can be reused for the next source.

## Enable GPU acceleration

The **Enable GPU acceleration** switch beside **Light / Dark** is on by default and prefers WebGPU for supported analyses. Turn it off to use CPU Workers. The preference applies to the next calculation: completed results remain available, and clicking **Calculate** again uses the selected backend. JSON configuration export/import includes this preference; explicit saved off settings remain off, while configurations without a GPU preference use the enabled default.

| Analysis | GPU acceleration enabled |
| --- | --- |
| Coordination number | WebGPU linked-cell neighbor search and atom counts |
| Adaptive or fixed-cutoff CNA | WebGPU local neighbor graphs and crystal classification |
| Manual or Auto central symmetry | WebGPU nearest-neighbor selection and normalized greedy pairing; Auto uses local CNA labels |
| Displacement | WebGPU Cartesian differences, triclinic minimum images and vector magnitudes |
| Reference-frame strain | WebGPU reference-neighbor deformation fit, tensor and invariants |
| Total or element-pair RDF | WebGPU neighbor search and distance histogram |
| Local geometric shear | WebGPU neighbor geometry and per-atom shear |
| Bonds | WebGPU periodic neighbor counts and compact bond graph, including element-pair cutoffs |
| Ideal lattice strain | WebGPU neighbors, CPU PTM fit, then WebGPU ideal-reference conversion and tensor invariants; compatible PTM fits/uploads are reused |
| Standalone PTM | Existing CPU neighbor search and Wasm correspondence fit |
| DXA | Hybrid: WebGPU tetrahedron alpha and elastic-compatibility classification, CPU periodic tessellation and Burgers-circuit tracing |

Algorithms without a GPU version continue to use their CPU implementation. When WebGPU, a suitable adapter or the required device limits are unavailable, supported analyses also fall back to CPU. Cancelling a calculation stops the job and retains the usual cancellation behavior. WebGPU requires a secure browser context: HTTPS or localhost.

Ideal lattice strain reports GPU neighbor preparation, CPU PTM fitting and GPU reference/tensor evaluation as separate stages. If the GPU reference/tensor stage fails, CPU fallback reuses the completed fit instead of repeating PTM. GPU reference evaluation selects each atom's element and phase, applies the editable lattice parameters, restores absolute deformation and computes strain invariants. Only raw fit arrays and a small per-element reference table are prepared on CPU. [PTM](ptm.md), [CNA](cna.md), [central symmetry](centrosymmetry.md), [displacement](displacement.md), [reference-frame strain](reference-strain.md), [bonds](bonds.md) and [ideal lattice strain](ideal-strain.md) document their cutoff, precision and reference conventions.

## How the GPU backend works

GPU code lives in **`src/analysis/gpu/`**, separate from the CPU kernels. Both backends return the same analysis quantities to the scheduler, color legend and frame cache. Linked-cell search limits neighbor candidates; the implementation does not compare every atom with every other atom. This matters for large inputs such as the bundled 129,904-atom **Ni grain boundary** example, `examples/NiGB_minimized.cfg`.

A reusable GPU device and pipelines amortize initialization, while uploaded coordinate buffers can be reused across compatible analyses. GPU buffers are shared by GPU passes after an upload; JavaScript arrays and SharedArrayBuffer are not automatically the same memory as GPU buffers. Workgroup memory is local to a GPU workgroup. WebGPU is a cross-vendor API and does not require CUDA or an NVIDIA GPU.

Reference-frame strain prepares both configurations and keeps their GPU buffers resident during the calculation. Atom-ID matching remains CPU work; the reference-neighbor search, deformation fit and output tensors run on GPU. Selecting another reference can reuse that frame's cached upload without changing the displayed frame's identity.

DXA uploads a deduplicated snapshot of the completed tessellation and ideal
edge mapping to the shared GPU device. Alpha filtering and elastic compatibility
run there in two passes with intermediate labels kept on the device. One region
array returns to the existing Wasm session before interface construction and
line tracing. The reported backend is hybrid; a failed GPU stage reuses the
prepared CPU state. This does not yet implement GPU Delaunay or GPU line tracing.
See [DXA](dislocations.md) for settings and scientific limitations.

Displacement also retains current/reference inputs, caching anchored Cartesian high/low buffers separately for wrapped and unwrapped coordinates. Its vector differences, current-cell minimum images and magnitudes run on GPU after CPU atom matching. A Cartesian-only upload does not need the neighbor grid, so open coordinates outside the fractional unit box are supported. Auto central symmetry reuses compatible adaptive-CNA labels or runs GPU adaptive CNA before nearest-shell voting and greedy pairing.

Fresh ideal strain can prepare its PTM nearest-neighbor table on GPU, preserving exact ordering through shader-emulated IEEE64 arithmetic. Readback is batched to at most 16,384 atoms, while a 256 MiB ceiling bounds the full 505-byte-per-atom host table. Diamond and graphene fitting require that complete table; other templates can give CPU Workers only their own ranges. CPU fitting remains necessary, and standalone PTM retains its CPU path. Cached ideal-strain fits also keep their raw GPU PTM uploads, so a reference edit updates the small element table without repeating fitting or uploading every deformation matrix.

Enabling GPU acceleration starts device initialization and common shader compilation in the background. Once a structure is loaded, the current frame's coordinates and element types are uploaded before background trajectory preparation. Preparation does not calculate analysis results. The renderer uses separate WebGL buffers, so displaying a structure and preparing WebGPU analysis are separate operations.

The GPU cache estimates the resident frame size and reserves space for calculation buffers. If the complete sequence fits its conservative budget, all frames are uploaded in the background. Otherwise, it keeps a window around the current frame, preferring the next and previous frames. Moving through the trajectory updates this window; foreground calculations take priority over background uploads. CPU and GPU caches have independent capacities, and reparsing a frame after CPU eviction still reuses its resident GPU data.

Standard WebGPU does not expose free VRAM. The cache starts with an allocation budget of 2 GiB for hardware or 128 MiB for a software adapter, including a calculation workspace reserve. This is a ceiling, not an upfront reservation: only the loaded frames and required calculation buffers consume memory. The cache checks individual buffer limits and, if an allocation runs out of memory, lowers its budget, evicts distant frames and retries once while protecting the current frame. Thus a GPU with less available memory can retain a smaller nearby-frame window. A frame that cannot be prepared safely uses the existing CPU fallback. Closing or changing the source clears structure buffers while retaining the GPU device and compiled pipelines; switching GPU acceleration off releases the GPU Worker after any accepted calculation finishes. A new cutoff can require a new neighbor index, and uncommon shader variants are still compiled on demand.

Most GPU kernels use 32-bit floating point. High and low input components retain coordinate and PTM fit precision; strain kernels use compensated matrix arithmetic and apply the CPU threshold for numerical zeros. Central symmetry and fresh-strain neighbor preparation additionally emulate IEEE 64-bit arithmetic in their shaders to preserve strict neighbor ordering and CSP pair choices; this does not rely on native GPU float64. Ambiguous neighbor cutoff or ordering decisions in other kernels receive sparse CPU corrections. Continuous values can still differ slightly between backends, including small strain residuals, and inputs outside the supported precision range use CPU. In particular, GPU neighbor searches fall back when their padded search radius exceeds 32 times the face height along a periodic axis; small nonperiodic face heights do not trigger this limit.

Uploads, shader compilation, reductions and result readback all contribute to elapsed time. Small structures may finish sooner on CPU, and enabling GPU acceleration does not guarantee a speedup. Compare the same file, cutoff and analysis parameters, reporting cold initialization separately from subsequent runs and distinguishing hardware adapters from software adapters. See [validation](../VALIDATION.md) for executed checks rather than treating software-adapter timing as a physical GPU benchmark.

## Analysis results and rendering

The current renderer uses WebGL2. WebGPU analysis writes results to GPU buffers, copies them to a readable staging buffer, and returns typed arrays to the application. The color legend uses these scalar arrays, and vector display builds arrow data from the selected X, Y and Z fields. Drawing then uploads colors and vectors into separate WebGL buffers. Input uploads can be reused by subsequent WebGPU calculations, but the current rendering path still includes result readback and WebGL upload.

Browsers provide no portable way to use a WebGPU `GPUBuffer` directly as a WebGL buffer. A future WebGPU renderer could draw from retained analysis buffers on the same `GPUDevice`, avoiding the full array round trip for supported displays. It would need to keep those buffers alive, map colors on GPU and write any CPU precision corrections back before drawing. The present analysis Worker owns its device and releases temporary output buffers after returning results, so this would require a change to device ownership and rendering. Legends, atom inspection and data export would still need summary statistics or selected values on the CPU.

## Compare CPU and GPU time

With Node.js 24 and Chrome/Chromium installed, run:

```bash
npm run test:gpu
npm run benchmark:gpu
# Select one calculation and save the report:
npm run benchmark:gpu -- --kernel=coordination --output=/tmp/alloyview-gpu.json
# Compare each CNA mode or reference-frame strain:
npm run benchmark:gpu -- --kernel=cnaFixed
npm run benchmark:gpu -- --kernel=cnaAdaptive
npm run benchmark:gpu -- --kernel=referenceStrain
# Compare manual/Auto symmetry or displacement:
npm run benchmark:gpu -- --kernel=csp8
npm run benchmark:gpu -- --kernel=csp12
npm run benchmark:gpu -- --kernel=cspAuto
npm run benchmark:gpu -- --kernel=displacement
# Ideal-reference conversion and tensors with a cached PTM fit:
npm run benchmark:gpu -- --kernel=strain
# Full fresh-strain pipeline or a resident-fit reference edit:
npm run benchmark:gpu -- --kernel=strainFresh
npm run benchmark:gpu -- --kernel=strainEdited
# Measure preparation separately, then calculate with preloaded inputs:
npm run benchmark:gpu -- --hardware --preload
# Explicit software execution checks when no physical adapter is available:
npm run benchmark:gpu -- --software
```

The benchmark loads `NiGB_minimized.cfg`, bypasses application result caches, checks CPU/GPU output agreement, and reports cold and warm wall times, adapter details and CPU fallback reasons. Fixed CNA uses a 3.1 Å cutoff; adaptive CNA uses its local shell scales. The reference-strain benchmark creates a controlled affine copy of the same atoms and cell, with known correspondence, and compares it against the original reference; it does not read a trajectory. Its row-major deformation gradient is `F = [1.02, 0.12, 0.03; 0, 0.98, 0.05; 0, 0, 1.04]`.

Central-symmetry benchmarks use either 8 or 12 neighbors or local Auto shells. The displacement benchmark creates a Cartesian copy translated by `[0.12, −0.08, 0.05]` Å, retaining known same-row correspondence to the source. It reports matching/preparation separately, compares all components and magnitudes, and does not infer trajectory motion from this single example.

`strain` measures GPU ideal-reference conversion and tensor evaluation from a cached CPU PTM fit, reporting its fitting preparation separately. `strainFresh` measures the complete GPU-neighbor → CPU PTM → GPU reference/tensor pipeline. `strainEdited` changes Ni's reference `a` from 3.52 to 3.4 Å after separately timed CPU fitting and GPU resident-input preparation; the measured edit reuses that fit and its upload. These modes retain the same nine strain fields and NaN conventions, and the report identifies preparation costs and cache reuse rather than treating an edited reference as a fresh fit.

With `--preload`, preparation time is reported separately; the first calculation then uses the prepared device, common pipelines and resident frame. Its RDF cutoff respects the example's thin periodic Z cell. `test:gpu` uses a software adapter by default; pass `--hardware` to test a physical GPU. `benchmark:gpu` requests a hardware adapter by default. Hardware mode rejects software adapters; use `--software` explicitly for software execution checks.

On Linux, the headless runner enables the Vulkan backend for hardware mode and removes the inherited `DISPLAY` from the Chrome subprocess environment. A forwarded SSH/X11 display can otherwise cause ANGLE initialization to fail even when `nvidia-smi` detects the GPU. WebGPU uses the graphics driver and Vulkan rather than CUDA, so `nvidia-smi` alone does not verify this path. Failed adapter checks include Chrome's GPU initialization log. Install Chrome/Chromium or set `CHROME_PATH`; additional flags can be supplied as a JSON array in `ALLOYVIEW_CHROME_ARGS`.

The runner also enables `--enable-unsafe-webgpu`. A successful hardware benchmark confirms this configured browser can execute the kernels; it does not guarantee WebGPU is enabled in an ordinary browser. On GitHub Pages, enabling GPU acceleration automatically starts the same preparation and caching without a command-line benchmark, provided the visitor's browser supplies an adapter. See [WebGPU on GitHub Pages](../DEPLOYMENT.md#webgpu-on-github-pages) for deployment checks.

See Chrome's [headless WebGPU setup](https://developer.chrome.com/blog/supercharge-web-ai-testing) for the Vulkan launch flags and driver checks.

## Implementation

[Analysis scheduler](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js), [GPU backend](https://github.com/Yazhuo-Liu/AlloyView/tree/main/src/analysis/gpu), [cache policy](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/cache-policy.js), [validation guide](../VALIDATION.md).
