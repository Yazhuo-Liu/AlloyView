// Reproduce the two analytic (not DFT-calculated) visual examples.
import { writeFile } from 'node:fs/promises';

const rows = values => Array.from({ length: Math.ceil(values.length / 6) }, (_, index) =>
  values.slice(index * 6, index * 6 + 6).map(value => value.toExponential(12)).join(' ')).join('\n');
const n = 32, length = 6, sigma = .45, centers = [.25, .75];
const charge = [];
for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
  charge.push(centers.reduce((sum, center) => {
    const r2 = [x, y, z].reduce((total, coordinate) => {
      const delta = coordinate / n - center, wrapped = delta - Math.round(delta);
      return total + (wrapped * length) ** 2;
    }, 0);
    return sum + Math.exp(-r2 / (2 * sigma ** 2));
  }, 0));
}
const norm = 2 * n ** 3 / charge.reduce((sum, value) => sum + value, 0);
const chgcar = ['Analytic two-site Gaussian charge density (synthetic, not DFT)', '1',
  '6 0 0', '0 6 0', '0 0 6', 'H', '2', 'Direct', '.25 .25 .25', '.75 .75 .75', '',
  `${n} ${n} ${n}`, rows(charge.map(value => value * norm)), ''].join('\n');
await writeFile(new URL('CHGCAR', import.meta.url), chgcar);

const orbital = [], points = 33, step = .25;
for (let x = 0; x < points; x++) for (let y = 0; y < points; y++) for (let z = 0; z < points; z++) {
  const a = -4 + x * step, b = -4 + y * step, c = -4 + z * step;
  orbital.push(a * Math.exp(-(a * a + b * b + c * c) / 2));
}
const cube = ['Analytic p-like signed field (synthetic, not a calculated orbital)',
  'Values: x exp(-(x*x+y*y+z*z)/2), arbitrary units; coordinates in angstrom',
  '1 -4 -4 -4', '-33 .25 0 0', '-33 0 .25 0', '-33 0 0 .25', '6 6 0 0 0', rows(orbital), ''].join('\n');
await writeFile(new URL('analytic-p-field.cube', import.meta.url), cube);
