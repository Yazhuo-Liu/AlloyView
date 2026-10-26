import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const production = process.argv.includes('--production');
const artifacts = '/tmp/alloyview-diffraction-tools';
await mkdir(artifacts, { recursive: true });
const cif = `data_Cu\n_cell_length_a 3.615\n_cell_length_b 3.615\n_cell_length_c 3.615\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_space_group_IT_number 225\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\nCu1 Cu 0 0 0 1\n`;

const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  async function waitFor(expression, label, timeout = 90_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
    throw new Error(`${label}: ${JSON.stringify(await evaluate(`({state:document.getElementById('diffraction-state')?.textContent,status:document.getElementById('diffraction-status')?.textContent,toast:document.getElementById('toast')?.textContent})`))}`);
  }
  await waitFor('document.readyState === "complete" && document.getElementById("run-diffraction")', 'diffraction UI');
  await evaluate(`(async () => {
    const app=document.querySelector('script[type="module"]').src;
    const {DiffractionClient}=await import(new URL('./analysis/diffraction-client.js',app));
    const analyze=DiffractionClient.prototype.analyze;
    window.diffractionChecks={results:[],downloads:[],jobs:0};
    DiffractionClient.prototype.analyze=async function(...args){diffractionChecks.jobs++;const r=await analyze.apply(this,args);diffractionChecks.results.push(r);return r;};
    const blobs=new Map(),create=URL.createObjectURL;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);blobs.set(url,blob);return url;};
    HTMLAnchorElement.prototype.click=function(){const blob=blobs.get(this.href);if(blob)diffractionChecks.downloads.push({blob,filename:this.download});};
  })()`);
  async function load(text, name) {
    await evaluate(`(() => {const data=new DataTransfer();data.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)}));const input=document.getElementById('file-input');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(name)} && document.getElementById('loading').hidden && !document.getElementById('run-diffraction').disabled`, 'load crystal');
  }
  async function change(id, value) {
    await evaluate(`(() => {const input=document.getElementById(${JSON.stringify(id)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function press(id) {
    const point=await evaluate(`(() => {const e=document.getElementById(${JSON.stringify(id)});e.scrollIntoView({block:'center'});
      const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
      return {x,y,reachable:!e.disabled&&(hit===e||e.contains(hit))};})()`);
    assert.ok(point.reachable, `reachable ${id}`);
    for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',
      {type,x:point.x,y:point.y,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
  }
  async function run() {
    const previous = await evaluate('diffractionChecks.results.length');
    await press('run-diffraction');
    await waitFor(`document.getElementById('diffraction-state').textContent==='Calculated' && diffractionChecks.results.length>${previous}`, 'diffraction calculation');
    return evaluate(`(() => {const r=diffractionChecks.results.at(-1);return {backend:r.backend,workerCount:r.workerCount,peaks:r.peaks,parameters:r.parameters,scatteringModel:r.scatteringModel,scatteringUnits:r.scatteringUnits,elapsedMs:r.elapsedMs,profileCount:r.profile.twoTheta.length};})()`);
  }
  async function gpuEnabled(enabled) {
    await evaluate(`if((document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')!==${enabled})document.getElementById('enable-gpu-computing').click()`);
  }
  function parity(actual,expected) {
    assert.equal(actual.peaks.length,expected.peaks.length);
    for(let i=0;i<actual.peaks.length;i++) {
      assert.ok(Math.abs(actual.peaks[i].twoTheta-expected.peaks[i].twoTheta)<1e-8);
      assert.ok(Math.abs(actual.peaks[i].relativeIntensity-expected.peaks[i].relativeIntensity)<.02);
    }
  }
  async function download(id) {
    const count = await evaluate('diffractionChecks.downloads.length');
    await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    await waitFor(`diffractionChecks.downloads.length>${count}`, `download ${id}`);
    return evaluate('(async()=>{const d=diffractionChecks.downloads.at(-1);return {filename:d.filename,text:await d.blob.text()};})()');
  }
  await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')document.getElementById('enable-gpu-computing').click()`);
  await load(cif, 'Cu-powder.cif');
  assert.equal(await evaluate('document.getElementById("diffraction-controls").open'), false);
  await evaluate(`document.querySelector('[data-tool-button="crystal"]').click();document.getElementById('diffraction-controls').open=true`);
  const cpu = await run();
  assert.match(cpu.backend, /cpu/i); assert.ok(cpu.peaks.length >= 4); assert.ok(cpu.profileCount > 1000);
  for (const [i, squared] of [3, 4, 8].entries()) {
    const expected = 2 * Math.asin(1.5406 * Math.sqrt(squared) / (2 * 3.615)) * 180 / Math.PI;
    assert.ok(Math.abs(cpu.peaks[i].twoTheta - expected) < 1e-8, `Cu peak ${i}: ${cpu.peaks[i].twoTheta} vs ${expected}`);
  }
  assert.equal(await evaluate('document.querySelectorAll("#diffraction-chart svg path").length>=3'), true);
  assert.ok((await evaluate('document.getElementById("diffraction-table-body").children.length')) > 0);
  const peaks = await download('export-diffraction-peaks'), profile = await download('export-diffraction-profile');
  assert.match(peaks.text, /two.?theta|2theta|2θ/i); assert.match(peaks.text, /hkl|miller/i);
  assert.equal(profile.text.trim().split(/\r?\n/).length, cpu.profileCount + 1);
  await writeFile(`${artifacts}/${peaks.filename}`, peaks.text); await writeFile(`${artifacts}/${profile.filename}`, profile.text);
  const beforeProbe = await evaluate('diffractionChecks.jobs');
  await evaluate(`const slider=document.getElementById('diffraction-peak-slider');slider.value='1';slider.dispatchEvent(new Event('input',{bubbles:true}))`);
  assert.match(await evaluate('document.getElementById("diffraction-probe").textContent'), /Peak 2/);
  assert.equal(await evaluate('diffractionChecks.jobs'), beforeProbe, 'chart inspection does not recompute');
  await evaluate('document.getElementById("enable-gpu-computing").click()');
  const gpu = await run();
  assert.match(gpu.backend, /gpu/i); assert.equal(gpu.peaks.length, cpu.peaks.length);
  for (let i = 0; i < cpu.peaks.length; i++) {
    assert.ok(Math.abs(gpu.peaks[i].twoTheta - cpu.peaks[i].twoTheta) < 1e-10);
    assert.ok(Math.abs(gpu.peaks[i].relativeIntensity - cpu.peaks[i].relativeIntensity) < .02);
  }
  await change('diffraction-preset', 'mo-ka1');
  assert.equal(await evaluate('document.getElementById("export-diffraction-peaks").disabled'), true);
  assert.equal(await evaluate('document.getElementById("diffraction-results").hidden'), true);
  const molybdenum = await run(); assert.ok(molybdenum.peaks[0].twoTheta < cpu.peaks[0].twoTheta);
  await change('diffraction-wavelength', '0');
  assert.equal(await evaluate('document.getElementById("export-diffraction-peaks").disabled'), true);
  await change('diffraction-preset', 'cu-ka1'); await run();
  const configuration=await download('export-configuration');
  const recipe=JSON.parse(configuration.text);
  assert.equal(recipe.settings.extensions.diffraction.enabled,true);
  assert.equal(recipe.settings.extensions.diffraction.wavelengthPreset,'cu-ka1');
  assert.equal(recipe.settings.extensions.diffraction.peaks,undefined,'configuration contains settings only');
  await change('diffraction-preset','co-ka1');
  await evaluate(`(() => {const d=new DataTransfer();d.items.add(new File([${JSON.stringify(configuration.text)}],'xrd-settings.json'));
    const input=document.getElementById('configuration-file');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored') && document.getElementById('diffraction-state').textContent==='Calculated'`,'restore diffraction settings');
  assert.equal(await evaluate('document.getElementById("diffraction-preset").value'),'cu-ka1');
  await evaluate(`document.getElementById('diffraction-controls').open=true;document.getElementById('diffraction-chart').scrollIntoView({block:'center'})`);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(`${artifacts}/diffraction-ui.png`, Buffer.from(screenshot.data, 'base64'));
  await evaluate('document.getElementById("cancel-diffraction").click()');
  assert.equal(await evaluate('document.getElementById("diffraction-results").hidden'), true);
  await load(await readFile(new URL('../../examples/crystals/POSCAR-Si-diffraction', import.meta.url), 'utf8'), 'POSCAR-Si-diffraction');
  assert.equal(await evaluate('document.getElementById("export-diffraction-peaks").disabled'), true);
  const silicon = await run();
  assert.ok(Math.abs(silicon.peaks[0].twoTheta - 28.442) < .02);
  const priorReplication=await evaluate('diffractionChecks.results.length');
  await change('replicate-a','2');
  await evaluate(`const rep=document.getElementById('replicate-atoms');rep.checked=true;rep.dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('apply-replicate').click()`);
  await waitFor(`document.getElementById('atom-count').textContent==='16' && document.getElementById('diffraction-state').textContent==='Calculated' && diffractionChecks.results.length>${priorReplication}`,'physical replication updates diffraction');
  const replicated=await evaluate('diffractionChecks.results.at(-1).peaks');
  assert.equal(replicated.length,silicon.peaks.length);
  for(let i=0;i<replicated.length;i++) {
    assert.ok(Math.abs(replicated[i].twoTheta-silicon.peaks[i].twoTheta)<1e-8);
    assert.ok(Math.abs(replicated[i].relativeIntensity-silicon.peaks[i].relativeIntensity)<.02);
  }
  await change('diffraction-radiation','electron');
  assert.equal(await evaluate('document.getElementById("diffraction-results").hidden'),true);
  assert.equal(await evaluate('document.getElementById("export-diffraction-peaks").disabled'),true);
  assert.equal(await evaluate('document.getElementById("diffraction-preset").value'),'electron-200kev');
  await gpuEnabled(false);
  const electronCpu=await run();
  assert.equal(electronCpu.parameters.radiation,'electron');
  assert.equal(electronCpu.scatteringUnits,'Å');
  assert.ok(Math.abs(electronCpu.parameters.wavelength-.0250793404363)<1e-12);
  const electronAngle=2*Math.asin(electronCpu.parameters.wavelength*Math.sqrt(3)/(2*5.431))*180/Math.PI;
  assert.ok(Math.abs(electronCpu.peaks[0].twoTheta-electronAngle)<1e-8);
  await gpuEnabled(true);
  const electronGpu=await run();assert.equal(electronGpu.backend,'gpu');parity(electronGpu,electronCpu);
  await change('diffraction-preset','electron-80kev');const electron80=await run();
  assert.ok(electron80.peaks[0].twoTheta>electronCpu.peaks[0].twoTheta);
  await change('diffraction-preset','electron-300kev');const electron300=await run();
  assert.ok(electron300.peaks[0].twoTheta<electronCpu.peaks[0].twoTheta);
  const electronCsv=await download('export-diffraction-peaks');
  assert.match(electronCsv.filename,/electron/);assert.match(electronCsv.text,/radiation/);assert.match(electronCsv.text,/electron/);
  await writeFile(`${artifacts}/${electronCsv.filename}`,electronCsv.text);
  await evaluate('document.getElementById("diffraction-chart").scrollIntoView({block:"center"})');
  const electronImage=await call('Page.captureScreenshot',{format:'png'});
  await writeFile(`${artifacts}/diffraction-electron.png`,Buffer.from(electronImage.data,'base64'));

  await change('diffraction-radiation','neutron');
  await gpuEnabled(false);const neutronCpu=await run();
  assert.equal(neutronCpu.parameters.radiation,'neutron');assert.equal(neutronCpu.parameters.wavelength,1.8);
  assert.equal(neutronCpu.scatteringUnits,'fm');
  await gpuEnabled(true);const neutronGpu=await run();assert.equal(neutronGpu.backend,'gpu');parity(neutronGpu,neutronCpu);
  const neutronProfile=await download('export-diffraction-profile');
  assert.match(neutronProfile.filename,/neutron/);assert.match(neutronProfile.text,/neutron/);
  const neutronRecipe=await download('export-configuration');
  assert.equal(JSON.parse(neutronRecipe.text).settings.extensions.diffraction.radiation,'neutron');
  await change('diffraction-radiation','electron');
  await evaluate(`(() => {const d=new DataTransfer();d.items.add(new File([${JSON.stringify(neutronRecipe.text)}],'neutron-settings.json'));
    const input=document.getElementById('configuration-file');input.files=d.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor(`document.getElementById('configuration-status').textContent.startsWith('Configuration restored') && document.getElementById('diffraction-state').textContent==='Calculated' && document.getElementById('diffraction-radiation').value==='neutron'`,'restore neutron settings');

  const deuteride=await readFile(new URL('../../examples/crystals/NaD-neutron.cif',import.meta.url),'utf8');
  await load(deuteride,'NaD-neutron.cif');await change('diffraction-radiation','neutron');
  const deuterium=await run();assert.equal(deuterium.backend,'gpu');
  await change('diffraction-radiation','electron');
  const deuteriumElectron=await run();assert.equal(deuteriumElectron.parameters.radiation,'electron');
  await load(deuteride.replace('D1 D 0.5','H1 H 0.5'),'NaH-neutron.cif');await change('diffraction-radiation','neutron');
  const hydrogen=await run();assert.equal(hydrogen.backend,'gpu');
  // Odd rocksalt reflections contain the DIFFERENCE of the two coherent
  // amplitudes. Natural hydrogen's negative b must not be replaced by |b|.
  const expectedContrast=((3.63+3.739)/(3.63-6.671))**2;
  assert.ok(Math.abs(hydrogen.peaks[0].intensity/deuterium.peaks[0].intensity-expectedContrast)<2e-4);
  await change('diffraction-radiation','electron');const hydrogenElectron=await run();parity(hydrogenElectron,deuteriumElectron);
  await change('diffraction-radiation','neutron');await run();
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('[data-tool-button="crystal"]').click();document.getElementById('diffraction-controls').open=true`);
  if(await evaluate('document.getElementById("tool-crystal").hidden'))await evaluate('document.querySelector("[data-tool-button=crystal]").click()');
  await press('run-diffraction');
  await waitFor('document.getElementById("diffraction-state").textContent==="Calculated"','mobile diffraction controls');
  await evaluate('document.getElementById("diffraction-chart").scrollIntoView({block:"center"})');
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth+1`),true,'mobile page does not overflow');
  const phone=await call('Page.captureScreenshot',{format:'png'});
  await writeFile(`${artifacts}/diffraction-phone.png`,Buffer.from(phone.data,'base64'));
  return { production, cpu: { backend: cpu.backend, peaks: cpu.peaks.length, firstPeaks: cpu.peaks.slice(0, 3) },
    gpu: { backend: gpu.backend, peaks: gpu.peaks.length }, profileRows: cpu.profileCount,
    presets: true, invalidation: true, sourceReset: true, configurationRestore:true, physicalReplication:true,
    electron:{cpu:electronCpu.backend,gpu:electronGpu.backend,firstPeak:electronCpu.peaks[0].twoTheta,voltagePresets:true,highVoltageElapsedMs:electron300.elapsedMs},
    neutron:{cpu:neutronCpu.backend,gpu:neutronGpu.backend,configurationRestore:true,explicitDeuterium:true,signedHydrogenContrast:true},
    mobile:true, siliconFirstPeak: silicon.peaks[0].twoTheta, artifacts };
});
await writeFile(`${artifacts}/report.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
