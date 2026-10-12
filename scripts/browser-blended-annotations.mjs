import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

// Compare the production layer with the independent blending-only GL state.
// No spheres are drawn in this fixture, so disabling alpha-to-coverage on the
// oracle changes only cells/annotations; actual sphere antialiasing stays intact.
const production = process.argv.includes('--production');
const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  if (production) {
    const origin = await evaluate('location.origin');
    await call('Page.navigate', {url:`${origin}/AlloyView/dist/index.html`});
    const deadline = Date.now() + 30_000;
    while (!(await evaluate('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")'))) {
      if (Date.now() > deadline) throw new Error('Production page startup timed out.');
      await delay(25);
    }
  }
  return evaluate(`(${run.toString()})(${production})`);
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));
assert.equal(report.rows.every(row => row.differingBytes === 0 && row.drawPixels > 0), true);
assert.equal(report.exports.every(row => row.differingBytes === 0), true);
assert.ok(report.rows.some(row => row.samples > 0), 'A real multisampled context is required.');
assert.ok(report.negativeControls.some(row => row.samples > 0 && row.differingBytes > 0),
  'The old combined blending/coverage state must expose the opacity error.');

async function run(production) {
  const base = production ? document.querySelector('script[type=module][src]').src : new URL('./src/app.js', location.href);
  const module = path => import(new URL(path, base));
  const [{ WebGLRenderer }, { createCell, fractionalToCartesian }, { calculateVoronoiGeometry }, { createVoronoiCellBatch }] = await Promise.all([
    module('./render/webgl-renderer.js'), module('./data/model.js'), module('./analysis/voronoi.js'),
    module('./render/voronoi-cell-layer.js'),
  ]);
  const cell = createCell({ vectors: [2,0,0, 0,2,0, 0,0,2] });
  const frame = { cell, fractional: Float64Array.of(.5,.5,.5), types: Uint32Array.of(0), typeNames: ['Fe'],
    ids: Uint32Array.of(1), properties: {} };
  frame.positions = fractionalToCartesian(frame.fractional, cell);
  const geometry = await calculateVoronoiGeometry(frame, { atomIndex: 0 });
  const batch = { chunks: [createVoronoiCellBatch([geometry])], cellCount: 1, complete: true };
  const rows = [], exports = [], negativeControls = [];
  const different = (a,b) => { let count=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])count++;return count; };
  for (const antialias of [false,true]) {
    const renderers = [0,1].map(() => {
      const canvas=document.createElement('canvas');canvas.style.cssText='width:240px;height:180px';document.body.append(canvas);
      canvas.getContext('webgl2',{alpha:true,antialias,preserveDrawingBuffer:true});
      const renderer=new WebGLRenderer(canvas);renderer.requestRender=()=>{};
      renderer.setFrame(frame,Uint8Array.of(180,90,220));renderer.setBackground('#000000');renderer.setCellVisible(false);
      renderer.setView('front');
      const gl=renderer.gl, draw=gl.drawArraysInstanced.bind(gl);
      gl.drawArraysInstanced=(mode,first,count,instances) => {
        if (mode===gl.TRIANGLE_STRIP && count===4) return; // isolate the annotation opacity
        draw(mode,first,count,instances);
      };
      return renderer;
    });
    const [candidate, oracle] = renderers, gl = candidate.gl;
    const read = renderer => {
      renderer.render(performance.now(),{trackStats:false});
      const bytes=new Uint8Array(renderer.canvas.width*renderer.canvas.height*4);
      renderer.gl.readPixels(0,0,renderer.canvas.width,renderer.canvas.height,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,bytes);
      return bytes;
    };
    for (const mode of ['selected','all-xray','all-surface','cell-lines','slice-lines']) for (const opacity of [.25,.5,.75]) {
      for (const renderer of renderers) {
        renderer.setVoronoiCellGeometry(mode==='selected'?geometry:null,{enabled:mode==='selected',allEnabled:mode.startsWith('all-'),
          color:'#ffffff',opacity,style:mode==='all-surface'?'surface':'xray'});
        renderer.setVoronoiAllCellGeometry(mode.startsWith('all-')?batch:null);
        renderer.setCellVisible(mode==='cell-lines');
        renderer.setSlices(mode==='slice-lines'?[{id:'slice',normal:[0,0,1],position:1,side:'negative',enabled:true}]:[]);
        renderer.setSliceOutlines(mode==='slice-lines');
      }
      for (const coverage of [false,true]) {
        if(coverage) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);else gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        oracle.gl.disable(oracle.gl.SAMPLE_ALPHA_TO_COVERAGE);
        const bytes=read(candidate), expected=read(oracle);
        const drawPixels=bytes.reduce((total,value,index)=>total+Number(index%4!==3&&value!==0),0);
        if (gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE)!==coverage) throw Error('The incoming coverage state was not restored.');
        rows.push({antialias,samples:gl.getParameter(gl.SAMPLES),mode,opacity,coverage,differingBytes:different(bytes,expected),drawPixels});
        if(rows.at(-1).differingBytes)throw Error(JSON.stringify(rows.at(-1)));
      }
      if(mode==='selected') {
        gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
        const expected=read(oracle), actualIsEnabled=gl.isEnabled.bind(gl);
        // Reproduce the old layer state without replacing either shader.
        gl.isEnabled=capability=>capability===gl.SAMPLE_ALPHA_TO_COVERAGE?false:actualIsEnabled(capability);
        try { negativeControls.push({samples:gl.getParameter(gl.SAMPLES),opacity,differingBytes:different(read(candidate),expected)}); }
        finally { gl.isEnabled=actualIsEnabled; }
      }
    }
    for (const mode of ['selected','all-surface','slice-lines']) for (const offscreen of [false,true]) for (const includeBackground of [false,true]) {
      for(const renderer of renderers) {
        renderer.setVoronoiCellGeometry(mode==='selected'?geometry:null,{enabled:mode==='selected',allEnabled:mode==='all-surface',
          color:'#ffffff',opacity:.5,style:mode==='all-surface'?'surface':'xray'});
        renderer.setVoronoiAllCellGeometry(mode==='all-surface'?batch:null);renderer.setCellVisible(false);
        renderer.setSlices(mode==='slice-lines'?[{id:'slice',normal:[0,0,1],position:1,side:'negative',enabled:true}]:[]);
        renderer.setSliceOutlines(mode==='slice-lines');
      }
      gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);oracle.gl.disable(oracle.gl.SAMPLE_ALPHA_TO_COVERAGE);
      const images=[];
      for(const renderer of renderers) {
        const image=await renderer.captureImage({includeBackground,includeAxes:false,forceOffscreen:offscreen,tileSize:128,
          resolution:offscreen?{mode:'custom',width:360,height:270}:{mode:'current'}});
        images.push(image.getContext('2d').getImageData(0,0,image.width,image.height).data);
      }
      if(!gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE))throw Error('Image capture changed atom coverage.');
      exports.push({antialias,mode,offscreen,includeBackground,differingBytes:different(...images)});
      if(exports.at(-1).differingBytes)throw Error(JSON.stringify(exports.at(-1)));
    }
    for(const renderer of renderers) renderer.canvas.remove();
  }
  return {production,rows,exports,negativeControls,note:'Strict byte equality to the independent alpha-blending state; real single-sample and 4x MSAA canvases, current and tiled opaque/transparent exports. SwiftShader is not a physical-GPU performance result.'};
}
