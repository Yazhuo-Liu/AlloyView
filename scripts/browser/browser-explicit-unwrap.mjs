import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Production UI regression: file positions are the default, single-frame
// Unwrap is explicit, and scanning a trajectory requires a second opt-in.
const result = await withWebGpuBrowser(async ({ call, evaluate }) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', { width:1400, height:1000, deviceScaleFactor:1, mobile:false });
  await call('Page.navigate', { url:`${origin}/AlloyView/dist/index.html` });
  async function waitFor(expression, label) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    throw new Error(`${label}: ${await evaluate(`JSON.stringify({
      toast:document.getElementById('toast')?.textContent,
      frame:window.unwrapChecks?.renderer?.frame?.frameIndex,
      position:window.unwrapChecks?.renderer?.rawDisplayPositions?.[0],
      selected:document.getElementById('coordinate-mode')?.value,
      status:document.getElementById('trajectory-unwrap-status')?.textContent,
      requests:window.unwrapChecks?.unwraps})`)}`);
  }
  await waitFor('document.readyState === "complete" && document.getElementById("trajectory-infer-unwrap")', 'Startup');
  await evaluate(`(async () => {
    const app = document.querySelector('script[type=module][src]').src;
    const { StructureWorkerClient } = await import(new URL('./data/structure-worker-client.js', app));
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
    const checks = window.unwrapChecks = { reads:[], unwraps:[], displays:[], held:[], holdInference:false };
    const prepare = StructureWorkerClient.prototype.prepareSource;
    StructureWorkerClient.prototype.prepareSource = function(...args) {
      checks.client=this; return prepare.apply(this,args);
    };
    const read = StructureWorkerClient.prototype.frame;
    StructureWorkerClient.prototype.frame = function(index,options) {
      checks.reads.push({index,background:Boolean(options?.background),trajectory:options?.trajectory??null});
      return read.call(this,index,options);
    };
    const unwrap = StructureWorkerClient.prototype.trajectoryUnwrap;
    StructureWorkerClient.prototype.trajectoryUnwrap = async function(index,options) {
      const row={index,infer:Boolean(options.infer),background:Boolean(options.background)};
      checks.unwraps.push(row);
      if(options.infer && checks.holdInference) await new Promise((resolve,reject)=>{
        const abort=()=>{row.aborted=true;reject(new DOMException('Cancelled','AbortError'));};
        options.signal.addEventListener('abort',abort,{once:true});
        checks.held.push(()=>{options.signal.removeEventListener('abort',abort);resolve();});
      });
      if(options.signal?.aborted) throw new DOMException('Cancelled','AbortError');
      return unwrap.call(this,index,options);
    };
    checks.release=()=>{checks.holdInference=false;checks.held.splice(0).forEach(release=>release());};
    const display = WebGLRenderer.prototype.setFrame;
    WebGLRenderer.prototype.setFrame = function(...args) {
      if(this.canvas.id==='viewport') {checks.renderer=this;checks.displays.push(args[0].frameIndex);}
      return display.apply(this,args);
    };
    checks.change=(id,value)=>{
      const input=document.getElementById(id);
      if(typeof value==='boolean') input.checked=value; else input.value=String(value);
      input.dispatchEvent(new Event('change',{bubbles:true}));
    };
    checks.jump=(frame,enter=false)=>{
      document.getElementById('frame-jump-input').value=String(frame);
      if(enter) document.getElementById('frame-jump-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      else document.getElementById('frame-jump-go').click();
    };
    checks.open=(kind,count=165)=>{
      const matrix=Array.from({length:9},(_,axis)=>'H0('+(Math.floor(axis/3)+1)+','+(axis%3+1)+') = '+(axis%4===0?10:0)).join('\\n');
      const transfer=new DataTransfer();
      for(let index=count-1;index>=0;index--) {
        const flags=kind==='images';
        const first = kind === 'outside' ? 1.25 : flags ? 0.02 : ((.9 + .23 * index) % 1);
        const second = kind === 'outside' ? 0.65 : flags ? 0.32 : ((.2 + .23 * index) % 1);
        const header='Number of particles = 2\\n'+matrix+'\\n.NO_VELOCITY.\\nentry_count = '+(flags?7:4)+'\\n'+
          (flags?'auxiliary[0] = ix\\nauxiliary[1] = iy\\nauxiliary[2] = iz\\nauxiliary[3] = id\\n':'auxiliary[0] = id\\n')+'55.845\\nFe\\n';
        const text=header+first.toFixed(8)+' .2 .3 '+(flags?(index+3)+' -1 2 ':'')+'1\\n'+
          second.toFixed(8)+' .6 .7 '+(flags?'0 0 0 ':'')+'2\\n';
        transfer.items.add(new File([text],kind+'.'+index+'.cfg'));
      }
      const input=document.getElementById('file-input');input.files=transfer.files;
      input.dispatchEvent(new Event('change',{bubbles:true}));
    };
    checks.snapshot=()=>({index:checks.renderer.frame.frameIndex,
      x:checks.renderer.rawDisplayPositions[0],wrappedX:checks.renderer.frame.positions[0],
      hasUnwrapped:Boolean(checks.renderer.frame.unwrappedPositions),
      hasInferred:Boolean(checks.renderer.frame.inferredUnwrap),
      selected:document.getElementById('coordinate-mode').value,
      unwrap:document.getElementById('trajectory-unwrap-enabled').checked,
      inference:document.getElementById('trajectory-infer-unwrap').checked});
    checks.open('missing');
  })()`);
  await waitFor('unwrapChecks.renderer?.frame && document.getElementById("frame-count").textContent === "165" && document.getElementById("loading").hidden', '165-file folder');
  assert.deepEqual(await evaluate(`({selected:document.getElementById('coordinate-mode').value,
    unwrap:document.getElementById('trajectory-unwrap-enabled').checked,
    inference:document.getElementById('trajectory-infer-unwrap').checked,requests:unwrapChecks.unwraps.length})`),
  { selected:'file', unwrap:false, inference:false, requests:0 });
  await evaluate('unwrapChecks.originalWorker=unwrapChecks.client.worker;unwrapChecks.jump(165,true)');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===164 && document.getElementById("loading").hidden', 'Enter jumps directly to frame 165');
  assert.equal(await evaluate('document.getElementById("frame-jump-input").value'), '165');
  for (const frame of [3, 80, 12, 164]) {
    await evaluate(`unwrapChecks.jump(${frame})`);
    await waitFor(`unwrapChecks.renderer.frame.frameIndex===${frame-1}`, `Go to frame ${frame}`);
  }
  const beforeDrag = await evaluate('({index:unwrapChecks.renderer.frame.frameIndex,displays:unwrapChecks.displays.length})');
  await evaluate(`(()=>{const slider=document.getElementById('frame-slider');slider.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    for(const index of [1,100,9,70,164]) {slider.value=String(index);slider.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await delay(120);
  assert.equal(await evaluate('unwrapChecks.renderer.frame.frameIndex'), beforeDrag.index, 'pointer preview does not decode intermediate frames');
  await evaluate(`document.getElementById('frame-slider').dispatchEvent(new PointerEvent('pointerup',{bubbles:true}))`);
  await waitFor('unwrapChecks.renderer.frame.frameIndex===164', 'Pointer release commits only the final target');
  assert.ok((await evaluate(`unwrapChecks.displays.slice(${beforeDrag.displays})`)).every(index=>index===164));
  await evaluate('unwrapChecks.jump(25);unwrapChecks.jump(120);unwrapChecks.jump(39)');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===38', 'Latest rapid numeric jump wins');
  await evaluate('unwrapChecks.jump(165)');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===164', 'Return to late frame');
  assert.equal(await evaluate('unwrapChecks.unwraps.length'), 0);
  assert.equal(await evaluate('unwrapChecks.originalWorker===unwrapChecks.client.worker'), true);

  await evaluate('unwrapChecks.change("trajectory-unwrap-enabled",true)');
  await delay(120);
  assert.equal(await evaluate('unwrapChecks.unwraps.length'), 0, 'enabling Unwrap alone cannot scan missing metadata');
  assert.match(await evaluate('document.getElementById("trajectory-unwrap-status").textContent'), /no image|missing|Enable/i);
  await evaluate('unwrapChecks.holdInference=true;unwrapChecks.change("trajectory-infer-unwrap",true)');
  await waitFor('unwrapChecks.held.length>0 && unwrapChecks.unwraps.some(item=>item.infer)', 'Separate inference opt-in');
  assert.equal(await evaluate('document.getElementById("loading").hidden'), true);
  await evaluate('unwrapChecks.jump(3,true)');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===2 && unwrapChecks.unwraps.some(item=>item.infer&&item.index===2)', 'Random seek while old inference is held');
  assert.equal(await evaluate('unwrapChecks.originalWorker===unwrapChecks.client.worker'), true);
  assert.equal(await evaluate('unwrapChecks.unwraps.some(item=>item.index===164&&item.aborted)'), true);
  await evaluate('unwrapChecks.release()');
  await waitFor('Math.abs(unwrapChecks.renderer.rawDisplayPositions[0]-13.6)<1e-4', 'Continuous coordinates after opt-in');
  const inferred = await evaluate('unwrapChecks.snapshot()');
  assert.ok(Math.abs(inferred.wrappedX-3.6)<1e-4, 'analytical coordinates stay wrapped');
  assert.equal(inferred.hasInferred, true);
  await evaluate('unwrapChecks.change("trajectory-infer-unwrap",false)');
  await waitFor('Math.abs(unwrapChecks.renderer.rawDisplayPositions[0]-3.6)<1e-4', 'Disabling inference ignores its cached coordinates');
  assert.equal(await evaluate('unwrapChecks.renderer.frame.inferredUnwrap != null'), true, 'retained cache is gated by opt-in');
  const beforeReuse = await evaluate('unwrapChecks.unwraps.length');
  await evaluate('unwrapChecks.change("trajectory-infer-unwrap",true)');
  await waitFor('Math.abs(unwrapChecks.renderer.rawDisplayPositions[0]-13.6)<1e-4', 'Re-enable cached inference');
  assert.equal(await evaluate('unwrapChecks.unwraps.length'), beforeReuse, 're-enabling an already computed frame reuses the result');
  await evaluate('unwrapChecks.change("trajectory-unwrap-enabled",false)');
  await waitFor('document.getElementById("coordinate-mode").value==="file" && Math.abs(unwrapChecks.renderer.rawDisplayPositions[0]-3.6)<1e-4', 'Unwrap off returns to source positions');

  await evaluate('unwrapChecks.unwraps.length=0;unwrapChecks.open("images")');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===0 && /images/.test(document.getElementById("file-name").textContent) && document.getElementById("loading").hidden', 'CFG folder with explicit image counts');
  const defaultImages = await evaluate('unwrapChecks.snapshot()');
  assert.equal(defaultImages.selected, 'file'); assert.equal(defaultImages.unwrap, false); assert.equal(defaultImages.inference, false);
  assert.equal(defaultImages.hasUnwrapped, false); assert.ok(Math.abs(defaultImages.x-.2)<1e-5);
  assert.equal(await evaluate('unwrapChecks.unwraps.length'), 0, 'image metadata is not materialized before opt-in');
  await evaluate('unwrapChecks.jump(165)');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===164', 'Direct seek with image metadata');
  await evaluate('unwrapChecks.change("trajectory-unwrap-enabled",true)');
  await waitFor('Math.abs(unwrapChecks.renderer.rawDisplayPositions[0]-1670.2)<1e-3', 'Single-frame reconstruction from image counts');
  const explicit = await evaluate('unwrapChecks.snapshot()');
  assert.ok(Math.abs(explicit.wrappedX-.2)<1e-5);
  assert.ok((await evaluate('unwrapChecks.unwraps')).every(item=>item.infer===false));

  await evaluate('unwrapChecks.unwraps.length=0;unwrapChecks.open("outside",3)');
  await waitFor('unwrapChecks.renderer.frame.frameIndex===0 && /outside/.test(document.getElementById("file-name").textContent) && document.getElementById("loading").hidden', 'Out-of-cell file coordinates');
  const outside = await evaluate('unwrapChecks.snapshot()');
  assert.equal(outside.selected, 'file'); assert.equal(outside.hasUnwrapped, false);
  assert.ok(Math.abs(outside.x-12.5)<1e-5); assert.ok(Math.abs(outside.wrappedX-2.5)<1e-5);
  assert.equal(await evaluate('unwrapChecks.unwraps.length'), 0);
  await evaluate('unwrapChecks.change("trajectory-unwrap-enabled",true)');
  await waitFor('document.getElementById("trajectory-unwrap-enabled").checked && Math.abs(unwrapChecks.renderer.rawDisplayPositions[0]-12.5)<1e-5', 'Existing continuous coordinates remain unchanged');
  assert.ok((await evaluate('unwrapChecks.unwraps')).every(item=>!item.infer));

  await call('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:false });
  await delay(100);
  const mobile = await evaluate(`(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    return{bar:rect('trajectory-section'),input:rect('frame-jump-input'),button:rect('frame-jump-go'),slider:rect('frame-slider')};})()`);
  assert.ok(mobile.input.x>=mobile.bar.x && mobile.button.right<=mobile.bar.right, JSON.stringify(mobile));
  assert.ok(mobile.input.right<=mobile.button.x && mobile.slider.y>=mobile.button.bottom, JSON.stringify(mobile));
  assert.ok(mobile.bar.x>=0 && mobile.bar.right<=390, JSON.stringify(mobile));
  const screenshot = `/tmp/alloyview-explicit-unwrap-mobile${process.argv.includes('--isolated')?'-isolated':''}.png`;
  const captured = await call('Page.captureScreenshot', { format:'png' });
  await writeFile(screenshot, Buffer.from(captured.data,'base64'));
  await evaluate('document.getElementById("close-file").click()');
  await waitFor('!unwrapChecks.renderer.frame && !unwrapChecks.client.worker', 'Source close');
  for (const id of ['frame-jump-input','frame-jump-go','trajectory-unwrap-enabled','trajectory-infer-unwrap']) {
    assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).disabled`), true, id);
  }
  return { files:165, inferred, explicit, outside, mobile, screenshot, glError:await evaluate('unwrapChecks.renderer.gl.getError()') };
}, { requireGpu:false, isolated:process.argv.includes('--isolated') });
assert.equal(result.glError, 0);
console.log(JSON.stringify({ result:'passed', ...result },null,2));
