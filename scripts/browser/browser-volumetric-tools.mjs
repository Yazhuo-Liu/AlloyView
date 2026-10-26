import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Real file selection, parser/volume Workers, WebGL pixels and download
// callbacks on a Pages-like path. Software rendering checks correctness only.
const root = resolve(import.meta.dirname, '../..');
const production = process.argv.includes('--production');
if (production) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const artifacts = resolve(tmpdir(), 'alloyview-volumetric-tools');
await mkdir(artifacts, {recursive:true});

const report = await withWebGpuBrowser(async ({evaluate,call}) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate', {url:`${origin}/AlloyView/${production ? 'dist/' : ''}index.html`});
  async function waitFor(expression, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
    throw new Error(`${label}: ${JSON.stringify(await evaluate(`({file:document.getElementById('file-name')?.textContent,
      state:document.getElementById('volume-state')?.textContent,status:document.getElementById('volume-status')?.textContent,
      toast:document.getElementById('toast')?.textContent})`))}`);
  }
  await waitFor('document.readyState==="complete" && document.getElementById("run-volume")', 'Volume UI');
  await evaluate(`(${initializeChecks.toString()})()`);
  async function press(selector) {
    const point = await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)});
      if(!element) throw new Error('Missing '+${JSON.stringify(selector)});
      element.scrollIntoView({block:'nearest',inline:'nearest'}); const r=element.getBoundingClientRect();
      const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
      return {x,y,enabled:!element.disabled,reachable:element===hit||element.contains(hit),hit:hit?.id}; })()`);
    assert.ok(point.enabled && point.reachable, `${selector}: ${JSON.stringify(point)}`);
    for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',
      {type,x:point.x,y:point.y,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
    await delay(30);
  }
  async function change(id,value,event='change',checkbox=false) {
    await evaluate(`(() => { const element=document.getElementById(${JSON.stringify(id)});
      element.${checkbox?'checked':'value'}=${JSON.stringify(value)};
      element.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true})); })()`);
  }
  async function tool(name) {
    const selector = `[data-tool-button="${name}"]`;
    const category = await evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
    if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')!=='true'`)) await press(`#tool-category-${category}`);
    if (await evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')!=='true'`)) await press(selector);
  }
  async function load(path, atoms) {
    const {root:document} = await call('DOM.getDocument');
    const {nodeId} = await call('DOM.querySelector', {nodeId:document.nodeId,selector:'#file-input'});
    await call('DOM.setFileInputFiles', {nodeId,files:[resolve(root,path)]});
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(basename(path))}
      && document.getElementById('loading').hidden && volumeChecks.renderer?.atomCount===${atoms}`, `load ${path}`);
  }
  async function download(selector) {
    await evaluate('volumeChecks.beginDownload()');
    await press(selector);
    await waitFor('volumeChecks.download!==null', `download ${selector}`);
    return evaluate('volumeChecks.finishDownload()');
  }
  const pixels = (view='renderer') => evaluate(`volumeChecks.pixels(${JSON.stringify(view)})`);
  await load('examples/volumetric/CHGCAR',2);
  await tool('volumetric');
  assert.equal(await evaluate('volumeChecks.renderer.volumetricSurface'),null,'volume analysis defaults off');
  assert.match(await evaluate('document.getElementById("volume-info").textContent'),/32 × 32 × 32.*e\/Å³/);
  assert.match(await evaluate('document.getElementById("volume-info").textContent'),/Integral 2 e/);
  if(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true"')) await press('#enable-gpu-computing');
  await change('volume-level','0.1');await press('#run-volume');
  await waitFor('document.getElementById("volume-state").textContent==="Calculated" && volumeChecks.renderer.volumetricSurface','CPU density surface');
  const cpu=await evaluate(`(() => {const r=volumeChecks.renderer,m=r.volumetricSurface;
    volumeChecks.saved=m;volumeChecks.buffer=r.volumetricLayer.positionBuffer;
    return {triangles:m.triangleCount,area:m.statistics.surfaceArea,backend:m.backend,jobs:volumeChecks.jobs,packed:m.renderGeometry.positions.length};})()`);
  assert.equal(cpu.backend,'cpu');assert.ok(cpu.triangles>100);assert.equal(cpu.packed,cpu.triangles*9);
  const first=await pixels();await change('volume-visible',false,'change',true);
  assert.notEqual((await pixels()).hash,first.hash,'isosurface contributes real pixels');
  await change('volume-visible',true,'change',true);await change('volume-color','#fa6b31','input');await change('volume-opacity','.55','input');
  assert.notEqual((await pixels()).hash,first.hash,'surface style updates real pixels');
  assert.equal(await evaluate('volumeChecks.jobs'),cpu.jobs);assert.equal(await evaluate('volumeChecks.renderer.volumetricLayer.positionBuffer===volumeChecks.buffer'),true);
  await evaluate('document.getElementById("volume-slice-enabled").closest("details").open=true');
  await change('volume-slice-index','8');await change('volume-slice-enabled',true,'change',true);
  await waitFor('!document.getElementById("volume-slice-results").hidden && !document.getElementById("export-volume-slice").disabled','density section');
  assert.match(await evaluate('document.getElementById("volume-slice-limits").textContent'),/32 × 32 native samples/);
  const csv=await download('#export-volume-slice');assert.equal(csv.text.trim().split(/\r?\n/).length,1025);assert.match(csv.text,/x_A,y_A,z_A,value,unit/);
  await writeFile(resolve(artifacts,'density-section.csv'),csv.text);
  await tool('display');await change('compare-view',true,'change',true);
  await waitFor('volumeChecks.comparison?.volumetricSurface===volumeChecks.renderer.volumetricSurface','second-view volume');
  const png=await download('#export-png'),second=await download('#export-comparison-png');
  assert.equal(png.type,'image/png');assert.equal(second.type,'image/png');
  await writeFile(resolve(artifacts,'volume-main.png'),Buffer.from(png.bytes));await writeFile(resolve(artifacts,'volume-second.png'),Buffer.from(second.bytes));
  await tool('volumetric');await press('#enable-gpu-computing');await press('#run-volume');
  await waitFor('document.getElementById("volume-state").textContent==="Calculated" && volumeChecks.renderer.volumetricSurface!==volumeChecks.saved','GPU density surface');
  const gpu=await evaluate(`({backend:volumeChecks.renderer.volumetricSurface.backend,triangles:volumeChecks.renderer.volumetricSurface.triangleCount,
    area:volumeChecks.renderer.volumetricSurface.statistics.surfaceArea,label:document.getElementById('volume-backend').textContent,fallback:document.getElementById('volume-backend').title})`);
  assert.equal(gpu.backend,'gpu',gpu.fallback);assert.match(gpu.label,/GPU/);assert.equal(gpu.triangles,cpu.triangles);
  assert.ok(Math.abs(gpu.area-cpu.area)<cpu.area*1e-4);
  await press('#cancel-volume');assert.equal(await evaluate('volumeChecks.renderer.volumetricSurface'),null);
  assert.equal(await evaluate('volumeChecks.comparison.volumetricSurface'),null);
  await load('examples/volumetric/analytic-p-field.cube',1);await tool('volumetric');
  assert.match(await evaluate('document.getElementById("volume-info").textContent'),/Signed field/);
  assert.equal(await evaluate('volumeChecks.renderer.volumetricSurface'),null);
  await change('volume-level','-0.2');await press('#run-volume');
  await waitFor('document.getElementById("volume-state").textContent==="Calculated" && volumeChecks.renderer.volumetricSurface?.level===-.2','negative orbital isosurface');
  const negative=await evaluate('({triangles:volumeChecks.renderer.volumetricSurface.triangleCount,periodic:volumeChecks.renderer.volumetricSurface.grid.periodic})');
  assert.ok(negative.triangles>100);assert.deepEqual(negative.periodic,[false,false,false]);
  const screenshot=await call('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'volume-ui.png'),Buffer.from(screenshot.data,'base64'));
  await load('examples/crystals/SrTiO3.cif',5);
  assert.equal(await evaluate('volumeChecks.renderer.volumetricSurface'),null,'changing source clears old volume');
  assert.equal(await evaluate('document.getElementById("run-volume").disabled'),true,'structures without grids cannot start a volume job');
  return {production,cpu,gpu,negative,styleReused:true,secondView:true,pngExport:true,sectionCsvRows:1024,sourceReset:true,artifacts};
},{requireGpu:true});
await writeFile(resolve(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{WebGLRenderer},{VolumetricClient}] = await Promise.all([
    import(new URL('./render/webgl-renderer.js',app)),import(new URL('./analysis/volumetric-client.js',app)),
  ]);
  const checks = window.volumeChecks = {jobs:0,download:null};
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = VolumetricClient.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) {
    checks[this.canvas.id==='viewport'?'renderer':'comparison']=this;
    return setFrame.apply(this,args);
  };
  VolumetricClient.prototype.analyze = function(frame,parameters,...args) {
    checks.jobs++;
    return analyze.call(this,frame,parameters,...args);
  };
  const summarize = values => {
    let hash=2166136261;
    for(const value of values) hash=Math.imul(hash^value,16777619);
    return {hash:hash>>>0};
  };
  checks.pixels = (view='renderer') => {
    const canvas=checks[view].captureImage({includeBackground:true});
    return summarize(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data);
  };
  checks.beginDownload = () => {
    const urls=new Map(),create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;
    checks.download=null;
    URL.createObjectURL=function(blob){const url=create.call(this,blob);urls.set(url,blob);return url;};
    HTMLAnchorElement.prototype.click=function(){const blob=urls.get(this.href);if(blob) checks.download={blob,filename:this.download};};
    checks.restoreDownload=()=>{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;};
  };
  checks.finishDownload=async()=>{
    try {
      const {blob,filename}=checks.download;
      if(blob.type==='image/png') {
        const image=await createImageBitmap(blob),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
        canvas.getContext('2d').drawImage(image,0,0);image.close();
        return {filename,type:blob.type,...summarize(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data),
          bytes:Array.from(new Uint8Array(await blob.arrayBuffer()))};
      }
      return {filename,type:blob.type,text:await blob.text()};
    } finally {checks.restoreDownload();checks.download=null;}
  };
}
