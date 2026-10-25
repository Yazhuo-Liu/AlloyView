import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Production presentation regression. Selected completion promises are held;
// after release, the real CPU kernels run. CNA labels are then assigned by ID
// to make reorder, filtering and unmatched-particle expectations exact.
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
  async function wait(expression, label, timeout = 30_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({
      frame:window.smoothChecks?.renderer?.frame?.frameIndex,
      presented:window.smoothChecks?.renderer?.presentedFrame?.frameIndex,
      appearance:document.getElementById('viewport')?.parentElement.dataset,
      cna:document.getElementById('cna-state')?.textContent,
      csp:document.getElementById('csp-state')?.textContent,
      recipe:document.getElementById('configuration-status')?.textContent,
      toast:document.getElementById('toast')?.textContent,
      held:window.smoothChecks?.pending.map(x=>({kind:x.kind,index:x.index,background:x.background,aborted:x.signal?.aborted}))
    })`)}`);
  }
  await wait('document.readyState === "complete" && document.getElementById("frame-playback-fps")', 'Startup');
  await evaluate(`(${installChecks.toString()})()`);
  await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click();smoothChecks.openXYZ()');
  await wait('smoothChecks.renderer?.frame && /identity-explicit/.test(document.getElementById("file-name").textContent) && document.getElementById("frame-count").textContent==="4" && document.getElementById("loading").hidden', 'Explicit-ID trajectory');
  await evaluate('document.getElementById("run-cna").click()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Initial CNA');
  await evaluate('smoothChecks.change("csp-neighbors","12");document.getElementById("run-csp").click()');
  await wait('document.getElementById("csp-state").textContent==="Calculated"', 'Initial independent CSP');
  await evaluate('smoothChecks.change("color-mode","property:structureType");smoothChecks.hideFCC();smoothChecks.rememberAppearance();smoothChecks.recording=true;smoothChecks.events=[];document.getElementById("frame-next").click()');
  await wait('smoothChecks.renderer.frame.frameIndex===1 && smoothChecks.active("cna",1) && smoothChecks.active("centrosymmetry",1)', 'Reordered target while calculations pending');
  await delay(90);
  const preview = await evaluate('smoothChecks.snapshot()');
  assert.equal(preview.cna, false, 'borrowed classification must not enter the target scientific frame');
  assert.equal(preview.visible, 128, 'hidden FCC bulk does not flash visible');
  assert.equal(preview.appearance, 'preview');
  assert.equal(await evaluate('smoothChecks.matchesRemembered()'), true, 'colors and mask are remapped by explicit atom ID');
  assert.equal(await evaluate('smoothChecks.renderer.frame.ids[0]'), 256, 'target file order actually differs');

  // Export must wait for formal target results, never capture borrowed RGB.
  await evaluate('document.getElementById("export-png").click()'); await delay(80);
  assert.equal(await evaluate('smoothChecks.captures.length'), 0);
  const pointer = await evaluate('(()=>{const r=document.getElementById("viewport").getBoundingClientRect();return{x:r.left+r.width*.5,y:r.top+r.height*.5}})()');
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...pointer, button: 'left', buttons: 1, clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x + 10, y: pointer.y, button: 'left', buttons: 1 });
  const yawBefore = await evaluate('smoothChecks.renderer.yaw');
  await evaluate('smoothChecks.release("cna",1)');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Target CNA release');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pointer.x + 20, y: pointer.y, button: 'left', buttons: 1 });
  const yawAfter = await evaluate('smoothChecks.renderer.yaw');
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pointer.x + 20, y: pointer.y, button: 'left', buttons: 0, clickCount: 1 });
  assert.ok(Math.abs(yawAfter - yawBefore) > .03, 'completion does not interrupt an ongoing orbit');
  assert.equal(await evaluate('smoothChecks.matchesRemembered()'), true);
  const uploadsBefore = await evaluate('smoothChecks.colorUploads()');
  await evaluate('smoothChecks.release("centrosymmetry",1)');
  await wait('document.getElementById("csp-state").textContent==="Calculated" && smoothChecks.captures.length===1', 'Independent result and formal PNG');
  await delay(80);
  assert.equal(await evaluate('smoothChecks.colorUploads()'), uploadsBefore, 'unrelated CSP completion performs no color upload');
  assert.equal(await evaluate('smoothChecks.captures[0].cna && smoothChecks.captures[0].csp'), true);

  const oldFrameAnalyses = await evaluate('smoothChecks.analyses.filter(x=>x.source==="identity-explicit"&&x.index===0).length');
  await evaluate('document.getElementById("frame-first").click()');
  await wait('smoothChecks.renderer.frame.frameIndex===0 && document.getElementById("csp-state").textContent==="Calculated"', 'Cached return');
  assert.equal(await evaluate('smoothChecks.analyses.filter(x=>x.source==="identity-explicit"&&x.index===0).length'), oldFrameAnalyses);
  await evaluate('smoothChecks.jump(3)');
  await wait('smoothChecks.renderer.frame.frameIndex===2 && smoothChecks.active("cna",2)', 'New ID target');
  assert.equal(await evaluate('smoothChecks.matchesRemembered({allowUnmatched:true})'), true);
  assert.equal(await evaluate('smoothChecks.renderer.visibility[Array.from(smoothChecks.renderer.frame.ids).indexOf(1001)]'), 255, 'unmatched new atom has a neutral visible fallback');
  assert.equal(await evaluate('smoothChecks.renderer.frame.properties.some(x=>x.name==="structureType")'), false);
  await evaluate('smoothChecks.release("cna",2);smoothChecks.release("centrosymmetry",2)');
  await wait('document.getElementById("cna-state").textContent==="Calculated" && document.getElementById("csp-state").textContent==="Calculated"', 'New ID formal results');

  await evaluate('smoothChecks.change("color-mode","property:energy")');
  await wait('document.getElementById("legend-range-policy")', 'Scalar range policy');
  const fixedRange = await evaluate('smoothChecks.legendRange()');
  const headerReadsBefore = await evaluate('smoothChecks.headerReads');
  await evaluate('smoothChecks.change("legend-range-policy","fixed");smoothChecks.jump(1)');
  await wait('smoothChecks.renderer.frame.frameIndex===0 && document.getElementById("legend-range-policy")?.value==="fixed"', 'Fixed range across a different frame');
  assert.deepEqual(await evaluate('smoothChecks.legendRange()'), fixedRange);
  await evaluate('smoothChecks.change("legend-range-policy","frame")');
  assert.notDeepEqual(await evaluate('smoothChecks.legendRange()'), fixedRange, 'per-frame fitting follows the current scalar domain');
  assert.equal(await evaluate('smoothChecks.headerReads'), headerReadsBefore, 'range policy does not scan the trajectory');
  await evaluate('smoothChecks.change("color-mode","property:structureType")');

  // A failed target must not permanently replace the requested Color by.
  await evaluate('smoothChecks.jump(4)');
  await wait('smoothChecks.renderer.frame.frameIndex===3 && smoothChecks.active("cna",3)', 'Failing target');
  await evaluate('smoothChecks.release("cna",3,"Controlled target failure")');
  await wait('document.getElementById("cna-state").textContent==="Failed"', 'Controlled analysis failure');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:structureType');
  await evaluate('smoothChecks.jump(2)');
  await wait('smoothChecks.renderer.frame.frameIndex===1 && document.getElementById("cna-state").textContent==="Calculated"', 'Successful return after failure');
  assert.equal(await evaluate('document.getElementById("color-mode").value'), 'property:structureType');

  // No trustworthy correspondence: hold the whole old scene, never align by
  // row number merely because two particle counts happen to match.
  await evaluate('smoothChecks.openXYZ({explicitIds:false,count:2})');
  await wait('/identity-no-ids/.test(document.getElementById("file-name").textContent) && smoothChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden', 'No-ID trajectory');
  await evaluate('document.getElementById("run-cna").click()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'No-ID initial CNA');
  await evaluate('smoothChecks.hideFCC();document.getElementById("frame-next").click()');
  await wait('smoothChecks.renderer.frame.frameIndex===1 && smoothChecks.active("cna",1)', 'No-ID pending target');
  await delay(80);
  assert.equal(await evaluate('(smoothChecks.renderer.presentedFrame??smoothChecks.renderer.frame).frameIndex'), 0, 'old complete scene stays presented for untrusted identity');
  await evaluate('smoothChecks.release("cna",1)');
  await wait('(smoothChecks.renderer.presentedFrame??smoothChecks.renderer.frame).frameIndex===1 && document.getElementById("cna-state").textContent==="Calculated"', 'No-ID final commit');

  // Exact image data is available within a frame. It must be applied before
  // first target display, independently of held CNA or trajectory inference.
  await evaluate('smoothChecks.openCFG()');
  await wait('/exact-unwrap/.test(document.getElementById("file-name").textContent) && smoothChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden', 'Explicit-image CFG folder');
  await evaluate('document.getElementById("run-cna").click()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Image initial CNA');
  await evaluate('smoothChecks.change("coordinate-mode","unwrapped")');
  await wait('smoothChecks.renderer.frame.unwrappedPositions', 'First exact Unwrap');
  await evaluate('smoothChecks.unwraps=[];document.getElementById("frame-next").click()');
  await wait('smoothChecks.renderer.frame.frameIndex===1 && smoothChecks.active("cna",1)', 'Held image target');
  const exactUnwrap = await evaluate('({x:smoothChecks.renderer.rawDisplayPositions[0],hasUnwrapped:!!smoothChecks.renderer.frame.unwrappedPositions,inference:document.getElementById("trajectory-infer-unwrap").checked,requests:smoothChecks.unwraps})');
  assert.ok(exactUnwrap.hasUnwrapped && Math.abs(exactUnwrap.x - 12) < 1e-5);
  assert.equal(exactUnwrap.inference, false); assert.ok(exactUnwrap.requests.every(entry => !entry.infer));
  await evaluate('smoothChecks.release("cna",1)');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Image CNA release');

  // Deliberately exceed a 500ms complete interval. There is no extra 500ms
  // wait after results finish. This checks scheduling, not hardware speed.
  await evaluate('smoothChecks.openXYZ({count:4,name:"playback-complete"})');
  await wait('/playback-complete/.test(document.getElementById("file-name").textContent) && smoothChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden', 'Playback fixture');
  await evaluate('document.getElementById("run-cna").click()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Playback initial classification');
  await evaluate('smoothChecks.change("csp-neighbors","12");document.getElementById("run-csp").click()');
  await wait('document.getElementById("csp-state").textContent==="Calculated"', 'Playback independent CSP');
  await evaluate('smoothChecks.change("color-mode","property:structureType")');
  await evaluate('smoothChecks.change("frame-playback-fps",2);smoothChecks.change("frame-playback-mode","complete");smoothChecks.events=[];document.getElementById("frame-play").click()');
  await wait('smoothChecks.events.some(x=>x.kind==="setFrame"&&x.index===1) && smoothChecks.active("cna",1) && smoothChecks.active("centrosymmetry",1)', 'First complete playback request');
  await delay(650);
  const releaseAt = await evaluate('performance.now()');
  await evaluate('smoothChecks.release("cna",1)');
  await wait('smoothChecks.events.some(x=>x.kind==="setFrame"&&x.index===2)', 'Immediate next complete request');
  const nextAt = await evaluate('smoothChecks.events.find(x=>x.kind==="setFrame"&&x.index===2).time');
  const formalPaint = await evaluate('smoothChecks.events.find(x=>x.kind==="draw"&&x.index===1&&x.cna)');
  assert.ok(formalPaint && formalPaint.time <= nextAt, 'complete playback really paints each formal scene before advancing');
  assert.equal(await evaluate('smoothChecks.pending.some(x=>x.source==="playback-complete"&&x.index===1&&x.kind==="centrosymmetry"&&!x.settled)'), true, 'an unrelated held CSP result does not block complete playback');
  await evaluate('document.getElementById("frame-play").click();smoothChecks.releaseAll()');
  assert.ok(nextAt - releaseAt < 450, `extra wait after completion: ${nextAt - releaseAt} ms`);

  await evaluate('smoothChecks.openXYZ({count:8,name:"playback-preview"})');
  await wait('/playback-preview/.test(document.getElementById("file-name").textContent) && smoothChecks.renderer.frame.frameIndex===0 && document.getElementById("loading").hidden', 'Preview fixture');
  await evaluate('document.getElementById("run-cna").click()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Preview initial CNA');
  await evaluate('smoothChecks.change("frame-playback-fps",20);smoothChecks.change("frame-playback-mode","preview");smoothChecks.events=[];document.getElementById("frame-play").click()');
  await wait('smoothChecks.events.filter(x=>x.kind==="setFrame"&&x.index>0).length>=3', 'Clock-driven preview advances while CNA remains pending');
  await evaluate('document.getElementById("frame-play").click()');
  const previewPlayback = await evaluate('({indices:smoothChecks.events.filter(x=>x.kind==="setFrame").map(x=>x.index),aborted:smoothChecks.pending.filter(x=>x.signal?.aborted).length,fps:document.getElementById("frame-playback-fps").value,mode:document.getElementById("frame-playback-mode").value})');
  assert.ok(previewPlayback.aborted > 0); assert.equal(previewPlayback.mode, 'preview');
  await evaluate('smoothChecks.releaseAll()');
  await wait('document.getElementById("cna-state").textContent==="Calculated"', 'Stopped preview reaches formal result');
  const recipe = await evaluate('smoothChecks.exportRecipe()');
  assert.deepEqual(recipe.settings.extensions.playback, { fps: 20, mode: 'preview' });
  await evaluate('smoothChecks.change("frame-playback-fps",1);smoothChecks.change("frame-playback-mode","complete")');
  await evaluate(`smoothChecks.importRecipe(${JSON.stringify(recipe)})`);
  await wait('document.getElementById("frame-playback-fps").value==="20" && document.getElementById("frame-playback-mode").value==="preview" && /Configuration restored/.test(document.getElementById("configuration-status").textContent)', 'Playback recipe restoration');
  assert.equal(await evaluate('document.getElementById("frame-play").getAttribute("aria-pressed")'), 'false');

  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await delay(150);
  const mobile = await evaluate('smoothChecks.mobileLayout()');
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(`/tmp/alloyview-interactive-smoothness-mobile${process.argv.includes('--isolated') ? '-isolated' : ''}.png`, Buffer.from(screenshot.data, 'base64'));
  for (const name of ['jump', 'go', 'fps', 'mode', 'slider']) {
    const bounds = mobile[name];
    assert.ok(bounds.left >= mobile.bar.left - 1 && bounds.right <= mobile.bar.right + 1 && bounds.top >= mobile.bar.top - 1 && bounds.bottom <= mobile.bar.bottom + 1, `${name} fits mobile timeline: ${JSON.stringify(mobile)}`);
  }
  assert.ok(mobile.jump.right <= mobile.go.left + 1);
  assert.ok(mobile.fps.right - mobile.fps.left < 80, 'FPS remains a compact field on mobile');
  assert.ok(mobile.fps.right <= mobile.mode.left + 1 || mobile.fps.bottom <= mobile.mode.top + 1,
    `playback controls do not overlap when they wrap: ${JSON.stringify(mobile)}`);
  return { result: 'passed', preview, cameraDrag: { yawBefore, yawAfter }, unrelatedColorUploads: 0,
    reorderedIds: true, unmatchedIds: true, noIdSceneHeld: true, strictImageExport: true, fixedScalarRange: true,
    exactUnwrap, completePlaybackExtraWaitMs: Number((nextAt - releaseAt).toFixed(1)), completePlaybackFinalDraw: true,
    completePlaybackIgnoresUnrelatedCsp: true, previewPlayback,
    configurationRestoredWithoutPlayback: true, mobile, glError: await evaluate('smoothChecks.renderer.gl.getError()') };
}, { requireGpu: false, isolated: process.argv.includes('--isolated') });
assert.equal(report.glError, 0);
console.log(JSON.stringify(report, null, 2));

async function installChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { StructureWorkerClient }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./data/structure-worker-client.js', app)),
  ]);
  const checks = window.smoothChecks = { source: '', gated: new Set(), failures: new Map(), pending: [], events: [], analyses: [], captures: [], unwraps: [], headerReads: 0, recording: false };
  const signature = (index, kind) => `${checks.source}:${index}:${kind}`;
  const frame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') {
      checks.renderer = this; checks.events.push({ kind: 'setFrame', index: args[0].frameIndex, time: performance.now() });
    }
    return frame.apply(this, args);
  };
  const render = WebGLRenderer.prototype.render;
  WebGLRenderer.prototype.render = function(...args) {
    const result = render.apply(this, args);
    if (this.canvas.id === 'viewport' && checks.recording) {
      const presented = this.presentedFrame ?? this.frame;
      checks.events.push({ kind: 'draw', index: presented?.frameIndex, time: performance.now(), cna: presented?.properties.some(property => property.name === 'structureType') });
    }
    return result;
  };
  const colors = WebGLRenderer.prototype.setColors;
  WebGLRenderer.prototype.setColors = function(...args) {
    const before = this.colorRevision, result = colors.apply(this, args);
    if (this.canvas.id === 'viewport' && checks.recording && before !== this.colorRevision) checks.events.push({ kind: 'colorUpload', index: this.frame?.frameIndex, time: performance.now() });
    return result;
  };
  WebGLRenderer.prototype.exportPng = async function() {
    checks.captures.push({ cna: this.frame.properties.some(x => x.name === 'structureType'), csp: this.frame.properties.some(x => x.name === 'centralSymmetry') });
  };
  const unwrap = StructureWorkerClient.prototype.trajectoryUnwrap;
  StructureWorkerClient.prototype.trajectoryUnwrap = function(index, options) {
    checks.unwraps.push({ index, infer: Boolean(options.infer) }); return unwrap.call(this, index, options);
  };
  const frameHeader = StructureWorkerClient.prototype.frameHeader;
  StructureWorkerClient.prototype.frameHeader = function(...args) { checks.headerReads++; return frameHeader.apply(this, args); };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = async function(frame, parameters, options = {}) {
    const source = checks.source, index = frame.frameIndex;
    checks.analyses.push({ source, index, kind: parameters.kind, background: Boolean(options.background) });
    if (checks.gated.has(signature(index, parameters.kind))) await new Promise((resolve, reject) => {
      const entry = { source, index, kind: parameters.kind, signal: options.signal, background: Boolean(options.background), settled: false };
      checks.pending.push(entry);
      const abort = () => reject(new DOMException('Stopped', 'AbortError'));
      options.signal?.addEventListener('abort', abort, { once: true });
      entry.resolve = () => { entry.settled = true; options.signal?.removeEventListener('abort', abort); resolve(); };
      entry.reject = message => { entry.settled = true; options.signal?.removeEventListener('abort', abort); reject(new Error(message)); };
      if (options.signal?.aborted) abort();
    });
    const result = await analyze.call(this, frame, parameters, options);
    if (checks.failures.has(`${source}:${index}:${parameters.kind}`)) throw new Error(checks.failures.get(`${source}:${index}:${parameters.kind}`));
    if (parameters.kind === 'cna') result.structures = Uint8Array.from(frame.ids, id => Number(id) % 2 ? 1 : 3);
    return result;
  };
  checks.active = (kind, index) => checks.pending.some(entry => entry.source === checks.source && entry.kind === kind && entry.index === index && !entry.settled && !entry.signal?.aborted);
  checks.release = (kind, index, error = null) => {
    checks.gated.delete(signature(index, kind));
    if (error) checks.failures.set(signature(index, kind), error);
    for (const entry of checks.pending.filter(entry => entry.source === checks.source && entry.kind === kind && entry.index === index && !entry.settled && !entry.signal?.aborted)) error ? entry.reject(error) : entry.resolve();
  };
  checks.releaseAll = () => { checks.gated.clear(); for (const entry of checks.pending.filter(entry => !entry.settled && !entry.signal?.aborted)) entry.resolve(); };
  checks.change = (id, value) => {
    const input = document.getElementById(id); if (typeof value === 'boolean') input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  checks.jump = frame => { document.getElementById('frame-jump-input').value = String(frame); document.getElementById('frame-jump-go').click(); };
  checks.hideFCC = () => { const box = document.querySelector('#color-legend [data-category-id="1"]'); if (!box) throw new Error('FCC checkbox missing'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); };
  checks.rememberAppearance = () => {
    const renderer = checks.renderer;
    checks.appearance = new Map(Array.from(renderer.frame.ids, (id, index) => [String(id), { colors: Array.from(renderer.atomColors.subarray(index * 3, index * 3 + 3)), visible: renderer.visibility[index] }]));
  };
  checks.matchesRemembered = ({ allowUnmatched = false } = {}) => {
    const renderer = checks.renderer;
    return Array.from(renderer.frame.ids).every((id, index) => {
      const previous = checks.appearance.get(String(id));
      return previous ? previous.colors.every((color, component) => color === renderer.atomColors[index * 3 + component]) && previous.visible === renderer.visibility[index] : allowUnmatched;
    });
  };
  checks.colorUploads = () => checks.events.filter(event => event.kind === 'colorUpload').length;
  checks.legendRange = () => Array.from(document.querySelectorAll('.legend-controls input[type=number]'), input => input.valueAsNumber);
  checks.snapshot = () => ({ index: checks.renderer.frame.frameIndex, visible: checks.renderer.visibility.filter(Boolean).length,
    cna: checks.renderer.frame.properties.some(property => property.name === 'structureType'), appearance: document.getElementById('viewport').parentElement.dataset.appearanceState });
  checks.open = files => { const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file); const input = document.getElementById('file-input'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); };
  checks.reset = (source, count) => {
    checks.releaseAll(); checks.source = source; checks.pending = []; checks.events = []; checks.unwraps = []; checks.failures.clear();
    for (let index = 1; index < count; index++) for (const kind of ['cna', 'centrosymmetry']) checks.gated.add(signature(index, kind));
  };
  checks.openXYZ = ({ explicitIds = true, count = 4, name = explicitIds ? 'identity-explicit' : 'identity-no-ids' } = {}) => {
    checks.reset(name, count);
    const text = Array.from({ length: count }, (_, step) => {
      let id = 0; const atoms = [];
      for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) for (const basis of [[0, 0, 0], [.5, .5, 0], [.5, 0, .5], [0, .5, .5]]) {
        atoms.push({ id: ++id, positions: [(x + basis[0]) * 4, (y + basis[1]) * 4, (z + basis[2]) * 4 + .2 + step * .1] });
      }
      if (step === 1) atoms.reverse();
      if (step === 2) atoms[0].id = 1001;
      const rows = atoms.map(atom => `Cu ${atom.positions.join(' ')}${explicitIds ? ` ${atom.id}` : ''} ${atom.id * (step + 1)}`);
      return [rows.length, `Lattice="16 0 0 0 16 0 0 0 16" Properties=species:S:1:pos:R:3${explicitIds ? ':id:I:1' : ''}:energy:R:1 pbc="T T T" Step=${step}`, ...rows, ''].join('\n');
    }).join('');
    checks.open([new File([text], `${name}.xyz`)]);
  };
  checks.openCFG = () => {
    checks.reset('exact-unwrap', 2);
    const matrix = Array.from({ length: 9 }, (_, index) => `H0(${Math.floor(index / 3) + 1},${index % 3 + 1}) = ${index % 4 === 0 ? 10 : 0}`).join('\n');
    checks.open(Array.from({ length: 2 }, (_, step) => new File([
      `Number of particles = 2\n${matrix}\n.NO_VELOCITY.\nentry_count = 7\nauxiliary[0] = id\nauxiliary[1] = ix\nauxiliary[2] = iy\nauxiliary[3] = iz\n55.845\nFe\n${.1 + .1 * step} .2 .3 1 ${step} 0 0\n.4 .5 .6 2 ${step} 0 0\n`,
    ], `exact-unwrap.${step}.cfg`)));
  };
  const createUrl = URL.createObjectURL;
  URL.createObjectURL = function(blob) { if (blob.type === 'application/json') checks.configBlob = blob; return createUrl.call(this, blob); };
  HTMLAnchorElement.prototype.click = function() {};
  checks.exportRecipe = async () => { checks.configBlob = null; document.getElementById('export-configuration').click(); for (let i = 0; i < 100 && !checks.configBlob; i++) await new Promise(resolve => setTimeout(resolve, 10)); return JSON.parse(await checks.configBlob.text()); };
  checks.importRecipe = recipe => { const transfer = new DataTransfer(); transfer.items.add(new File([JSON.stringify(recipe)], 'smoothness.json', { type: 'application/json' })); const input = document.getElementById('configuration-file'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); };
  checks.mobileLayout = () => Object.fromEntries(Object.entries({ bar: 'trajectory-section', jump: 'frame-jump-input', go: 'frame-jump-go', fps: 'frame-playback-fps', mode: 'frame-playback-mode', slider: 'frame-slider' }).map(([name, id]) => { const r = document.getElementById(id).getBoundingClientRect(); return [name, { left: r.left, right: r.right, top: r.top, bottom: r.bottom }]; }));
}
