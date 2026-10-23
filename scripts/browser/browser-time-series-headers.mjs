import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

const root=resolve(import.meta.dirname,'../..'),source=process.argv.includes('--source');
if(!source)assert.ok(existsSync(resolve(root,'dist/index.html')),'Run npm run build first.');
const directory=await mkdtemp(resolve(tmpdir(),'alloyview-series-headers-'));
const target=resolve(directory,'metadata.dump'),count=20;
const a=index=>10+index*index*.01;
await writeFile(target,Array.from({length:count},(_,index)=>`ITEM: TIMESTEP\n${index*25}\nITEM: NUMBER OF ATOMS\n2\nITEM: BOX BOUNDS pp pp pp\n0 ${a(index)}\n0 10\n0 10\nITEM: ATOMS id type xs ys zs energy\n1 1 .2 .2 .2 ${index}\n2 1 .8 .8 .8 ${index+2}\n`).join(''));
try {
  const runs=[];
  for(const isolated of [false,true])runs.push(await withWebGpuBrowser(async({call,evaluate})=>{
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(Navigator.prototype,'hardwareConcurrency',{configurable:true,get:()=>5});`});
    const origin=await evaluate('location.origin');
    await call('Page.navigate',{url:`${origin}/AlloyView/${source?'':'dist/'}index.html`});
    const wait=async(expression,label)=>{const until=Date.now()+60_000;while(Date.now()<until){if(await evaluate(expression))return;await delay(25);}
      throw new Error(label+': '+await evaluate(`JSON.stringify({toast:document.getElementById('toast')?.textContent,state:document.getElementById('time-series-state')?.textContent,status:document.getElementById('time-series-status')?.textContent,smoothing:document.getElementById('trajectory-smooth-status')?.textContent,replicate:document.getElementById('replicate-summary')?.textContent,view:headerChecks?.renderer?.frame?.frameIndex,requests:headerChecks?.requests.slice(-5)})`));};
    await wait('document.readyState==="complete"&&document.querySelector("[data-tool-button=timeSeries]")','Application startup');
    await evaluate(`(async()=>{
      if(document.getElementById('enable-gpu-computing').getAttribute('aria-pressed')==='true')document.getElementById('enable-gpu-computing').click();
      const app=document.querySelector('script[type=module][src]').src;
      const {StructureWorkerClient}=await import(new URL('./data/structure-worker-client.js',app));
      const {WebGLRenderer}=await import(new URL('./render/webgl-renderer.js',app));
      const checks=window.headerChecks={phase:'idle',requests:[],responses:[],downloads:[],maximumCpu:0};
      const request=StructureWorkerClient.prototype.request;
      StructureWorkerClient.prototype.request=function(type,payload,options){checks.client=this;
        if(['frame','frame-header'].includes(type))checks.requests.push({type,index:payload.index,phase:checks.phase,trajectory:payload.trajectory});
        return request.call(this,type,payload,options).then(result=>{if(type==='frame-header'){
          checks.responses.push({index:payload.index,keys:Object.keys(result.header??{}),atoms:result.header?.atomCount});
        }return result;});};
      const read=StructureWorkerClient.prototype.frame;
      // Keep the fixture's tail deliberately uncached: speculative input is
      // optional. Actual foreground and collection subscriptions remain real.
      StructureWorkerClient.prototype.frame=function(index,options){if(options?.background&&checks.phase==='idle')return Promise.reject(new DOMException('Audit skips speculative cache fill','AbortError'));return read.call(this,index,options);};
      const set=WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame=function(...args){if(this.canvas.id==='viewport')checks.renderer=this;return set.apply(this,args);};
      const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{if(blob.type==='text/csv')checks.downloads.push(blob);return create(blob);};
      HTMLAnchorElement.prototype.click=function(){};
      checks.change=(id,value,checkbox=false)=>{const field=document.getElementById(id);if(checkbox)field.checked=value;else field.value=value;field.dispatchEvent(new Event('change',{bubbles:true}));};
      checks.add=name=>{document.getElementById('time-series-attribute').value=name;document.getElementById('add-time-series-attribute').click();};
      checks.table=async()=>{document.getElementById('export-time-series').click();await Promise.resolve();return checks.downloads.at(-1).text();};
      checks.samples=setInterval(()=>{checks.maximumCpu=Math.max(checks.maximumCpu,checks.client?.cpuBudget?.active??0);},10);
    })()`);
    const {root:dom}=await call('DOM.getDocument'),{nodeId}=await call('DOM.querySelector',{nodeId:dom.nodeId,selector:'#file-input'});
    await call('DOM.setFileInputFiles',{nodeId,files:[target]});
    await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    await wait(`headerChecks.renderer?.frame?.frameIndex===0&&document.getElementById('frame-count').textContent==='${count}'&&document.getElementById('loading').hidden`,'Indexed source');
    await evaluate(`document.querySelector('[data-tool-button=timeSeries]').click();headerChecks.phase='headers';headerChecks.add('AtomCount');headerChecks.add('NumberDensity');headerChecks.add('Timestep');headerChecks.add('Strain.a');headerChecks.change('time-series-strain-reference','15');document.getElementById('collect-time-series').click();`);
    await wait(`document.getElementById('time-series-state').textContent==='Complete'&&document.querySelector('#time-series-chart path[data-series="Cell.volume"]')?.dataset.pointCount==='${count}'`,'Header-only collection');
    const headers=await evaluate(`(async()=>({requests:headerChecks.requests.filter(item=>item.phase==='headers'),responses:headerChecks.responses,view:headerChecks.renderer.frame.frameIndex,cpu:headerChecks.maximumCpu,budget:headerChecks.client.cpuBudget.limit,csv:await headerChecks.table()}))()`);
    assert.ok(headers.requests.filter(item=>item.type==='frame-header').length>=count-1,'Uncached frames must use real header requests');
    assert.equal(headers.requests.filter(item=>item.type==='frame').length,0,'Metadata and reference cell do not parse atom arrays');
    assert.equal(headers.view,0);assert.ok(headers.cpu<=headers.budget);
    for(const response of headers.responses)for(const key of ['ids','positions','types','fractional','properties','imageFlags'])assert.ok(!response.keys.includes(key),key);
    const rows=headers.csv.trim().split('\r\n').slice(1).map(line=>line.split(','));
    assert.equal(rows.length,count);
    for(const [index,row]of rows.entries()){
      assert.equal(Number(row[3]),a(index)*100);assert.equal(Number(row[4]),2);assert.equal(Number(row[6]),index*25);
      assert.ok(Math.abs(Number(row[7])-(a(index)-a(14))/a(14))<1e-14);
    }
    await evaluate(`headerChecks.phase='mixed';headerChecks.add('Mean.energy');document.getElementById('collect-time-series').click();`);
    await wait(`document.getElementById('time-series-state').textContent==='Complete'&&document.querySelector('#time-series-chart path[data-series="Mean.energy"]')?.dataset.pointCount==='${count}'`,'Mixed columns collection');
    const mixed=await evaluate(`(async()=>({reads:headerChecks.requests.filter(item=>item.phase==='mixed'),csv:await headerChecks.table()}))()`);
    assert.ok(mixed.reads.some(item=>item.type==='frame'));assert.equal(mixed.reads.some(item=>item.type==='frame-header'),false);
    for(const[index,row]of mixed.csv.trim().split('\r\n').slice(1).entries())assert.equal(Number(row.split(',')[8]),index+1);
    await evaluate(`document.querySelector('#time-series-attribute-list li:last-child button').click();headerChecks.phase='physical';document.querySelector('[data-tool-button=replicate]').click();headerChecks.change('replicate-a','2');headerChecks.change('replicate-atoms',true,true);document.getElementById('apply-replicate').click();`);
    await wait('headerChecks.renderer.frame.ids.length===4&&document.getElementById("loading").hidden','Physical replication');
    await evaluate(`document.querySelector('[data-tool-button=timeSeries]').click();document.getElementById('collect-time-series').click();`);
    await wait(`document.getElementById('time-series-state').textContent==='Complete'`,'Replicated metadata collection');
    const physical=await evaluate(`(async()=>({reads:headerChecks.requests.filter(item=>item.phase==='physical'),csv:await headerChecks.table()}))()`);
    assert.ok(physical.reads.some(item=>item.type==='frame-header'));
    for(const[index,row]of physical.csv.trim().split('\r\n').slice(1).entries()){
      const cells=row.split(',');assert.equal(Number(cells[3]),2*a(index)*100);assert.equal(Number(cells[4]),4);assert.equal(Number(cells[5]),2/(a(index)*100));
    }
    await evaluate(`headerChecks.phase='smoothing';document.querySelector('[data-tool-button=trajectory]').click();headerChecks.change('trajectory-smooth-window','2');headerChecks.change('trajectory-smooth-enabled',true,true);`);
    await wait('headerChecks.renderer.frame.smoothing&&document.getElementById("loading").hidden','Smoothed source');
    await evaluate(`document.querySelector('[data-tool-button=timeSeries]').click();document.getElementById('collect-time-series').click();`);
    await wait(`document.getElementById('time-series-state').textContent==='Complete'`,'Smoothed full fallback');
    const smoothing=await evaluate(`(async()=>({reads:headerChecks.requests.filter(item=>item.phase==='smoothing'),csv:await headerChecks.table(),view:headerChecks.renderer.frame.frameIndex}))()`);
    assert.equal(smoothing.reads.some(item=>item.type==='frame-header'),false);
    assert.ok(smoothing.reads.some(item=>item.type==='frame'&&item.trajectory?.smoothing===2));assert.equal(smoothing.view,0);
    for(const[index,row]of smoothing.csv.trim().split('\r\n').slice(1).entries()){
      const first=Math.max(0,index-2),last=Math.min(count-1,index+2),expected=Array.from({length:last-first+1},(_,i)=>a(first+i)).reduce((sum,value)=>sum+value,0)/(last-first+1);
      assert.ok(Math.abs(Number(row.split(',')[3])-2*expected*100)<1e-10);
    }
    await evaluate('clearInterval(headerChecks.samples);document.getElementById("close-file").click()');
    await wait('!headerChecks.client.worker&&headerChecks.client.cpuBudget.active===0','Source close releases parser budget');
    return {isolated,headerRequests:headers.requests.length,headerResponses:headers.responses.length,mixedFullRequests:mixed.reads.length,physicalRequests:physical.reads.length,smoothedFullRequests:smoothing.reads.length,maximumCpu:headers.cpu,budget:headers.budget,frames:count};
  },{requireGpu:false,isolated}));
  console.log(JSON.stringify({result:'passed',tree:source?'source':'production',runs},null,2));
} finally {await rm(directory,{recursive:true,force:true});}
