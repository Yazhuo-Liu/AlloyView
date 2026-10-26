# Neutral-atom X-ray scattering factors

The numeric table in `src/crystal/xray-scattering-data.js` is adapted from the
neutral-atom rows of Gemmi's `include/gemmi/it92.hpp`. It is kept as a separate
**MPL-2.0** source file; the surrounding diffraction implementation is original
AlloyView code. Both the original source and the adapted source are available.

- Upstream: https://github.com/project-gemmi/gemmi
- Version: **v0.7.5**
- Source commit: `5cc1c23c6007e0e6cbd69289c6f7c0bff50e943e`
- Pinned source: https://github.com/project-gemmi/gemmi/blob/5cc1c23c6007e0e6cbd69289c6f7c0bff50e943e/include/gemmi/it92.hpp
- Original copyright: **2019 Global Phasing Ltd.**
- Original license: `licenses/Gemmi-MPL-2.0.txt`, distributed with the static site.
- Local original Source Code Form: `third_party/gemmi-it92/it92.hpp`.
- Runtime adaptation: `src/crystal/xray-scattering-data.js`, also published as
  readable source alongside the application's browser modules.

## Scientific convention

Gemmi identifies the source as *International Tables for Crystallography*,
Volume C (1992 or later), the same IT1992 table used by CCP4 and cctbx. These
Cromer–Mann coefficients approximate the nonresonant elastic X-ray amplitude:

`f0(s) = a1 exp(-b1 s²) + a2 exp(-b2 s²) + a3 exp(-b3 s²) + a4 exp(-b4 s²) + c`

Here `s = sin(theta)/lambda = |g|/2`, in Å⁻¹; the amplitude is in electron units.
The documented fit range is **0 ≤ s < 2 Å⁻¹**. The nine published coefficients
are copied unchanged for the 98 neutral elements H through Cf. Gemmi's optional
renormalization to force `f0(0) = Z` is not applied. The unused pseudo-element
`X` (which Gemmi aliases to oxygen), ionic rows and unknown-species fallbacks are
intentionally omitted. Anomalous dispersion corrections `f′`/`f″`, absorption,
and wavelength-dependent resonant effects are not supplied by this table.

The calculated pattern is therefore a neutral-atom, nonresonant kinematic
approximation. It is not a prediction of ionic charge states or a substitute for
experimental intensity corrections.

## Reproduction

Run `node scripts/generate-xray-scattering.mjs` to regenerate the table from the
vendored source without network access. It validates element order, all 98 rows
and the nine-column layout, and writes `SHA256SUMS`. Verify the exact upstream
source, license and generated output with:

```sh
sha256sum -c third_party/gemmi-it92/SHA256SUMS
```

The only adaptation is extraction of the neutral rows and translation of their
numeric arrays into immutable JavaScript data. Gemmi's computational C++ code
is not compiled into AlloyView or used as a runtime dependency.
