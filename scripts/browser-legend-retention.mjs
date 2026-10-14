import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Exercise the actual page, native editing buffer, pointer capture, renderer and
// frame Worker. Run with --production after the unified build to cover bundles.
const frames = Array.from({ length: 4 }, (_, step) => [
  '64', `Lattice="12 0 0 0 12 0 0 0 12" pbc="F F F" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1:tag:I:1 Step=${step}`,
  ...Array.from({ length: 64 }, (_, atom) => `${atom && atom % (step + 2) === 0 ? 'Al' : 'Ni'} ${1 + atom % 4 * 2} ${1 + Math.floor(atom / 4) % 4 * 2} ${1 + Math.floor(atom / 16) * 2} ${atom + 1} ${step === 2 ? 'NaN' : atom / 10 + step * 10} ${atom % (step + 2) === 0 ? 1 : 0}`), '',
].join('\n')).join('');
const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  const origin = await evaluate('location.origin');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: 'Object.defineProperty(navigator,"hardwareConcurrency",{get:()=>4})' });
  await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/${process.argv.includes('--production') ? 'dist/' : ''}index.html` });
  async function wait(expression, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
    throw new Error(`${label}: ${await evaluate('document.getElementById("toast")?.textContent')}`);
  }
  await wait('document.readyState==="complete" && document.getElementById("color-mode")', 'app loaded');
  await evaluate(`(${installChecks.toString()})()`);
  await evaluate(`if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')document.getElementById('enable-gpu-computing').click()`);
  await evaluate(`(() => { const files=new DataTransfer();files.items.add(new File([${JSON.stringify(frames)}],'legend-frames.xyz'));const input=document.getElementById('file-input');input.files=files.files;input.dispatchEvent(new Event('change')); })()`);
  await wait('legendChecks.renderer?.atomCount===64 && document.getElementById("loading").hidden', 'fixture loaded');
  await evaluate('legendChecks.change("color-mode","property:energy")');
  await wait('document.querySelector(".legend-controls input[type=number]")', 'scalar colors');
  await evaluate('legendChecks.remember();document.getElementById("legend-color-mode").focus();legendChecks.frame(1)');
  await wait('legendChecks.renderer.frame.timestep===1', 'second frame');
  assert.ok(await evaluate('legendChecks.sameNodes() && document.activeElement===legendChecks.nodes.quantity'), 'frame changes retain every scalar control and its focus');
  assert.deepEqual(await evaluate('legendChecks.range()'), [10, Math.fround(16.3)]);
  assert.ok(await evaluate('legendChecks.exact()'), 'Auto colors use the new property array');

  // Chrome retains incomplete syntax in a private number input buffer even
  // though .value is empty. Recreating the node would destroy this draft.
  await evaluate('legendChecks.nodes.minimum.focus();legendChecks.nodes.minimum.select()');
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: '-', code: 'Minus', text: '-' });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: '-', code: 'Minus' });
  assert.ok(await evaluate('legendChecks.nodes.minimum.validity.badInput'), 'native draft is incomplete');
  assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'false');
  await evaluate('legendChecks.frame(0)'); await wait('legendChecks.renderer.frame.timestep===0', 'draft frame change');
  assert.ok(await evaluate('legendChecks.sameNodes() && legendChecks.nodes.minimum.validity.badInput && document.activeElement===legendChecks.nodes.minimum'), 'draft and focus survive another frame');
  await evaluate('legendChecks.nodes.minimum.select()');
  await call('Input.insertText', { text: '1.2' });
  assert.deepEqual(await evaluate('legendChecks.range()'), [1.2, Math.fround(16.3)]);
  assert.ok(await evaluate('legendChecks.exact()'), 'retained number handler applies to the current frame');
  await evaluate('legendChecks.nodes.scheme.focus();legendChecks.nodes.scheme.value="viridis";legendChecks.nodes.scheme.dispatchEvent(new Event("change"));legendChecks.frame(1)');
  await wait('legendChecks.renderer.frame.timestep===1', 'scheme frame change');
  assert.ok(await evaluate('legendChecks.sameNodes() && document.activeElement===legendChecks.nodes.scheme && legendChecks.exact()'), 'scheme refresh retains focused select and uses current scalar values');
  await evaluate('legendChecks.nodes.visibility.focus();legendChecks.nodes.visibility.checked=false;legendChecks.nodes.visibility.dispatchEvent(new Event("change"));legendChecks.frame(0)');
  await wait('legendChecks.renderer.frame.timestep===0', 'visibility frame change');
  assert.ok(await evaluate('legendChecks.sameNodes() && document.activeElement===legendChecks.nodes.visibility && !legendChecks.nodes.visibility.checked'), 'visibility checkbox remains the same focused node');
  await evaluate('legendChecks.nodes.automatic.click()'); await delay(60);
  assert.equal(await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")'), 'true');
  assert.deepEqual(await evaluate('legendChecks.range()'), [0, Math.fround(6.3)]);

  // Keep real browser pointer capture across a frame arrival. Explicit capture
  // observes the contract independently of Chromium native thumb internals.
  await evaluate(`legendChecks.nodes.thumb.addEventListener('pointerdown',event=>{legendChecks.pointer=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId)},{once:true})`);
  const point = await evaluate(`(() => {const input=legendChecks.nodes.thumb;input.scrollIntoView({block:'nearest'});const b=input.getBoundingClientRect();return {x:b.left+10,y:b.top+b.height/2};})()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 35, y: point.y, button: 'left', buttons: 1 });
  await delay(60);
  const captured = await evaluate('({maximum:legendChecks.nodes.thumb.max,minimum:legendChecks.nodes.minimum.valueAsNumber})');
  assert.ok(captured.minimum > 0 && captured.minimum < 6.3);
  await evaluate('legendChecks.nodes.thumb.setPointerCapture(legendChecks.pointer)');
  assert.ok(await evaluate('legendChecks.nodes.thumb.hasPointerCapture(legendChecks.pointer)'));
  await evaluate('legendChecks.frame(1)'); await wait('legendChecks.renderer.frame.timestep===1', 'captured frame change');
  assert.ok(await evaluate('legendChecks.sameNodes() && legendChecks.nodes.thumb.hasPointerCapture(legendChecks.pointer)'), 'playback does not detach the captured thumb');
  assert.equal(await evaluate('legendChecks.nodes.thumb.max'), captured.maximum, 'track stays under the pointer despite new data bounds');
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x + 50, y: point.y, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x + 50, y: point.y, button: 'left', buttons: 0, clickCount: 1 });
  assert.ok(await evaluate('legendChecks.exact()'), 'release commits the retained gesture on the latest frame');
  assert.notEqual(await evaluate('legendChecks.nodes.thumb.max'), captured.maximum, 'released track adopts latest frame data domain');

  // An export between input and its animation frame must flush exact values
  // and supply those values to the PNG legend.
  await evaluate('document.getElementById("png-legend").checked=true;legendChecks.input(.2);document.getElementById("export-png").click()');
  await wait('legendChecks.captureLegend', 'PNG capture');
  const capture = await evaluate('({range:legendChecks.range(),captured:[legendChecks.captureLegend.minimum,legendChecks.captureLegend.maximum],exact:legendChecks.exact()})');
  assert.deepEqual(capture.captured, capture.range); assert.ok(capture.exact);

  assert.equal(await evaluate('legendChecks.scalarRemoved'), 0, 'stable scalar updates removed no controls or scale nodes');
  await evaluate('legendChecks.observer.disconnect()');

  // All-NaN frame changes the schema deliberately. Old handlers cannot mutate
  // the newly selected property; a return to finite data creates a fresh view.
  await evaluate('legendChecks.oldThumb=legendChecks.nodes.thumb;legendChecks.frame(2)');
  await wait('legendChecks.renderer.frame.timestep===2', 'NaN frame');
  assert.ok(await evaluate('!legendChecks.oldThumb.isConnected && document.querySelector("[data-category-id=NaN]")'), 'NaN categorical legend replaces the scalar schema');
  await evaluate('legendChecks.frame(3)'); await wait('legendChecks.renderer.frame.timestep===3 && document.querySelector(".legend-slider")', 'finite schema again');
  assert.ok(await evaluate('document.querySelector(".legend-slider input")!==legendChecks.oldThumb && legendChecks.exact()'));
  const freshRange = await evaluate('legendChecks.range()');
  await evaluate('legendChecks.oldThumb.value="1";legendChecks.oldThumb.dispatchEvent(new Event("input"));legendChecks.oldThumb.dispatchEvent(new Event("pointerup"))');
  assert.deepEqual(await evaluate('legendChecks.range()'), freshRange, 'detached old thumb is inert');

  // Categorical counts update in place and a retained checkbox filters the new
  // frame species, even though their populations changed.
  await evaluate('legendChecks.change("color-mode","type")'); await delay(60);
  await evaluate(`legendChecks.typeBox=document.querySelector('[data-atom-type="Al"]');legendChecks.typeCount=legendChecks.typeBox.closest('label').querySelector('.legend-count');legendChecks.typeBox.focus();legendChecks.frame(0)`);
  await wait('legendChecks.renderer.frame.timestep===0', 'types frame');
  assert.ok(await evaluate('legendChecks.typeBox===document.querySelector("[data-atom-type=Al]") && document.activeElement===legendChecks.typeBox'));
  assert.equal(await evaluate('legendChecks.typeCount.textContent'), '31 · 48.4%');
  await evaluate('legendChecks.typeBox.checked=false;legendChecks.typeBox.dispatchEvent(new Event("change"))');
  assert.equal(await evaluate('legendChecks.renderer.visibility.reduce((sum,value)=>sum+Boolean(value),0)'), 33);
  await evaluate('legendChecks.frame(1)'); await wait('legendChecks.renderer.frame.timestep===1', 'type filter next frame');
  assert.equal(await evaluate('legendChecks.typeCount.textContent'), '21 · 32.8%');
  assert.equal(await evaluate('legendChecks.renderer.visibility.reduce((sum,value)=>sum+Boolean(value),0)'), 43);
  assert.equal(await evaluate('document.activeElement===legendChecks.typeBox'), true);

  // Real continuous playback retains a Color by select; all associated nodes
  // update without subtree removals while the schema stays unchanged.
  await evaluate('legendChecks.change("color-mode","property:tag")'); await delay(60);
  await evaluate('legendChecks.change("legend-scale-mode","discrete")'); await delay(60);
  await evaluate('legendChecks.rememberDiscrete();document.getElementById("frame-play").click()');
  await wait('legendChecks.renderer.frame.timestep!==1', 'playback moved frame', 5000);
  await evaluate('document.getElementById("frame-play").click()');
  assert.ok(await evaluate('legendChecks.discreteStable()'), 'playback preserves categorical and scale select nodes');
  return { frames: 4, nativeDraft: true, pointerCaptureAcrossFrames: true, currentFrameColors: true,
    pngRange: capture.range, typesAfterFilter: 43, scalarControlRemovals: await evaluate('legendChecks.scalarRemoved'), discreteStable: true };
}, { software: true, requireGpu: false });
console.log(JSON.stringify(report, null, 2));

async function installChecks() {
  const app = document.querySelector('script[type=module]').src;
  const [{ WebGLRenderer }, { colorsByProperty }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./render/palette.js', app)),
  ]);
  const checks = window.legendChecks = { scalarRemoved: 0 };
  const setFrame = WebGLRenderer.prototype.setFrame, captureImage = WebGLRenderer.prototype.captureImage;
  WebGLRenderer.prototype.setFrame = function(...args) { if (this.canvas.id === 'viewport') checks.renderer = this; return setFrame.apply(this, args); };
  WebGLRenderer.prototype.captureImage = function(options) { if (this.canvas.id === 'viewport') checks.captureLegend = options.legend; return captureImage.call(this, options); };
  // Export formatting is exercised; suppress only the file download.
  HTMLAnchorElement.prototype.click = function() {};
  checks.change = (id, value) => { const input=document.getElementById(id);input.value=value;input.dispatchEvent(new Event('change',{bubbles:true})); };
  checks.frame = index => { const input=document.getElementById('frame-slider');input.value=String(index);input.dispatchEvent(new Event('input',{bubbles:true})); };
  checks.range = () => Array.from(document.querySelectorAll('.legend-controls input[type=number]'), input => input.valueAsNumber);
  checks.remember = () => {
    checks.nodes = { quantity:document.getElementById('legend-color-mode'), minimum:document.querySelectorAll('.legend-controls input[type=number]')[0],
      maximum:document.querySelectorAll('.legend-controls input[type=number]')[1], scheme:document.querySelector('.legend-scheme select'),
      visibility:document.querySelector('.legend-visibility input'), automatic:document.getElementById('legend-auto'),
      thumb:document.querySelector('.legend-slider input[data-limit=minimum]'), track:document.querySelector('.legend-slider'), scale:document.querySelector('.legend-scale') };
    checks.observer = new MutationObserver(records => { for(const record of records) for(const node of record.removedNodes) if(Object.values(checks.nodes).some(input=>node===input||node.contains?.(input))) checks.scalarRemoved++; });
    checks.observer.observe(document.getElementById('color-legend'),{childList:true,subtree:true});
  };
  checks.sameNodes = () => Object.values(checks.nodes).every(node=>node.isConnected);
  checks.exact = () => {
    const [minimum,maximum]=checks.range(), property=checks.renderer.frame.properties.find(property=>property.name==='energy');
    const expected=colorsByProperty(property,{minimum,maximum},document.querySelector('.legend-scheme select').value).colors;
    return !checks.renderer.scalarColorPreview && expected.every((value,index)=>value===checks.renderer.atomColors[index]);
  };
  checks.input = fraction => {const input=document.querySelector('.legend-slider input[data-limit=minimum]');input.value=String(Math.round(Number(input.max)*fraction));input.dispatchEvent(new Event('input',{bubbles:true}));};
  checks.rememberDiscrete = () => { checks.discreteNodes=Array.from(document.querySelectorAll('#color-legend input,#color-legend select'));checks.discreteNodes[0].focus(); };
  checks.discreteStable = () => checks.discreteNodes.every(node=>node.isConnected)&&document.activeElement===checks.discreteNodes[0];
}
