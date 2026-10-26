# Electron and neutron scattering amplitudes

The numeric tables in `src/crystal/diffraction-scattering-data.js` are adapted
from Gemmi's `include/gemmi/c4322.hpp` and `include/gemmi/neutron92.hpp`. The
adapted data are kept in an isolated **MPL-2.0** source file. The surrounding
JavaScript helper and diffraction implementation are original AlloyView code.

- Upstream: https://github.com/project-gemmi/gemmi
- Version: **v0.7.5**, source commit
  `5cc1c23c6007e0e6cbd69289c6f7c0bff50e943e`.
- [Pinned electron source](https://github.com/project-gemmi/gemmi/blob/5cc1c23c6007e0e6cbd69289c6f7c0bff50e943e/include/gemmi/c4322.hpp),
  copyright **2020 Global Phasing Ltd.**
- [Pinned neutron source](https://github.com/project-gemmi/gemmi/blob/5cc1c23c6007e0e6cbd69289c6f7c0bff50e943e/include/gemmi/neutron92.hpp),
  copyright **2022 Global Phasing Ltd.**
- Original Source Code Form is retained as `c4322.hpp` and `neutron92.hpp`
  in this directory. Runtime adaptation is
  `src/crystal/diffraction-scattering-data.js`, distributed as readable source
  alongside the browser modules, with its copyright and license notice.
- License: `licenses/Gemmi-MPL-2.0.txt`, also distributed with the static site.

Gemmi's C++ algorithms are not compiled or required at runtime. No external
service is contacted for scattering values.

## Electron model

The coefficients reproduce *International Tables for Crystallography*, Volume C,
2011, Table 4.3.2.2, pp. 282–283: **Elastic atomic scattering factors of electrons
for neutral atoms and s up to 2.0 Å⁻¹**. This is the same table distributed by
cctbx and CCP4 as `atomsf_electron.lib`, as documented in the upstream header.

For each neutral element H through Cf, all ten original values are retained:

`fe(s) = sum(i=1..5, a_i exp(-b_i s²))`

Here `s = sin(theta)/lambda = |g|/2` in Å⁻¹ and the amplitude is in **Å**. The
layout is `[a1,a2,a3,a4,a5,b1,b2,b3,b4,b5]`, with **no constant term**. Negative
Gaussian coefficients, where present in the published fit (for example Rb),
are preserved. The public helper accepts only **0 ≤ s ≤ 2 Å⁻¹**; unsupported
angles produce an error rather than extrapolating the fit. The pseudo-element
X, Gemmi's oxygen fallback and unsupported neutral elements are not exported.
The diffraction kernel recognizes an explicit D site as a hydrogen isotope and
uses the H electronic factor in electron/X-ray modes, while preserving the D
source label. Its neutron amplitude remains the separate D value below.

This is a direct electron fit, finite at `s=0`; it does not subtract the IT92
X-ray fit from atomic number or divide a residual by `s²`. Therefore the small
nonzero residual in X-ray `f0(0)` cannot create a false forward-scattering
divergence. For example, the electron fit gives `fe_Si(0) = 5.8268 Å`.

Electron energy presets use the relativistic de Broglie wavelength:

`lambda = hc / sqrt(E(E + 2 m_e c²))`

with kinetic energy E in keV converted to joules, exact SI h, c and elementary
charge, and the [CODATA 2022 electron mass](https://physics.nist.gov/cgi-bin/cuu/Value?me)
`9.1093837139e-31 kg`. At 200 keV the wavelength is about `0.02507934 Å`, so the
fit's largest supported 2θ is about `5.75017°`. The common relativistic amplitude
multiplier is omitted; it cancels in a pattern normalized to its own maximum.
Reported amplitudes therefore retain the tabulated convention, not an absolute
electron cross section.

The powder pattern uses the **kinematical, independent neutral atom** model.
It does not model dynamical diffraction, multiple scattering, bonding/ionic
potentials, specimen thickness or an oriented electron diffraction image.

## Neutron model

The source is V. F. Sears, *Neutron News* **3**(3), 29–37 (1992), as reproduced by
the [NIST neutron scattering lengths table](https://www.ncnr.nist.gov/resources/n-lengths/list.html),
cctbx and Gemmi. Values are **signed real bound coherent nuclear scattering
lengths in femtometres (fm)**. They are independent of scattering vector in this
nonresonant model. Negative values (H, Li, Ti, V and Mn) must retain their sign
when summing the complex structure factor; taking their absolute value changes
interference and is scientifically incorrect.

The runtime supports **83 elemental entries and explicit deuterium D**. H uses
the tabulated natural-hydrogen value `-3.7390 fm`; D is explicitly deuterium and
uses `+6.671 fm`. D is never silently converted to H. Other isotope labels,
unknown element labels and missing values are rejected. The zero entries in
Gemmi's table signify unavailable values (`Neutron92::has` checks for nonzero),
so they are omitted rather than interpreted as physically zero amplitudes.

Gemmi also gives shorthand values under Tc, Pm, Ra, Pa, Np, Am and Cm. Those
entries originate from **specific isotopes**, rather than natural mixtures:
99Tc, 147Pm, 226Ra, 231Pa, 237Np, 243Am and 244Cm. This can also be checked in the
[independent periodictable 2.1.0 table](https://github.com/python-periodictable/periodictable/blob/v2.1.0/periodictable/nsf.py)
(consulted 2026-10-26). These seven original values remain in the generated
source for reproducibility, but the public helper rejects these elemental
labels with an isotope explanation. Th and U retain their tabulated elemental
values. This avoids silently assigning an arbitrary isotope to a structure
file containing only chemical element names.

Absorption and the imaginary part of coherent lengths, incoherent backgrounds,
isotope enrichment, magnetic scattering and wavelength-dependent resonances
are not included. In particular, absolute neutron intensities and strongly
absorbing/resonant samples require more than the real coherent-length model.

## Reproduction

Run `node scripts/generate-diffraction-scattering.mjs` to regenerate the data
offline from the two vendored headers. The script validates the 98 electron
rows and the complete 121-row neutron layout, then extracts all 91 nonzero
neutron source entries. The public helper additionally excludes the seven
unspecified-isotope entries described above.

```sh
sha256sum -c third_party/gemmi-diffraction/SHA256SUMS
```

Checksums cover the exact upstream sources, distributed license and generated
adaptation. Coefficients are copied without normalization or rounding.
