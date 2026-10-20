# Local shear

## Controls

Set a positive geometric neighbor cutoff. Optionally subtract the mean geometric tensor before calculating the local shear. No reference trajectory frame or ideal lattice is needed.

## Algorithm

The calculation follows AtomEye geometric shear. The modal coordination is the most common neighbor count over the complete frame, with the smaller count winning a tie. Each atom uses at most that many closest neighbors and averages their symmetric Cartesian second-moment tensor `M = mean(r rᵀ)`.

The global normalization is the mean squared neighbor length divided by three, evaluated over complete modal-coordination neighborhoods. Divide `M` by that normalization. When enabled, mean subtraction removes the globally averaged normalized tensor.

For tensor components `(xx, xy, xz, yy, yz, zz)`, the reported invariant is

`0.5 × sqrt(xy² + xz² + yz² + ((xx − yy)² + (xx − zz)² + (yy − zz)²)/6)`.

This measures local neighbor anisotropy relative to a global geometric scale. It differs from strain derived from an ideal lattice or a previous frame. If no valid normalization exists, results are NaN. Surface neighborhoods and the chosen cutoff affect its interpretation.

## Implementation

CPU calculation combines coordination counting and second moments in one
neighbor enumeration when a 64-atom pilot has a dominant coordination. The
complete coordination histogram verifies that candidate before any moments
are used. Mixed pilot populations and a disagreement with the full histogram
use the original metrics pass. A 128-atom block dominated by another
coordination also abandons candidate moments early, limiting wasted work from
a misleading pilot. Any abandoned chunk forces the complete exact metrics
pass, including when the candidate remains the true global mode. The pilot
and early-exit guard never define the scientific result.
Only its small candidate record is retained with an immutable Worker search
index; neighbor lists are not retained for the whole frame. An exact fallback
also records its fully verified global mode. Repeated calculations on that
same snapshot and cutoff can then fuse even mixed neighborhoods, while still
checking the complete histogram. A new cutoff, changed coordinate values or
cell creates a fresh verification. The first mixed-frame request may still
need both passes; repeated-frame timings must be reported separately.
When a partition moves between Workers with different cached candidates, it
abandons its moments and uses the exact fallback; partial tensors from
different modes are never combined.

Neighbor ordering, individual squared-distance additions and the existing
logical Worker partitions remain unchanged. Admission includes the additional
coordination output and conservatively reserves the frame/index storage the
original coordination pass could populate in every slot. Fusion requires the
full target Worker count under that bound; tight memory uses the original
two-pass path before any speculative trimming. Cancellation still drains
bounded chunks and retains warm Workers.

An interleaved Node Worker benchmark against `adb0648`, after three complete
warmups, measured the following median wall times. Private mode uses five
samples with four Workers; shared mode uses three samples. Repeated rows use
the same immutable frame and cutoff, including its verified mode.

| Frame | Atoms | Private, previous → current | Atoms | Shared, previous → current |
| --- | ---: | ---: | ---: | ---: |
| FCC, repeated | 108,000 | 128.84 → 69.28 ms | 32,000 | 56.91 → 40.88 ms |
| BCC, repeated | 54,000 | 70.78 → 39.94 ms | 16,000 | 45.31 → 19.70 ms |
| Mixed, repeated | 72,000 | 108.85 → 77.25 ms | 21,600 | 49.40 → 28.79 ms |
| Misleading pilot, repeated | 63,000 | 77.54 → 49.11 ms | 19,200 | 38.07 → 24.64 ms |

New trajectory frames cannot reuse a previously verified mode. A separate
three-sample test with warm JIT code and changed coordinates measured mixed
frames at 136.82 → 135.99 ms privately and 97.13 → 94.06 ms with shared memory.
The intentionally misleading pilot still incurs a fallback cost:
104.17 → 145.69 ms privately and 68.26 → 80.88 ms with shared memory. All
scientific output values, including normalization and NaNs, matched the
previous two-pass implementation exactly. Homogeneous uncached direct calls
enumerated `N + 64` neighborhoods instead of `2N`; mixed fallbacks retained
`2N + 64`. The optimization does not promise a gain for every new mixed frame.

[Raw samples and methodology](../benchmarks/grains-shear-2026-10-20.json) and
[benchmark script](https://github.com/Yazhuo-Liu/AlloyView/blob/main/scripts/benchmark-grains-shear.mjs).

[Coordination, second moments and shear invariant](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/local-shear.js).
