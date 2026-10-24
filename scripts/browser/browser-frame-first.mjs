import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Real production UI: 165 wrapped CFG files, two atoms drifting through many
// periodic cells. Hold optional inference to prove rendering and single-frame
// analysis finish independently; image capture still waits for its coordinates.
const result = await withWebGpuBrowser(async ({ call, evaluate }) => {
  const origin = await evaluate('location.origin');
  await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
  async function waitFor(expression, label) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(30);
    }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({toast:document.getElementById('toast')?.textContent,
      frame:window.frameFirst?.renderer?.frame?.frameIndex, unwrap:document.getElementById('trajectory-unwrap-status')?.textContent,
      displacement:document.getElementById('displacement-status')?.textContent})`)}`);
  }
  await waitFor('document.readyState === "complete" && document.getElementById("coordinate-mode")', 'Startup');
  await evaluate(`(async () => {
    const app = document.querySelector('script[type=module][src]').src;
    const { StructureWorkerClient } = await import(new URL('./data/structure-worker-client.js', app));
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
    const checks = window.frameFirst = { reads:[], unwraps:[], held:[], captures:[], hold:true };
    const prepare = StructureWorkerClient.prototype.prepareSource;
    StructureWorkerClient.prototype.prepareSource = function(...args) { checks.client=this; return prepare.apply(this,args); };
    const read = StructureWorkerClient.prototype.frame;
    StructureWorkerClient.prototype.frame = function(index, options) {
      checks.reads.push({index, trajectory:options?.trajectory ?? null}); return read.call(this,index,options);
    };
    const unwrap = StructureWorkerClient.prototype.trajectoryUnwrap;
    StructureWorkerClient.prototype.trajectoryUnwrap = async function(index, options) {
      checks.unwraps.push({index, infer:Boolean(options.infer), background:options.background, analysis:document.getElementById('analysis-state').textContent});
      if(checks.hold) await new Promise((resolve,reject) => {
        const abort=()=>reject(new DOMException('Cancelled','AbortError'));
        options.signal.addEventListener('abort',abort,{once:true});
        checks.held.push(()=>{options.signal.removeEventListener('abort',abort); resolve();});
      });
      if(options.signal.aborted) throw new DOMException('Cancelled','AbortError');
      return unwrap.call(this,index,options);
    };
    checks.release=()=>{checks.hold=false; checks.held.splice(0).forEach(release=>release());};
    const display = WebGLRenderer.prototype.setFrame;
    WebGLRenderer.prototype.setFrame = function(...args) {
      if(this.canvas.id==='viewport') checks.renderer=this; return display.apply(this,args);
    };
    WebGLRenderer.prototype.exportPng = async function() {
      checks.captures.push({mode:this.coordinateMode, x:this.rawDisplayPositions[0]});
    };
    checks.change=(id,value)=>{const input=document.getElementById(id);if(typeof value==='boolean')input.checked=value;else input.value=String(value);
      if(id==='frame-slider') input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));};
    const files=Array.from({length:165},(_,index)=>new File([
      'Number of particles = 2\\n'+Array.from({length:9},(_,axis)=>'H0('+ (Math.floor(axis/3)+1)+','+(axis%3+1)+') = '+(axis%4===0?10:0)).join('\\n')+
      '\\n.NO_VELOCITY.\\nentry_count = 4\\nauxiliary[0] = id\\n55.845\\nFe\\n'+
      ((.9+.23*index)%1).toFixed(8)+' .2 .3 1\\n'+((.2+.23*index)%1).toFixed(8)+' .6 .7 2\\n'
    ],'frame.'+index+'.cfg'));
    const transfer=new DataTransfer(); files.reverse().forEach(file=>transfer.items.add(file));
    document.getElementById('file-input').files=transfer.files;
    document.getElementById('file-input').dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('frameFirst.renderer?.frame && document.getElementById("frame-count").textContent === "165" && document.getElementById("loading").hidden', 'Folder import');
  await evaluate('frameFirst.originalWorker=frameFirst.client.worker;document.getElementById("frame-last").click()');
  await waitFor('frameFirst.renderer.frame.frameIndex === 164 && document.getElementById("loading").hidden', 'Late frame without inference');
  assert.equal(await evaluate('frameFirst.unwraps.length'), 0);
  assert.equal(await evaluate('frameFirst.reads.every(read=>!read.trajectory)'), true);
  assert.equal(await evaluate('document.getElementById("coordinate-mode").value'), 'file');
  assert.equal(await evaluate('document.getElementById("trajectory-infer-unwrap").checked'), false);
  await evaluate('document.getElementById("run-analysis").click()');
  await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'Single-frame coordination');
  await evaluate('frameFirst.change("coordinate-mode","unwrapped")');
  assert.equal(await evaluate('frameFirst.unwraps.length'), 0, 'Unwrap alone does not authorize a trajectory scan');
  await evaluate('frameFirst.change("trajectory-infer-unwrap",true)');
  await waitFor('frameFirst.held.length > 0', 'Optional inference held');
  assert.equal(await evaluate('document.getElementById("loading").hidden && frameFirst.renderer.coordinateMode === "wrapped"'), true);
  await evaluate('frameFirst.change("frame-slider",2)');
  await waitFor('frameFirst.renderer.frame.frameIndex === 2 && document.getElementById("analysis-state").textContent === "Calculated" && frameFirst.unwraps.some(item=>item.index===2)', 'New structure and analysis before inference');
  const pending = await evaluate(`({mode:document.getElementById('coordinate-mode').value,
    hidden:document.getElementById('loading').hidden, inference:frameFirst.unwraps.at(-1),
    warmWorker:frameFirst.originalWorker===frameFirst.client.worker})`);
  assert.equal(pending.mode, 'unwrapped'); assert.equal(pending.hidden, true);
  assert.equal(pending.warmWorker, true); assert.equal(pending.inference.analysis, 'Calculated');
  assert.equal(pending.inference.infer, true);
  assert.equal(pending.inference.background, true);
  await evaluate('frameFirst.release()');
  await waitFor('frameFirst.renderer.coordinateMode === "unwrapped"', 'Deferred continuous coordinates');
  assert.ok(Math.abs(await evaluate('frameFirst.renderer.rawDisplayPositions[0]') - 13.6) < 1e-4);

  // Batch and single-image consumers cannot capture the temporary wrapped view.
  await evaluate('frameFirst.hold=true;frameFirst.change("frame-slider",100)');
  await waitFor('frameFirst.renderer.frame.frameIndex===100 && frameFirst.unwraps.some(item=>item.index===100)', 'Another pending frame');
  await evaluate('document.getElementById("export-png").click()');
  await delay(100);
  assert.equal(await evaluate('frameFirst.captures.length'), 0);
  await evaluate('frameFirst.release()');
  await waitFor('frameFirst.captures.length === 1', 'Image waits for continuous coordinates');
  const capture = await evaluate('frameFirst.captures[0]');
  assert.equal(capture.mode, 'unwrapped'); assert.ok(Math.abs(capture.x - 239) < 1e-4);

  await evaluate('frameFirst.change("coordinate-mode","wrapped");document.getElementById("frame-last").click()');
  await waitFor('frameFirst.renderer.frame.frameIndex===164 && document.getElementById("analysis-state").textContent === "Calculated"', 'Return to last frame');
  await evaluate(`document.getElementById('displacement-reference-frame').value='1';
    document.getElementById('displacement-minimum-image').checked=false;document.getElementById('run-displacement').click()`);
  await waitFor('document.getElementById("displacement-state").textContent === "Calculated"', 'Total displacement');
  const displacement = await evaluate('frameFirst.renderer.frame.properties.find(property=>property.name==="displacementX").data[0]');
  assert.ok(Math.abs(displacement - 377.2) < 1e-3, String(displacement));
  assert.equal(await evaluate('frameFirst.renderer.frame.unwrappedPositions == null'), true);
  await evaluate(`document.getElementById('replicate-a').value='2';document.getElementById('replicate-atoms').checked=true;
    document.getElementById('apply-replicate').click()`);
  await waitFor('frameFirst.renderer.frame.ids.length === 4 && document.getElementById("displacement-state").textContent === "Calculated"', 'Replicated displacement');
  const replicated = await evaluate('Array.from(frameFirst.renderer.frame.properties.find(property=>property.name==="displacementX").data)');
  for (const value of replicated) assert.ok(Math.abs(value - 377.2) < 1e-3, JSON.stringify(replicated));
  return { files:165, pending, capture, displacement, replicated, glError:await evaluate('frameFirst.renderer.gl.getError()') };
}, { requireGpu:false, isolated:process.argv.includes('--isolated') });
assert.equal(result.glError, 0);
console.log(JSON.stringify({ result:'passed', ...result }, null, 2));
