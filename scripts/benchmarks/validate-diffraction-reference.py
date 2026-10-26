#!/usr/bin/env python3
"""Development-only independent NumPy powder-XRD oracle (no app dependency).

Run from any directory with Python + NumPy and Node >=20 installed. Node supplies
raw fixtures, the pinned coefficient table and AlloyView's output; NumPy computes
the reciprocal lattice and full +/-hkl structure factors independently. Nothing
is read from AlloyView's prepared reciprocal arrays or enumeration code.
"""
import itertools
import json
import math
from pathlib import Path
import subprocess

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = r"""
import { calculateDiffraction } from './src/analysis/diffraction.js';
import { getXrayScatteringCoefficients } from './src/crystal/xray-scattering.js';
import { getElectronScatteringCoefficients, getNeutronScatteringLength, electronWavelengthFromEnergy } from './src/crystal/diffraction-scattering.js';
const fcc=[[0,0,0],[0,.5,.5],[.5,0,.5],[.5,.5,0]], cubic=a=>[a,0,0,0,a,0,0,0,a];
const make=(name,vectors,sites,species,types,properties=[],parameters={})=>({name,
  frame:{cell:{vectors:Float64Array.from(vectors),pbc:[true,true,true]},
    fractional:Float64Array.from(sites.flat()),types:Uint32Array.from(types??sites.map(()=>0)),typeLabels:species,
    properties:properties.map(p=>({...p,data:Float64Array.from(p.data)}))},
  parameters:{radiation:'xray',wavelength:1.5406,minAngle:5,maxAngle:120,step:.05,fwhm:.2,lorentzPolarization:true,useThermal:true,...parameters}});
const cases=[
 make('fcc-cu',cubic(3.615),fcc,['Cu']),
 make('fcc-cu-primitive',[0,3.615/2,3.615/2,3.615/2,0,3.615/2,3.615/2,3.615/2,0],[[0,0,0]],['Cu']),
 make('bcc-fe',cubic(2.866),[[0,0,0],[.5,.5,.5]],['Fe']),
 make('bcc-fe-weak',cubic(2.866),[[0,0,0],[.500001,.5,.5]],['Fe']),
 make('diamond-si',cubic(5.431),[...fcc,...fcc.map(s=>s.map(x=>x+.25))],['Si']),
 make('rocksalt-nacl',cubic(5.64),[...fcc,...fcc.map(s=>s.map((x,i)=>(x+(i===0?.5:0))%1))],['Na','Cl'],[0,0,0,0,1,1,1,1]),
 make('partial-occupancy-cu',cubic(3.615),fcc,['Cu'],null,[{name:'occupancy',data:[.5,.5,.5,.5]}]),
 make('isotropic-cu',cubic(3.615),fcc,['Cu'],null,[{name:'Uiso',data:[.01,.01,.01,.01]}]),
 make('triclinic',[3.7,.3,.1,-1.2,4.6,.2,.6,-.8,5.1],[[.13,.21,.37],[.6,.4,.17],[.18,.74,.66],[.8,.2,.9]],['Na','Cl','Cu','O'],[0,1,2,3],
  [{name:'occupancy',data:[.5,1,.3,.8]},...['xx','yy','zz','xy','xz','yz'].map((s,i)=>({name:'displacementU'+s,data:[.01,.02,.03,.04].map(v=>i<3?v*(i+1):v*.1)}))]),
 make('near-degenerate',[4,0,0,0,4*(1+1e-9),0,0,0,6],[[.17,.31,.27]],['O']),
 make('accidental-overlap',[4,0,0,0,4,0,0,0,6],[[.13,.21,.37],[.6,.4,.17]],['Cu','O'],[0,1]),
 make('uncorrected-pattern',cubic(3.615),fcc,['Cu'],null,[{name:'Uiso',data:[.01,.01,.01,.01]}],{useThermal:false,lorentzPolarization:false}),
 make('sc-cu',cubic(3.615),[[0,0,0]],['Cu'],null,[],{maxAngle:90}),
 make('sc-cu-unimodular-shear',[3.615,0,0,500*3.615,3.615,0,0,0,3.615],[[0,0,0]],['Cu'],null,[],{maxAngle:90}),
 make('left-handed',[3.7,.3,.1,-1.2,4.6,.2,-.6,.8,-5.1],[[.13,.21,.37],[.6,.4,.17]],['Si','O'],[0,1]),
];
const base=cases[0], copies=[];
for(let z=0;z<1;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++)for(const site of fcc)copies.push([(site[0]+x)/2,(site[1]+y)/2,site[2]]);
cases.push(make('fcc-cu-supercell',[7.23,0,0,0,7.23,0,0,0,3.615],copies,['Cu']));
cases.push(make('translated-cu',cubic(3.615),fcc.map(s=>s.map((x,i)=>x+[.123,.337,-.29][i])),['Cu']));
const electron={radiation:'electron',wavelength:electronWavelengthFromEnergy(200),minAngle:.1,maxAngle:4,step:.005,fwhm:.03};
const neutron={radiation:'neutron',wavelength:1.8,minAngle:5,maxAngle:120};
const copyCase=(name,source,parameters)=>({...source,name,parameters:{...source.parameters,...parameters}});
cases.push(copyCase('electron-fcc-cu',cases.find(item=>item.name==='fcc-cu'),electron));
cases.push(copyCase('electron-80keV-cu',cases.find(item=>item.name==='fcc-cu'),{...electron,wavelength:electronWavelengthFromEnergy(80)}));
cases.push(copyCase('electron-300keV-cu',cases.find(item=>item.name==='fcc-cu'),{...electron,wavelength:electronWavelengthFromEnergy(300)}));
cases.push(copyCase('electron-rocksalt-nacl',cases.find(item=>item.name==='rocksalt-nacl'),electron));
cases.push(copyCase('electron-triclinic-thermal',cases.find(item=>item.name==='triclinic'),electron));
cases.push(copyCase('electron-lorentz-off',cases.find(item=>item.name==='rocksalt-nacl'),{...electron,lorentzPolarization:false}));
cases.push(copyCase('neutron-fcc-cu',cases.find(item=>item.name==='fcc-cu'),neutron));
cases.push(copyCase('neutron-rocksalt-nacl',cases.find(item=>item.name==='rocksalt-nacl'),neutron));
cases.push(copyCase('neutron-triclinic-thermal',cases.find(item=>item.name==='triclinic'),neutron));
cases.push(make('neutron-signed-H-cancellation',cubic(4),[[0,0,0],[.5,.5,.5]],['H','O'],[0,1],
 [{name:'occupancy',data:[1,3.739/5.803]}],neutron));
cases.push(make('neutron-hydride',cubic(4),[[0,0,0],[.5,.5,.5]],['Ti','H'],[0,1],[],neutron));
cases.push(make('neutron-deuteride',cubic(4),[[0,0,0],[.5,.5,.5]],['Ti','D'],[0,1],[],neutron));
cases.push(copyCase('neutron-lorentz-off',cases.find(item=>item.name==='rocksalt-nacl'),{...neutron,lorentzPolarization:false}));
for(const isotope of ['hydride','deuteride']){
 const source=cases.find(item=>item.name==='neutron-'+isotope);
 cases.push(copyCase('xray-'+isotope,source,{radiation:'xray'}));
 cases.push(copyCase('electron-'+isotope,source,electron));
}
const coefficientsFor=(radiation,symbol)=>radiation==='electron'?getElectronScatteringCoefficients(symbol==='D'?'H':symbol)
 :radiation==='neutron'?[getNeutronScatteringLength(symbol)]:getXrayScatteringCoefficients(symbol==='D'?'H':symbol);
const data=cases.map(item=>({...item,coefficients:item.frame.typeLabels.map(symbol=>coefficientsFor(item.parameters.radiation,symbol)),result:calculateDiffraction(item.frame,item.parameters)}));
console.log(JSON.stringify(data,(_key,value)=>ArrayBuffer.isView(value)?Array.from(value):value));
"""


def oracle(case):
    frame, parameters = case['frame'], case['parameters']
    lattice = np.asarray(frame['cell']['vectors']).reshape(3, 3)
    sites = np.asarray(frame['fractional']).reshape(-1, 3)
    species = np.asarray(frame['types'], dtype=int)
    props = {p['name']: np.asarray(p['data']) for p in frame['properties']}
    count = len(sites)
    occupancy = props.get('occupancy', np.ones(count))
    covariance = np.zeros((count, 3, 3))
    if parameters['useThermal']:
        if 'displacementUxx' in props:
            for key, (i, j) in zip(('xx', 'yy', 'zz', 'xy', 'xz', 'yz'), ((0,0),(1,1),(2,2),(0,1),(0,2),(1,2))):
                covariance[:,i,j] = covariance[:,j,i] = props['displacementU'+key]
        else:
            u = props.get('Uiso', props.get('Biso', np.zeros(count)) / (8 * np.pi**2))
            for i in range(3): covariance[:,i,i] = u
    coefficients = np.asarray(case['coefficients'])
    wavelength = parameters['wavelength']
    q_max = 2 * np.sin(np.deg2rad(parameters['maxAngle'] / 2)) / wavelength
    # Deliberately overscan beyond the mathematical bounds and enumerate both
    # Friedel partners, independently of the production half-sphere search.
    extents = np.ceil(q_max * np.linalg.norm(lattice, axis=1)).astype(int) + 2
    rows = np.asarray(list(itertools.product(*(range(-n,n+1) for n in extents))), dtype=int)
    rows = rows[np.any(rows != 0, axis=1)]
    reciprocal = rows @ np.linalg.inv(lattice).T
    q = np.linalg.norm(reciprocal, axis=1)
    valid = wavelength*q/2 < 1
    rows, reciprocal, q = rows[valid], reciprocal[valid], q[valid]
    angles = np.rad2deg(2*np.arcsin(wavelength*q/2))
    valid = (angles >= parameters['minAngle'] - 1e-11) & (angles <= parameters['maxAngle'] + 1e-11)
    rows, reciprocal, q, angles = rows[valid], reciprocal[valid], q[valid], angles[valid]
    s2 = q*q/4
    radiation = parameters.get('radiation', 'xray')
    if radiation == 'electron':
        f = np.sum(coefficients[None,:,0:5] * np.exp(-s2[:,None,None] * coefficients[None,:,5:10]), axis=2)
    elif radiation == 'neutron':
        f = np.broadcast_to(coefficients[:,0], (len(s2),len(coefficients)))
    else:
        f = np.sum(coefficients[None,:,0:4] * np.exp(-s2[:,None,None] * coefficients[None,:,4:8]), axis=2) + coefficients[None,:,8]
    weights = f[:,species] * occupancy[None,:]
    weights *= np.exp(-2*np.pi**2 * np.einsum('ri,aij,rj->ra',reciprocal,covariance,reciprocal))
    amplitudes = np.sum(weights*np.exp(2j*np.pi*(rows@sites.T)),axis=1)
    intensities = np.abs(amplitudes)**2
    bound = np.sum(np.abs(weights),axis=1)
    # Machine-level cancellation only, not a display-intensity cutoff.
    valid = np.abs(amplitudes) > bound * 1e-12
    lp = np.ones(len(angles))
    if parameters['lorentzPolarization']:
        theta = np.deg2rad(angles/2)
        polarization = 1+np.cos(2*theta)**2 if radiation == 'xray' else 1
        lp = polarization/(np.sin(theta)**2*np.cos(theta))
    peaks = []
    for index in np.argsort(angles):
        if not valid[index]: continue
        angle, intensity = angles[index], intensities[index]*lp[index]
        if not peaks or abs(angle-peaks[-1][0]) > 1e-11:
            peaks.append([angle,intensity,1])
        else:
            peaks[-1][1] += intensity
            peaks[-1][2] += 1
    result = case['result']
    actual_rows = np.asarray(result['reflections']['hkls']).reshape(-1,3)
    lookup = {tuple(hkl): i for i,hkl in enumerate(rows)}
    assert len(actual_rows)*2 == len(rows), f"{case['name']}: missing reciprocal candidates"
    indices = [lookup[tuple(hkl)] for hkl in actual_rows]
    np.testing.assert_allclose(result['reflections']['twoTheta'],angles[indices],rtol=3e-13,atol=2e-11)
    np.testing.assert_allclose(result['reflections']['dSpacing'],1/q[indices],rtol=3e-13,atol=2e-13)
    actual = np.asarray(result['reflections']['real']) + 1j*np.asarray(result['reflections']['imag'])
    np.testing.assert_allclose(actual,amplitudes[indices],rtol=3e-11,atol=2e-10)
    assert len(result['peaks']) == len(peaks), f"{case['name']}: {len(result['peaks'])} != {len(peaks)} powder groups"
    np.testing.assert_allclose([p['twoTheta'] for p in result['peaks']],[p[0] for p in peaks],rtol=3e-13,atol=2e-11)
    np.testing.assert_allclose([p['intensity'] for p in result['peaks']],[p[1] for p in peaks],rtol=2e-10,atol=1e-8)
    np.testing.assert_array_equal([p['multiplicity'] for p in result['peaks']],[p[2] for p in peaks])
    return {'name':case['name'],'radiation':radiation,'fullReflections':len(rows),'powderPeaks':len(peaks),
            'maxAmplitudeError':float(np.max(np.abs(actual-amplitudes[indices]), initial=0)),
            'amplitudeUnit':{'xray':'electrons','electron':'angstrom','neutron':'fm'}[radiation]}


def main():
    process = subprocess.run(['node','--input-type=module'],input=BRIDGE,text=True,cwd=ROOT,capture_output=True,check=True)
    cases = json.loads(process.stdout)
    reports = [oracle(case) for case in cases]
    baseline = np.asarray([p['relativeIntensity'] for p in cases[0]['result']['peaks']])
    for name in ('fcc-cu-primitive','fcc-cu-supercell','translated-cu','partial-occupancy-cu'):
        case = next(item for item in cases if item['name']==name)
        np.testing.assert_allclose([p['relativeIntensity'] for p in case['result']['peaks']],baseline,rtol=2e-11,atol=1e-10)
    cubic = next(item for item in cases if item['name']=='sc-cu')
    sheared = next(item for item in cases if item['name']=='sc-cu-unimodular-shear')
    np.testing.assert_allclose([p['twoTheta'] for p in sheared['result']['peaks']],
                               [p['twoTheta'] for p in cubic['result']['peaks']],rtol=2e-12,atol=1e-10)
    np.testing.assert_allclose([p['relativeIntensity'] for p in sheared['result']['peaks']],
                               [p['relativeIntensity'] for p in cubic['result']['peaks']],rtol=2e-12,atol=1e-10)
    # SI de Broglie reference, evaluated in the momentum form rather than the
    # production hc/sqrt(E(E+2mc²)) arrangement. Values use CODATA 2022 m_e.
    wavelengths = {}
    for name, energy_kev in [('electron-80keV-cu',80),('electron-fcc-cu',200),('electron-300keV-cu',300)]:
        energy_joule = energy_kev * 1000 * 1.602176634e-19
        wavelength = 6.62607015e-34 / math.sqrt(2 * 9.1093837139e-31 * energy_joule
            * (1 + energy_joule / (2 * 9.1093837139e-31 * 299792458**2))) * 1e10
        case = next(item for item in cases if item['name']==name)
        np.testing.assert_allclose(case['parameters']['wavelength'],wavelength,rtol=3e-15,atol=0)
        wavelengths[str(energy_kev)] = wavelength

    def intensity(case_name, hkl):
        case = next(item for item in cases if item['name']==case_name)
        reflections = case['result']['reflections']
        index = np.flatnonzero(np.all(np.asarray(reflections['hkls']).reshape(-1,3)==hkl,axis=1))[0]
        return reflections['intensity'][index]

    contrast = {radiation: intensity(name,[1,1,1])/intensity(name,[2,0,0]) for radiation,name in
        [('xray','rocksalt-nacl'),('electron','electron-rocksalt-nacl'),('neutron','neutron-rocksalt-nacl')]}
    assert min(abs(a-b) for a,b in itertools.combinations(contrast.values(),2)) > .01
    hydride = intensity('neutron-hydride',[1,0,0])/intensity('neutron-hydride',[1,1,0])
    deuteride = intensity('neutron-deuteride',[1,0,0])/intensity('neutron-deuteride',[1,1,0])
    assert deuteride > 1000 * hydride
    signed = next(item for item in cases if item['name']=='neutron-signed-H-cancellation')
    assert all(sum(hkl) % 2 for peak in signed['result']['peaks'] for hkl in peak['hkls'])
    for radiation in ['xray','electron']:
        hydrogen = next(item for item in cases if item['name']==radiation+'-hydride')
        deuterium = next(item for item in cases if item['name']==radiation+'-deuteride')
        np.testing.assert_array_equal(hydrogen['result']['reflections']['intensity'],deuterium['result']['reflections']['intensity'])
    print(json.dumps({'oracle':'NumPy full +/-hkl enumeration and complex sums','cases':reports,
                      'normalizedPrimitiveSupercellTranslationOccupancyParity':True,
                      'largeUnimodularBasisParity':True,'electronWavelength_A_by_keV':wavelengths,
                      'NaClRaw111To200IntensityRatio':contrast,
                      'TiH_Raw100To110IntensityRatio':hydride,'TiD_Raw100To110IntensityRatio':deuteride,
                      'signedHydrogenCancellationPreserved':True,'deuteriumElectronicFactorEqualsHydrogen':True},indent=2))


if __name__ == '__main__': main()
