# Powder diffraction — 2026-10-26

## Scope and baseline

Started from `12e13f0`, identical to the fetched remote. The existing Crystal
panel already provided CIF/POSCAR viewing, space groups, thermal ellipsoids and
polyhedra. This increment adds a powder X-ray diffraction pattern calculated
from the complete periodic scientific structure. It does not require a DFT
charge-density grid or change the displayed structure.

The following extension starts from `2429972` and adds electron and neutron
radiation modes to the same calculation, Worker, GPU and export paths. Existing
configurations without a radiation field continue to use the X-ray model.

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

## Electron and neutron extension

The structure-factor phase, occupancy, thermal attenuation and reciprocal
geometry above remain shared. Radiation selects a different amplitude model:

| Radiation | Amplitude | Source and domain | Units |
| --- | --- | --- | --- |
| X-ray | Four Gaussians plus constant | Gemmi IT92, neutral H–Cf; 0 ≤ s < 2 Å⁻¹ | electrons |
| Electron | Five Gaussians, no constant | Gemmi C4322 / International Tables C (2011), table 4.3.2.2; neutral H–Cf; 0 ≤ s ≤ 2 Å⁻¹ | Å |
| Neutron | Signed real bound coherent length, independent of s | Gemmi Neutron92 / Sears (1992); 83 elemental compositions and explicit D | fm |

Electron amplitudes use a direct published fit, not subtraction of the IT92
forward amplitude from Z followed by division by s². The latter would amplify
the X-ray fit's finite forward residual into an artificial low-angle divergence.
Electron voltage presets use `λ=hc/sqrt(E(E+2m_e c²))` with exact SI h, c, e
and the CODATA 2022 electron mass. At 200 keV this gives 0.0250793404363 Å.
The 0.1–4° default 2θ range fits the table at all four 80/100/200/300 keV presets.
The common relativistic amplitude multiplier is omitted because it cancels in
the relative pattern; raw amplitudes retain the tabulated convention.

Neutron summation retains negative b values. For example, H uses −3.739 fm
while D uses +6.671 fm. Replacing b with its magnitude would change interference.
Missing zero-coded source entries fail explicitly. Seven shorthand entries
(Tc, Pm, Ra, Pa, Np, Am, Cm) actually specify particular isotopes and are rejected
for an unspecified elemental composition. Natural Th and U are retained.
Explicit D is not converted to H for neutron calculation. In the electronic
X-ray/electron models, D uses H's neutral electronic factor while retaining its
source D label.

The optional neutron/electron random-powder Lorentz factor is
`1/(sin²(θ) cos(θ))`, without the X-ray polarization numerator. This electron
model describes an ideal random-powder angular scan; oriented TEM/SAED spots,
specimen-thickness effects, multiple scattering and detector-ring integration
require different physics/geometry. The neutron calculation includes coherent
nuclear Bragg scattering, not magnetic scattering, general isotope enrichment,
incoherent background, absorption or complex wavelength-dependent resonances.

The source cache now keys radiation and thermal mode independently. Atom arrays
are shared across radiation variants; only the small coefficient table and
model metadata change. GPU geometry remains resident, and factors are repacked
for each model. The signed GPU summation kernel is reused. Precision estimates
use absolute contribution bounds, so negative neutron factors and genuinely
weak cancellation peaks still receive reliable Float64 recovery.

The UI uses one radiation selector with mode-specific presets and valid defaults.
Shared preset definitions prevent UI/configuration wavelength drift. Switching
models cancels obsolete work and invalidates charts/CSV; restoring old recipes
retains X-ray behavior. CSV keeps its existing numerical columns and adds
radiation, scattering-model, amplitude/intensity units and geometric-correction
metadata. Mode-specific filenames distinguish electron and neutron exports.

Both new tables are pinned to Gemmi 0.7.5 under MPL-2.0 in an isolated data file.
Original headers, checksums and an offline generator are included; see
[electron/neutron provenance](https://github.com/Yazhuo-Liu/AlloyView/blob/main/third_party/gemmi-diffraction/README.md).
The NaD example is a synthetic ideal rocksalt cell for explicit-D contrast,
not an experimentally measured or DFT-predicted intensity dataset.

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

### Original X-ray increment

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
sha256sum -c third_party/gemmi-diffraction/SHA256SUMS
```

The browser checks exercise real Worker and WebGPU execution, source loading,
known Cu/Si peaks, backend parity, parameter invalidation and complete CSV data.
This environment uses a software GPU adapter; the checks establish correctness
and lifecycle behavior, not a physical GPU speedup. A few-atom unit cell with
hundreds of reflections is a small CPU task: device dispatch and readback can
cost more than the arithmetic, so GPU mode is not a universal speedup.

Original Node 24 regression: **2,733 tests passed, zero failed, skipped or
cancelled**. The static build, production diffraction browser check, twelve
actual WGSL cases and existing Crystal browser regression passed. The production
check also verifies JSON configuration restoration, real atom replication,
mobile controls and all 4,251 default profile CSV samples. Vendored source,
adapted coefficient table and license checksum verification passed.

The first full regression caught a documentation link to an implementation page
that was not in the published guide list. The guide is now published explicitly;
the Markdown renderer also preserves external `.md` provenance URLs rather than
rewriting them to nonexistent `.html` files. A regression assertion covers this.

### Electron/neutron extension

Final Node 24 regression: **2,763 tests passed, zero failed, skipped or
cancelled**. The production build and the all-mode browser check passed;
both vendored Gemmi checksum sets also passed.

The independent NumPy oracle now covers **34 cases**: 19 X-ray, eight electron
and seven neutron. All pass. Maximum complex-amplitude differences were
`2.95e-13` electrons, `5.65e-15` Å and `2.59e-14` fm, respectively. Additional
cases verify independently calculated relativistic wavelengths, signed-H
cancellation, H/D contrast, neutron/electron Lorentz factors, unequal-species
NaCl interference and identical H/D electronic amplitudes. The seven ambiguous
isotope-default exclusions were checked against the independent periodictable
dataset before exposing the natural-composition neutron model.

The actual WGSL suite passes **19 cases**, including electron low-angle/thermal
patterns and negative/weak neutron amplitudes; its maximum intensity relative
error is approximately `5.56e-7`. The production browser test exercises all three
modes on CPU and GPU, voltage presets, CSV model/units metadata, old and new
configuration restoration, physical replication, NaD/H contrast and mobile use.
These GPU measurements use a software adapter and do not establish hardware
speedup.

The peak CSV retains its original X-ray column order. Its legacy
`lorentz_polarization` flag is true only for an actual X-ray correction;
`geometry_correction` explicitly records `powder Lorentz` for corrected
electron/neutron patterns, or `none` when disabled.

Electron patterns at small wavelengths can contain many reflections even for a
small cell. GPU batches now adapt up to 4,096 reflections, bounded by two million
atom–reflection evaluations, device workgroup limits and an 8 MiB per-buffer
workspace limit. Exact corrections yield and report progress on an 8 ms time
budget instead of every 16 corrected rows. In the same retained Worker with
SwiftShader, a 300 keV, 16-Si-atom case with 29,906 reflections dropped from 468
dispatch/readback batches to eight, and from 2,637 progress messages to 27.
Measured elapsed time changed from 3,619.9 to 2,834.1 ms; all 89 peaks and 27,150
exact corrections were retained. This measures scheduling overhead on a software
adapter, not a hardware GPU throughput claim. Regression tests also exercise a
98-species frame under a 1 MiB storage-buffer limit.

## Remaining scope

Anomalous dispersion, ionic form factors, magnetic neutron diffraction,
orientation-dependent single-crystal detector images, texture, diffuse disorder
scattering, absorption corrections, Kα doublets and experimental refinement are
not included. The user-facing model and limits are documented in
[Crystal structures](features/crystal.md#powder-diffraction).
