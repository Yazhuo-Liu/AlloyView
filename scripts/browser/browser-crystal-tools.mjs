import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Real file selection, parser Workers, hull Workers, WebGL pixels and download
// callbacks on a Pages-like path. Software rendering checks correctness only.
const root = resolve(import.meta.dirname, '../..');
const production = process.argv.includes('--production');
if (production) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const artifacts = resolve(tmpdir(), 'alloyview-crystal-tools');
await mkdir(artifacts, {recursive:true});

const report = await withWebGpuBrowser(async ({evaluate,call}) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setDeviceMetricsOverride', {width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate', {url:`${origin}/AlloyView/${production ? 'dist/' : ''}index.html`});
  async function waitFor(expression, label, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(30); }
    throw new Error(`${label}: ${JSON.stringify(await evaluate(`({file:document.getElementById('file-name')?.textContent,
      state:document.getElementById('crystal-state')?.textContent,status:document.getElementById('crystal-status')?.textContent,
      toast:document.getElementById('toast')?.textContent})`))}`);
  }
  await waitFor('document.readyState==="complete" && document.getElementById("run-crystal")', 'Crystal UI');
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
  async function load(path) {
    const {root:document} = await call('DOM.getDocument');
    const {nodeId} = await call('DOM.querySelector', {nodeId:document.nodeId,selector:'#file-input'});
    await call('DOM.setFileInputFiles', {nodeId,files:[resolve(root,path)]});
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await waitFor(`document.getElementById('file-name').textContent===${JSON.stringify(basename(path))}
      && document.getElementById('loading').hidden && crystalChecks.renderer?.atomCount===5`, `load ${path}`);
  }
  async function selectType(id,label) {
    const details = `#${id}`;
    if (await evaluate(`!document.querySelector('${details}').closest('details').open`)) {
      await evaluate(`document.querySelector('${details}').closest('details').open=true`);
    }
    await press(`${details} input[value="*"]`);
    await press(`${details} input[value="${label}"]`);
  }
  async function download(selector) {
    await evaluate('crystalChecks.beginDownload()');
    await press(selector);
    await waitFor('crystalChecks.download!==null', `download ${selector}`);
    return evaluate('crystalChecks.finishDownload()');
  }
  const pixels = (view='renderer') => evaluate(`crystalChecks.pixels(${JSON.stringify(view)})`);
  await load('examples/crystals/SrTiO3.cif');
  await tool('crystal');
  assert.equal(await evaluate('document.getElementById("crystal-cell-lengths").textContent'), '3.905 · 3.905 · 3.905');
  assert.equal(await evaluate('document.getElementById("crystal-cell-angles").textContent'), '90 · 90 · 90');
  assert.ok(Math.abs(Number(await evaluate('document.getElementById("crystal-cell-volume").textContent')) - 3.905**3) < 1e-5);
  assert.match(await evaluate('document.getElementById("crystal-space-group").textContent'), /221/);
  assert.match(await evaluate('document.getElementById("crystal-sites").textContent'), /3 asymmetric sites.*5 symmetry-expanded sites/);
  assert.match(await evaluate('document.getElementById("crystal-symmetry").textContent'), /48.*symmetry operations/);
  assert.equal(await evaluate('crystalChecks.renderer.coordinationPolyhedra'), null, 'polyhedra are opt-in');
  await selectType('crystal-center-types','Ti');
  await selectType('crystal-neighbor-types','O');
  await change('crystal-cutoff','2.2');
  await press('#run-crystal');
  await waitFor('document.getElementById("crystal-state").textContent==="Calculated" && crystalChecks.renderer.coordinationPolyhedra?.geometry?.cellCount===1', 'Ti oxygen octahedron');
  const scientific = await evaluate(`(() => { const result=crystalChecks.renderer.coordinationPolyhedra,cell=result.cells[0];
    crystalChecks.savedResult=result; crystalChecks.savedMesh=crystalChecks.renderer.coordinationPolyhedraLayer.chunks[0].buffer;
    return {coordination:cell.coordination,vertices:cell.vertices.length/3,faces:cell.faceOffsets.length-1,
      volume:cell.volume,summary:result.summary,backend:document.getElementById('crystal-backend').textContent,jobs:crystalChecks.jobs}; })()`);
  assert.equal(scientific.coordination,6); assert.equal(scientific.vertices,6); assert.equal(scientific.faces,8);
  assert.ok(Math.abs(scientific.volume - 3.905**3/6) < 1e-7);
  assert.equal(scientific.summary.selected,1); assert.equal(scientific.summary.constructed,1);
  assert.match(scientific.backend,/CPU/);

  await tool('display'); await change('radius-percent','35','input');
  await change('png-legend',false,'change',true); await change('png-axes',false,'change',true);
  await tool('crystal');
  const withHull = await pixels();
  await change('crystal-visible',false,'change',true);
  assert.notEqual((await pixels()).hash,withHull.hash,'hulls change actual WebGL pixels');
  await change('crystal-visible',true,'change',true);
  await change('crystal-color','#ed5b35','input'); await change('crystal-opacity','.65','input');
  const styled = await pixels(); assert.notEqual(styled.hash,withHull.hash,'color and opacity update actual pixels');
  await change('crystal-edges',false,'change',true);
  const noEdges = await pixels(); assert.notEqual(noEdges.hash,styled.hash,'polygon edges can be hidden');
  await change('crystal-edges',true,'change',true);
  const center = await evaluate('crystalChecks.centerPoint()');
  assert.ok(center.reachable && center.pick===center.atom,`central Ti can be picked: ${JSON.stringify(center)}`);
  for (const type of ['mousePressed','mouseReleased']) await call('Input.dispatchMouseEvent',
    {type,x:center.x,y:center.y,button:'left',clickCount:1});
  await waitFor('crystalChecks.renderer.coordinationPolyhedraLayer.highlightedCellCount===1','selected polyhedron highlight');
  assert.equal(await evaluate('crystalChecks.jobs'),scientific.jobs,'style and selection reuse the scientific calculation');
  assert.equal(await evaluate('crystalChecks.renderer.coordinationPolyhedraLayer.chunks[0].buffer===crystalChecks.savedMesh'),true,'style and picks reuse uploaded geometry');

  const csv = await download('#export-crystal-statistics');
  assert.match(csv.type,/text\/csv/); assert.match(csv.text,/coordination/i); assert.match(csv.text,/volume/i);
  assert.equal(csv.text.trim().split(/\r?\n/).length,2,'one row per calculated central atom');
  await writeFile(resolve(artifacts,csv.filename),csv.text);
  const cif = await download('#export-crystal-cif'), poscar = await download('#export-crystal-poscar');
  assert.match(cif.text,/_space_group_IT_number 1\b/);
  assert.match(cif.text,/_atom_site_occupancy/); assert.match(poscar.text,/Sr Ti O\r?\n1 1 3/);
  await writeFile(resolve(artifacts,cif.filename),cif.text); await writeFile(resolve(artifacts,poscar.filename),poscar.text);

  await tool('display'); await change('compare-view',true,'change',true);
  await waitFor('crystalChecks.comparison?.coordinationPolyhedra===crystalChecks.renderer.coordinationPolyhedra','second view shares hull result');
  const second = await pixels('comparison');
  const png = await download('#export-png'), secondPng = await download('#export-comparison-png');
  assert.match(png.type,/image\/png/); assert.match(secondPng.type,/image\/png/);
  await writeFile(resolve(artifacts,'crystal-main.png'),Buffer.from(png.bytes));
  await writeFile(resolve(artifacts,'crystal-second.png'),Buffer.from(secondPng.bytes));
  await tool('crystal'); await change('crystal-visible',false,'change',true);
  assert.notEqual((await pixels('comparison')).hash,second.hash,'second view follows visibility');
  const barePng = await download('#export-png');
  assert.notEqual(barePng.hash,png.hash,'main PNG includes the coordination hull');
  await change('crystal-visible',true,'change',true);
  assert.equal(await evaluate('crystalChecks.jobs'),scientific.jobs);
  const screenshot = await call('Page.captureScreenshot',{format:'png'});
  await writeFile(resolve(artifacts,'crystal-ui.png'),Buffer.from(screenshot.data,'base64'));

  await press('#cancel-crystal');
  assert.equal(await evaluate('crystalChecks.renderer.coordinationPolyhedra'),null);
  assert.equal(await evaluate('crystalChecks.comparison.coordinationPolyhedra'),null);
  await load('examples/crystals/POSCAR-SrTiO3'); await tool('crystal');
  assert.equal(await evaluate('document.getElementById("crystal-cell-lengths").textContent'),'3.905 · 3.905 · 3.905');
  assert.equal(await evaluate('document.getElementById("crystal-space-group").textContent'),'Not declared');
  assert.equal(await evaluate('crystalChecks.renderer.coordinationPolyhedra'),null,'new sources cannot retain old hulls');
  // Re-import the exported expanded CIF through the normal input handler.
  await evaluate(`(() => {const data=new DataTransfer();data.items.add(new File([${JSON.stringify(cif.text)}],'roundtrip.cif'));
    const input=document.getElementById('file-input');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await waitFor('document.getElementById("file-name").textContent==="roundtrip.cif" && document.getElementById("loading").hidden && crystalChecks.renderer?.atomCount===5','expanded CIF round trip');
  const finalTypes = await evaluate('crystalChecks.renderer.frame.typeLabels');
  assert.deepEqual([...finalTypes].sort(),['O','Sr','Ti']);
  return {production,atoms:5,asymmetricSites:3,symmetryOperations:48,scientific,workerPackedGeometry:true,
    styleReused:true,secondView:true,pngExport:true,cifRoundTrip:true,poscarLoaded:true,artifacts};
},{requireGpu:false});
await writeFile(resolve(artifacts,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

async function initializeChecks() {
  const app = document.querySelector('script[type="module"]').src;
  const [{WebGLRenderer},{AnalysisPool},{transformPoint}] = await Promise.all([
    import(new URL('./render/webgl-renderer.js',app)),import(new URL('./analysis/analysis-pool.js',app)),
    import(new URL('./render/math.js',app)),
  ]);
  const checks = window.crystalChecks = {jobs:0,download:null};
  const setFrame = WebGLRenderer.prototype.setFrame, analyze = AnalysisPool.prototype.analyze;
  WebGLRenderer.prototype.setFrame = function(...args) {
    checks[this.canvas.id==='viewport'?'renderer':'comparison']=this;
    return setFrame.apply(this,args);
  };
  AnalysisPool.prototype.analyze = function(frame,parameters,...args) {
    if(parameters.kind==='coordinationPolyhedra') checks.jobs++;
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
  checks.centerPoint = () => {
    const r=checks.renderer,atom=r.coordinationPolyhedra.cells[0].atomIndex;
    r.updateMatrices();const point=transformPoint(r.viewProjectionMatrix,...r.displayPositions.subarray(atom*3,atom*3+3));
    const box=r.canvas.getBoundingClientRect(),x=box.left+(point[0]/point[3]+1)*box.width/2,y=box.top+(1-point[1]/point[3])*box.height/2;
    return {x,y,atom,pick:r.pick(x,y),reachable:document.elementFromPoint(x,y)===r.canvas};
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
