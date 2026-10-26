# moyo crystallography runtime

AlloyView vendors the official `@spglib/moyo-wasm` package **0.21.0** from the
spglib organization, rather than implementing approximate space-group matching.

- Upstream: https://github.com/spglib/moyo
- Source tag: `v0.21.0`
- Source commit: `cddc447a4b6041c05c8aa81ac7cfe5330a847638`
- Published package: https://registry.npmjs.org/@spglib/moyo-wasm/-/moyo-wasm-0.21.0.tgz
- npm integrity: `sha512-VP9B0VbzzdP5ZSUkMzSQj3T7SmhGxFHWZm0GyNidTesfuX+wIvu15l4EcwSlLPYkFyGXC6S6kAd2nObCvASk2w==`
- License: **MIT OR Apache-2.0**; both original texts are in `licenses/`.
- Copyright: 2023 Kohei Shinohara.

`src/crystal/vendor/moyo/moyo_wasm.js` and `moyo_wasm_bg.wasm` are the unmodified
published browser runtime. The upstream declarations and README are retained
here. `SHA256SUMS` identifies the exact vendored runtime and generated database.

`node scripts/generate-space-groups.mjs` regenerates the synchronous CIF database
using this same pinned WASM. It covers all 230 ordinary space-group types and
530 Hall coordinate settings, including axis and origin choices. Generator
operations are converted from column-major rotations to safe CIF xyz expressions.
Moyo's documented internal `=`/`^` Hall-axis notation is rendered as the standard
double/single quote characters. The database contains no magnetic space groups.

The runtime identifies the symmetry of an ordered periodic structure using f64
coordinates and tolerance in ångströms. Standardized output is symmetry-refined,
not an exact no-op basis transformation. AlloyView exports it as a separate frame;
it never changes the loaded structure implicitly or fabricates a mapping for
source atom IDs, ADPs, velocities or other per-atom properties. Disordered and
partially occupied structures must first be resolved into an ordered model.

One retained CPU Worker keeps its WASM module and memory between calls. The
global native search cannot be divided into independent per-atom GPU jobs; it
shares the application CPU budget and remains off the page thread. Ordinary
cancellation rejects the UI request immediately but retains the computation
permit until native completion. Unit-cell input is bounded to 20,000 sites and
a stalled operation is terminated after two minutes, with a fresh Worker on retry.
