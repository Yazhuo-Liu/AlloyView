import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const production = process.argv.includes('--production');
const cif = `data_FCC\n_cell_length_a 4\n_cell_length_b 4\n_cell_length_c 4\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\n_space_group_IT_number 225\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\nAl1 Al 0 0 0\n`;
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  async function waitFor(expression, label) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
    throw new Error(`${label}: ${JSON.stringify(await evaluate(`({state:document.getElementById('crystal-symmetry-status')?.textContent,toast:document.getElementById('toast')?.textContent})`))}`);
  }
  await waitFor('document.readyState === "complete" && document.getElementById("run-crystal-symmetry")', 'symmetry UI');
  await evaluate(`(async () => {
    const app=document.querySelector('script[type="module"]').src;
    const {CrystalSymmetryClient}=await import(new URL('./analysis/crystal-symmetry-client.js',app));
    const analyze=CrystalSymmetryClient.prototype.analyze,ensure=CrystalSymmetryClient.prototype.ensureWorker;
    window.symmetryChecks={results:[],workers:new Set(),downloads:[]};
    CrystalSymmetryClient.prototype.analyze=async function(...args){const r=await analyze.apply(this,args);symmetryChecks.results.push(r);return r;};
    CrystalSymmetryClient.prototype.ensureWorker=function(...args){const w=ensure.apply(this,args);symmetryChecks.workers.add(w);return w;};
    const blobs=new Map(),create=URL.createObjectURL;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);blobs.set(url,blob);return url;};
    HTMLAnchorElement.prototype.click=function(){const blob=blobs.get(this.href);if(blob)symmetryChecks.downloads.push({blob,filename:this.download});};
  })()`);
  async function load(text, name) {
    await evaluate(`(() => {const data=new DataTransfer();data.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)}));const input=document.getElementById('file-input');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(name)} && document.getElementById('loading').hidden && !document.getElementById('run-crystal-symmetry').disabled`, 'load CIF');
  }
  await load(cif, 'symmetry-FCC.cif');
  await evaluate(`document.querySelector('[data-tool-button="crystal"]').click();document.getElementById('crystal-symmetry-controls').open=true;document.getElementById('run-crystal-symmetry').click()`);
  await waitFor('!document.getElementById("export-crystal-primitive").disabled', 'native FCC recognition');
  const result = await evaluate(`(() => {const r=symmetryChecks.results.at(-1);return {number:r.number,hall:r.hallNumber,operations:r.operationCount,primitive:r.primitive.ids.length,conventional:r.conventional.ids.length,memory:r.memoryBytes};})()`);
  assert.equal(result.number, 225); assert.equal(result.hall, 523); assert.equal(result.operations, 192); assert.equal(result.primitive, 1); assert.equal(result.conventional, 4);
  for (const [kind, format] of [['primitive','cif'],['conventional','poscar']]) {
    const before = await evaluate('symmetryChecks.downloads.length');
    await evaluate(`document.getElementById('crystal-symmetry-format').value=${JSON.stringify(format)};document.getElementById(${JSON.stringify(`export-crystal-${kind}`)}).click()`);
    await waitFor(`symmetryChecks.downloads.length>${before}`, `${kind} ${format} download`);
    const output = await evaluate('(async()=>{const d=symmetryChecks.downloads.at(-1);return {filename:d.filename,text:await d.blob.text()};})()');
    assert.match(output.filename, new RegExp(kind)); assert.ok(output.text.length > 60);
  }
  await evaluate(`(() => {const input=document.getElementById('crystal-symmetry-tolerance');input.value='0.001';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  assert.equal(await evaluate('document.getElementById("export-crystal-primitive").disabled'), true);
  assert.equal(await evaluate('document.getElementById("crystal-symmetry-result").hidden'), true);
  await evaluate('document.getElementById("run-crystal-symmetry").click()');
  await waitFor('!document.getElementById("export-crystal-primitive").disabled', 'second native run');
  assert.equal(await evaluate('symmetryChecks.workers.size'), 1);
  await load(cif.replace('225', '229'), 'symmetry-BCC.cif');
  assert.equal(await evaluate('document.getElementById("export-crystal-primitive").disabled'), true);
  await evaluate('document.getElementById("run-crystal-symmetry").click()');
  await waitFor('!document.getElementById("export-crystal-primitive").disabled', 'BCC recognition after source change');
  assert.equal(await evaluate('symmetryChecks.results.at(-1).number'), 229);
  assert.equal(await evaluate('symmetryChecks.workers.size'), 1);
  return { production, nativeMoyo: true, result, sourceDatabaseExpansion: true, standardizedDownloads: 2, toleranceInvalidation: true, retainedWorker: true };
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));
