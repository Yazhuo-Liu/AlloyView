# Powder X-ray diffraction — 2026-10-26

## Scope and baseline

Started from `12e13f0`, identical to the fetched remote. The existing Crystal
panel already provided CIF/POSCAR viewing, space groups, thermal ellipsoids and
polyhedra. This increment adds a powder X-ray diffraction pattern calculated
from the complete periodic scientific structure. It does not require a DFT
charge-density grid or change the displayed structure.

## Scientific model

Let the rows of H be the direct lattice vectors in Å. For Miller indices h,
the reciprocal Cartesian vector is `g = inverse(H) h`, without a 2π factor.
Then `d = 1/|g|`, `s = |g|/2` and `2θ = 2 asin(λ |g|/2)`.

The complex structure factor is

```text
F(h) = Σ_j occupancy_j f_j(s) exp(-2π² gᵀ U_j g)
                       × exp(2π i h · fractional_j)
f_j(s) = Σ_(k=1..4) a_jk exp(-b_jk s²) + c_j
```

The coefficients are the unchanged neutral-atom IT92 Cromer–Mann fits for H–Cf
from Gemmi 0.7.5. Their valid range is `0 ≤ s < 2 Å⁻¹`; no normalization to
force `f(0)=Z` is applied. Unknown numeric atom types fail explicitly.
Occupancy must be finite and between zero and one. Complete Cartesian U tensors
are used when present; isotropic B converts to `U=B/(8π²)`. Missing thermal data
uses zero displacement with a note. Invalid partial or non-positive-semidefinite
tensors are not silently interpreted as valid thermal attenuation.

CPU sums use Float64 and compensated real/imaginary accumulation. The reciprocal
enumeration includes all candidates in the requested angular range, with bounds
derived from the full lattice, including skew cells. One representative of each
Friedel pair is evaluated because the nonresonant factors are real. Both pair
members contribute to multiplicity and intensity. Equal-d reflections sum
**intensities**, not amplitudes. Grouping tolerates only numerical equality;
the plotting step and Gaussian width do not merge distinct physical peaks.
Per-reflection d-spacing error bounds cover inverse-matrix and dot-product
roundoff in strongly skewed equivalent bases. A group must share an intersection
of these intervals; successive neighbors cannot chain unrelated peaks together.
Reciprocal geometry with relative squared-length uncertainty above `1e-9` is
rejected instead of returning unresolved peak positions.

Optional unpolarized powder Lorentz–polarization is
`(1+cos²(2θ))/(sin²(θ) cos(θ))`; a constant scale cancels in relative intensity.
The profile uses area-normalized Gaussians with
`σ=FWHM/sqrt(8 ln 2)`, truncated beyond eight standard deviations. Only centers
inside the requested angular range are included. Sticks and profile each have
their own maximum-100 display normalization; CSV also retains raw integrated
intensity or intensity per degree. These are model intensities in arbitrary
scale, not calibrated experimental counts.

## Parallelism and resource ownership

- A retained coordinator Worker owns source preparation, reflection enumeration,
  peak grouping, profile assembly and CSV formatting. Scientific arrays are not
  computed in the page's rendering callbacks.
- CPU reflection ranges run independently in retained Workers under the existing
  shared `CpuBudget`. Worker count follows available logical cores, work size
  and private-copy memory. Direct MessagePorts distribute prepared snapshots;
  isolated pages share immutable arrays with SharedArrayBuffer. Canonical frame
  buffers are never transferred away from the viewer.
- The WebGPU kernel splits each reflection into 512-atom chunks and reduces
  complex amplitudes in 128-lane workgroups. Atom uploads, compiled pipelines
  and bounded scratch buffers are reused. Coarse/residual fractional encoding
  and reduced-phase polynomial trigonometry limit Float32 phase loss.
- Conservative amplitude-error estimates identify uncertain weak or extinct
  reflections for cancellable Float64 recovery. More than eight million atom
  corrections with greater than 25% reflection correction density returns the
  job to parallel CPU rather than continuing large serial recovery. Unsupported values and device
  failures return to the parallel CPU path with an explicit reason. CPU host
  packing and precision checks acquire CPU permits independently of GPU waits.
- Source loading warms input ownership and GPU pipelines without enumerating
  reflections or generating scientific results. Settings edits retain compatible
  atom inputs. Source changes clear snapshots while keeping Worker objects;
  cancellation retains occupied CPU leases until acknowledgement. Cancelled
  GPU work never retries on CPU.

Explicit admission limits are 500,000 sites, 2,000,000 reciprocal candidates,
250,000 canonical reflections, 200,000,000 atom–reflection interactions,
200,001 profile samples and 50,000,000 Gaussian sample contributions. These
prevent a large MD supercell or extreme angle/wavelength choice from starting
unbounded work. A primitive cell is generally the appropriate efficient input
for an ideal crystal powder pattern.

## Integration and review

The folded Crystal section provides Cu/Co/Mo Kα1 presets, custom wavelength,
angular range, FWHM, sampling, optional thermal/LP factors, chart inspection,
paginated peak indices and full peak/profile CSV. Configurations contain only
settings. Source, parameter or geometry changes invalidate stale charts and
downloads. A frame change recalculates an enabled analysis.

Review checks specifically addressed systematic absences, actual reciprocal
geometry, near-degenerate peak separation, shared/copy ownership, cancellation
while waiting for CPU capacity, GPU host-stage admission and source-cache
revision markers. The synthetic Cu and Si examples have known Bragg positions
and are explicitly identified as ideal demonstrations.

The adapted coefficient table remains a separately marked MPL-2.0 source file;
the diffraction algorithms are original AlloyView code. Upstream source, exact
commit, license and checksums are recorded in
[Gemmi IT92 provenance](https://github.com/Yazhuo-Liu/AlloyView/blob/main/third_party/gemmi-it92/README.md).

## Validation

The independent NumPy oracle enumerates the complete ±hkl lattice and evaluates
complex amplitudes from raw frame inputs, without consuming production
reciprocal arrays. Seventeen cases cover conventional/primitive/supercell FCC,
BCC, diamond Si, NaCl, partial occupancy, Uiso, triclinic Cartesian Uij,
left-handed cells, translated origins, a 500-fold unimodular basis shear,
genuinely weak reflections, accidental overlaps and nearly degenerate peaks. The maximum
complex-amplitude difference was `2.95e-13` electrons; peak angles, multiplicities
and relative intensities agreed.

Actual WGSL execution passes twelve CPU/GPU scientific cases, including a
686-atom supercell with multiple atom workgroups. Across these cases the maximum
intensity relative error was approximately `5.21e-7`; weak and extinct rows
received exact CPU recovery. See the independent reference results in
[the recorded benchmark](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/diffraction-numpy-reference.json).

Reproducible checks:

```sh
npm test
npm run build
npm run test:gpu:diffraction
npm run test:browser:diffraction
python3 scripts/benchmarks/validate-diffraction-reference.py
sha256sum -c third_party/gemmi-it92/SHA256SUMS
```

The browser checks exercise real Worker and WebGPU execution, source loading,
known Cu/Si peaks, backend parity, parameter invalidation and complete CSV data.
This environment uses a software GPU adapter; the checks establish correctness
and lifecycle behavior, not a physical GPU speedup. A few-atom unit cell with
hundreds of reflections is a small CPU task: device dispatch and readback can
cost more than the arithmetic, so GPU mode is not a universal speedup.

Final Node 24 regression: **2,733 tests passed, zero failed, skipped or
cancelled**. The static build, production diffraction browser check, twelve
actual WGSL cases and existing Crystal browser regression passed. The production
check also verifies JSON configuration restoration, real atom replication,
mobile controls and all 4,251 default profile CSV samples. Vendored source,
adapted coefficient table and license checksum verification passed.

The first full regression caught a documentation link to an implementation page
that was not in the published guide list. The guide is now published explicitly;
the Markdown renderer also preserves external `.md` provenance URLs rather than
rewriting them to nonexistent `.html` files. A regression assertion covers this.

## Remaining scope

Anomalous dispersion, ionic form factors, neutron/electron diffraction,
orientation-dependent single-crystal detector images, texture, diffuse disorder
scattering, absorption corrections, Kα doublets and experimental refinement are
not included. The user-facing model and limits are documented in
[Crystal structures](features/crystal.md#powder-x-ray-diffraction).
