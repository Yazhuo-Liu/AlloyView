# Analytic volumetric examples

These are synthetic, analytically defined format and rendering examples. They
are **not results of a DFT calculation** and must not be interpreted as an
electronic structure prediction. Both files and their generator are original
project fixtures, with no external data license dependency.

- `CHGCAR`: a 6 Å cubic periodic cell with two H sites at reduced coordinates
  (0.25, 0.25, 0.25) and (0.75, 0.75, 0.75). A 32³ grid samples a sum of two
  Gaussian peaks, σ = 0.45 Å, using nearest periodic distances. Values are
  normalized so that `sum(raw)/32³ = 2` electrons. The density shown by the
  viewer is `raw/216` e/Å³. Try an isovalue near 0.1 e/Å³.
- `analytic-p-field.cube`: a 33³ open grid from −4 to 4 Å, containing the
  signed function `x exp(-(x²+y²+z²)/2)` in arbitrary file units. One C marker
  atom is at the origin. This illustrates positive and negative lobes, without
  claiming a normalized wavefunction. Try isovalues +0.2 and −0.2.

Run `node examples/volumetric/generate.mjs` from the repository to reproduce
both files. CHGCAR values use x-fastest order; Cube values use z-fastest order.

Format references:

- [VASP CHGCAR](https://www.vasp.at/wiki/index.php/CHGCAR)
- [VASP LOCPOT](https://www.vasp.at/wiki/index.php/LOCPOT)
- [VASP ELFCAR](https://www.vasp.at/wiki/index.php/ELFCAR)
- [Gaussian Cube format overview](https://paulbourke.net/dataformats/cube/)

Cube does not reliably declare the physical unit of the scalar values. The
viewer preserves these values and explicitly labels them as file units; its
Bohr/Å coordinate conversion does not rescale scalar data.
