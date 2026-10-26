import { electronWavelengthFromEnergy } from './diffraction-scattering.js';

const freeze = entries => Object.freeze(entries.map(entry => Object.freeze(entry)));
export const DIFFRACTION_RADIATION_LABELS = Object.freeze({ xray: 'X-ray', electron: 'Electron', neutron: 'Neutron' });
export const DIFFRACTION_WAVELENGTH_PRESETS = Object.freeze({
  xray: freeze([
    { id: 'cu-ka1', label: 'Cu Kα₁ · 1.5406 Å', wavelength: 1.5406 },
    { id: 'co-ka1', label: 'Co Kα₁ · 1.78897 Å', wavelength: 1.78897 },
    { id: 'mo-ka1', label: 'Mo Kα₁ · 0.7093 Å', wavelength: 0.7093 },
  ]),
  electron: freeze([80,100,200,300].map(energy => ({
    id: `electron-${energy}kev`, label: `${energy} keV · ${electronWavelengthFromEnergy(energy).toPrecision(6)} Å`,
    wavelength: electronWavelengthFromEnergy(energy),
  }))),
  neutron: freeze([
    { id: 'neutron-1.8', label: '1.8 Å', wavelength: 1.8 },
    { id: 'neutron-2.36', label: '2.36 Å', wavelength: 2.36 },
  ]),
});
export const DIFFRACTION_DEFAULT_PRESETS = Object.freeze({ xray: 'cu-ka1', electron: 'electron-200kev', neutron: 'neutron-1.8' });
