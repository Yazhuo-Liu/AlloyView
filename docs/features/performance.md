# Performance

## What the metrics show

The performance panel reports the current render/analysis timing and trajectory cache. Atom count, active overlays, number of displayed replicas, canvas resolution and the available GPU all affect interaction speed. Analysis timing includes different stages from drawing and should be interpreted separately.

## Workers and memory

Parsing runs in a structure Worker. Analyses share a bounded scheduler and process independent central-atom ranges in module Workers. The pool limits total concurrency to at most six Workers and at most the available hardware threads minus one, with a minimum of one. Memory estimates can further reduce parallel ranges.

Cross-origin isolated local servers can share input coordinate arrays through SharedArrayBuffer. Ordinary static hosting uses bounded private copies prepared with yields to the UI thread. Both paths calculate on this device. Each PTM Worker initializes its own reusable WebAssembly kernel.

An adaptive memory budget limits cached trajectory frames and results. Cancellation and source/frame/parameter ownership checks prevent late Worker messages from applying obsolete results. Closing the source stops playback and analysis, releases caches and GPU data, and restores the homepage.

## Implementation

[Analysis scheduler](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/analysis-pool.js), [cache policy](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/cache-policy.js), [validation guide](../VALIDATION.md).
