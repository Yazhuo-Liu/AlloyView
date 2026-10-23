import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';
const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ call, evaluate }) => {
  if (production) {
    const origin = await evaluate('location.origin'); await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    const deadline = Date.now() + 30000;
    while (!await evaluate('document.readyState === "complete" && document.getElementById("viewport")')) {
      if (Date.now() > deadline) throw new Error('Production startup timeout'); await delay(25);
    }
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true') document.getElementById('enable-gpu-computing').click()`);
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
  return evaluate(`(${checks.toString()})(${production})`);
}, { requireGpu: false, software: !process.argv.includes('--hardware') });
for (const row of report.scenes) { assert.equal(row.pixelDifferences, 0, row.name); assert.equal(row.exportDifferences, 0, row.name); assert.equal(row.glError, 0); }
console.log(JSON.stringify(report, null, 2));
async function checks(production) {
  const base = production ? new URL('./', document.querySelector('script[type=module][src]').src) : new URL('/AlloyView/src/', location.href);
  const [{ WebGLRenderer }, { createCell, fractionalToCartesian }, { AmbientOcclusionController }, { orderedOpaqueReplicas }] = await Promise.all([
    import(new URL('render/webgl-renderer.js', base)), import(new URL('data/model.js', base)), import(new URL('render/ambient-occlusion.js', base)),
    import(new URL('render/conservative-depth.js', base)),
  ]);
  function make(mode) {
    const canvas = document.createElement('canvas'); canvas.style.cssText='width:360px;height:240px'; document.body.append(canvas);
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: true, preserveDrawingBuffer: true });
    if (mode==='reference') gl.getSupportedExtensions = undefined;
    if (mode==='geometry') {
      const shaderSource = gl.shaderSource.bind(gl);
      gl.shaderSource = (shader, source) => shaderSource(shader, source.replace('#extension GL_EXT_conservative_depth : require','')
        .replace('layout(depth_greater) out highp float gl_FragDepth;', ''));
    }
    const renderer = new WebGLRenderer(canvas); renderer.conservativeDepthMode = mode;
    // The reference keeps both the original shader and original draw order.
    // Comparing two renderers with identical ordering would miss LEQUAL ties.
    if (mode==='reference') renderer.opaqueReplicaOrdering = false;
    return renderer;
  }
  const reference = make('reference'), candidate = make('geometry'), actual = make('actual'), renderers = [reference,candidate,actual];
  const cell = createCell({ vectors: [8,0,0, 2,7,0, -1,1,6] });
  const fractional = Float64Array.from({length:192}, (_,i)=>(i*.6180339887)%1);
  const frame = { cell, fractional, positions: fractionalToCartesian(fractional,cell), ids: Uint32Array.from({length:64},(_,i)=>i+1) };
  const colors = Uint8Array.from({length:192},(_,i)=>40+(i*83)%215), radii = new Float32Array(64).fill(.7);
  for(const r of renderers) r.setFrame(frame,colors,frame.positions,radii);
  const pixels = r => { r.render(performance.now(),{trackStats:false}); const gl=r.gl,data=new Uint8Array(r.canvas.width*r.canvas.height*4);
    gl.readPixels(0,0,r.canvas.width,r.canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data; };
  const image = r => { const canvas=r.captureImage({includeBackground:false,includeLegend:false,includeAxes:false});return canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data; };
  const differences = (a,b) => { if(a.length!==b.length)throw new Error('Image dimensions differ');let count=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])count++;return count; };
  const scenes=[];
  function compare(name) {
    for(const r of [candidate,actual])r.setCameraState(reference.getCameraState());
    const a=pixels(reference), png=image(reference);
    for(const r of [candidate,actual]) scenes.push({name:`${name} / ${r.conservativeDepthMode}`,pixelDifferences:differences(a,pixels(r)),
      exportDifferences:differences(png,image(r)),glError:r.gl.getError()});
  }
  compare('perspective');
  for(const r of renderers) { r.setView('top'); r.setProjection('orthographic'); }
  compare('orthographic top');
  for(const r of renderers) { r.setReplications([2,2,2]); r.setSelectedAtoms([2,7]); }
  compare('skew replicas and selected atoms');
  for(const r of renderers) { r.setPeriodicOrigin([.23,-.1,.37]); r.setRadiusScale(1.7); }
  compare('shifted origin and large radii');
  for(const r of renderers) { r.setSiteMarkers({positions:Float64Array.from([2,2,2,6,4,3]),colors:Uint8Array.from([255,40,10,40,80,255])},{visible:true,radius:.9}); }
  compare('vacancy sphere markers');
  for(const r of renderers) { r.setAmbientOcclusion(new Float32Array(64*8).fill(.6),{intensity:.8}); r.setProjection('perspective'); r.distance=.8; }
  compare('near sphere camera and AO colors');
  const controllers = renderers.map(renderer => new AmbientOcclusionController(renderer));
  for (const controller of controllers) { controller.setSettings({ enabled: true, directions: 16, resolution: 256 }); controller.ensureCurrent(); }
  const aoIdDifferences = differences(reference.ambientOcclusionFactors, candidate.ambientOcclusionFactors);
  if (aoIdDifferences) throw new Error('AO ID passes differ: '+aoIdDifferences);
  compare('computed ambient occlusion ID passes');
  for (const controller of controllers) controller.dispose();
  const thinFractional = Float64Array.from(fractional, (value,index) => index%3===2 ? .15+value*.02 : value);
  const thin = { ...frame, fractional:thinFractional, positions:fractionalToCartesian(thinFractional,cell) };
  for (const r of renderers) {
    r.setFrame(thin,colors,thin.positions,radii); r.setReplications([1,1,3]); r.setRadiusScale(.15); r.setView('top');
    r.setAmbientOcclusion(Float32Array.from({length:64*3},(_,index)=>.2+.3*Math.floor(index/64)),{intensity:.8});
  }
  compare('separated replicas nearest-first with distinct per-copy AO');
  const sortedOrdinals = orderedOpaqueReplicas(candidate).map(row=>row.ordinal);
  if (sortedOrdinals.join(',') !== '2,1,0') throw new Error('Separated copies did not exercise actual nearest-first rendering: '+sortedOrdinals);
  const capability={supported:actual.conservativeDepth.supported,reason:actual.conservativeDepth.reason??null};
  for(const r of renderers) {r.clearFrame();r.resizeObserver.disconnect();}
  return {production,dpr:devicePixelRatio,aoIdDifferences,sortedOrdinals,capability,geometryVariant:'Actual nearest-z shader, qualifier stripped only for geometry correctness on unsupported adapters',scenes};
}
