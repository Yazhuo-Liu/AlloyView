import { SCALAR_COLOR_SCHEMES, colorMapStops } from '../../render/palette.js';
import { downloadBlob } from '../../io/export-archive.js';

export const VOLUMETRIC_TOOL_DEFAULTS = Object.freeze({
  datasetId: null, level: null, visible: true, color: '#5b8def', opacity: 0.7,
  sliceEnabled: false, sliceAxis: 2, sliceIndex: 0, colorScheme: 'viridis',
  rangeAuto: true, rangeMin: null, rangeMax: null,
});
const numeric = value => Number.isFinite(value) ? String(value) : '—';
const concise = value => Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : '—';
const fieldUnit = source => source?.unit || (source?.kind === 'elf' ? 'dimensionless' : 'file units');
const HELP = 'Open a charge-density, potential or orbital grid to display isosurfaces and numerical sections.';

export function volumetricSliceProbe(slice, x, y) {
  if (!slice || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= slice.width || y >= slice.height) return null;
  return { x, y, value: slice.values[x + slice.width * y], position: [0,1,2].map(axis =>
    slice.origin[axis] + x * slice.steps[axis] + y * slice.steps[3 + axis]) };
}

/** A bounded image samples the native slice; probing and CSV use every original
 * value. Even a large grid never paints more than 512² pixels on the page. */
export function volumetricSlicePixels(slice, { colorScheme = 'viridis', minimum, maximum, maxSide = 512 } = {}) {
  const width = Math.min(maxSide,slice.width), height = Math.min(maxSide,slice.height), data = new Uint8ClampedArray(width*height*4);
  const stops = colorMapStops(colorScheme), palette = new Uint8ClampedArray(1024*3);
  const span=maximum-minimum,scale=Math.max(Math.abs(minimum),Math.abs(maximum))||1;
  for (let i=0,segment=0;i<1024;i++) {
    const t=i/1023;
    while (segment+1<stops.length-1 && t>stops[segment+1][0]) segment++;
    const a=stops[segment],b=stops[segment+1],f=(t-a[0])/(b[0]-a[0]);
    for(let c=0;c<3;c++) palette[i*3+c]=a[c+1]+f*(b[c+1]-a[c+1]);
  }
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const sx=Math.min(slice.width-1,Math.floor((x+.5)*slice.width/width));
    const sy=Math.min(slice.height-1,Math.floor((height-y-.5)*slice.height/height));
    const value=slice.values[sx+slice.width*sy], target=(x+width*y)*4;
    const fraction=maximum>minimum?(Number.isFinite(span)?(value-minimum)/span:(value/scale-minimum/scale)/(maximum/scale-minimum/scale)):.5;
    const band=Math.round(Math.max(0,Math.min(1,fraction))*1023);
    for(let c=0;c<3;c++) data[target+c]=Number.isFinite(value)?palette[band*3+c]:150;
    data[target+3]=255;
  }
  return {width,height,data};
}

export function initializeVolumetricTools({ renderer, tools, client, getFrame, getSourceVersion = () => 0,
  getGpuEnabled = () => false, getFileStem = () => 'structure', onEdit = () => {}, onDisplayChange = () => {},
  onResultsChange = () => {}, notify = () => {}, onDownload = downloadBlob }) {
  const $=id=>globalThis.document?.getElementById(id)??null;
  let settings={...VOLUMETRIC_TOOL_DEFAULTS}, enabled=false, controlsEnabled=false, mesh=null, slice=null, frame=null;
  let meshTask=null,sliceTask=null,exportTask=null,meshFailed=false,sliceFailed=false,probe=[0,0];
  const datasets=()=>getFrame()?.volumetric?.datasets??[];
  const dataset=()=>datasets().find(value=>value.id===settings.datasetId)??null;
  const setText=(id,text)=>{if($(id))$(id).textContent=text;};
  const sync=()=>tools?.setToolEnabled('volumetric',enabled||settings.sliceEnabled);
  function state(label,text) {
    setText('volume-state',label); if(text!==undefined)setText('volume-status',text);
    $('volume-state')?.classList?.toggle('ready',label==='Calculated'); updateControls();
  }
  function updateControls() {
    const available=controlsEnabled&&Boolean(dataset());
    for(const id of ['volume-dataset','volume-level','volume-level-range','volume-visible','volume-color','volume-opacity',
      'volume-slice-enabled','volume-slice-axis','volume-slice-index','volume-slice-range','volume-palette','volume-range-auto',
      'volume-range-min','volume-range-max']) if($(id))$(id).disabled=!available;
    if($('volume-dataset'))$('volume-dataset').disabled=!controlsEnabled||!datasets().length;
    if($('run-volume'))$('run-volume').disabled=!available||Boolean(meshTask);
    if($('cancel-volume'))$('cancel-volume').disabled=!enabled&&!settings.sliceEnabled&&!meshFailed&&!sliceFailed;
    if($('export-volume-slice'))$('export-volume-slice').disabled=!slice||Boolean(exportTask)||!client?.exportSliceCsv;
  }
  function draw() {
    renderer?.setVolumetricSurface(frame===getFrame()?mesh:null,{visible:settings.visible,color:settings.color,opacity:settings.opacity});
    onDisplayChange();
  }
  function releaseResult() {
    if(frame?.atomeyeResults?.volumetric?.mesh===mesh) delete frame.atomeyeResults.volumetric;
    mesh=null;slice=null;frame=null; draw();
    if($('volume-slice-results'))$('volume-slice-results').hidden=true;
    setText('volume-summary',''); setText('volume-backend','—'); onResultsChange();
  }
  function retainResults() {
    const current=getFrame(); if(!current)return;
    current.atomeyeResults??={}; current.atomeyeResults.volumetric={datasetId:settings.datasetId,mesh,slice};
    frame=current;onResultsChange();
  }
  function abortMesh() { meshTask?.abort();meshTask=null;if($('volume-progress'))$('volume-progress').hidden=true; }
  function abortSlice() { sliceTask?.abort();sliceTask=null;exportTask?.abort();exportTask=null; }
  function abortJobs(){abortMesh();abortSlice();updateControls();}
  function cancel({silent=false}={}) {
    abortJobs();enabled=false;settings.sliceEnabled=false;meshFailed=false;sliceFailed=false;
    if($('volume-slice-enabled'))$('volume-slice-enabled').checked=false;
    sync();releaseResult();state('Not calculated',HELP);if(!silent)onResultsChange({clearSettings:true});
  }
  function applySettings() {
    for(const [id,key] of [['volume-level','level'],['volume-level-range','level'],['volume-color','color'],['volume-opacity','opacity'],
      ['volume-slice-axis','sliceAxis'],['volume-slice-index','sliceIndex'],['volume-slice-range','sliceIndex'],['volume-palette','colorScheme'],
      ['volume-range-min','rangeMin'],['volume-range-max','rangeMax']]) if($(id))$(id).value=settings[key]===null?'':String(settings[key]);
    for(const [id,key] of [['volume-visible','visible'],['volume-slice-enabled','sliceEnabled'],['volume-range-auto','rangeAuto']])if($(id))$(id).checked=settings[key];
    setText('volume-opacity-value',`${Math.round(settings.opacity*100)}%`);
  }
  function updateInfo() {
    const source=dataset(),select=$('volume-dataset'),doc=globalThis.document;
    if(select&&doc?.createElement) {
      const choices=datasets().map(value=>{const option=doc.createElement('option');option.value=value.id;option.textContent=`${value.name}${value.unit?` (${value.unit})`:''}`;return option;});
      if(settings.datasetId!==null&&!source){const option=doc.createElement('option');option.value=settings.datasetId;option.textContent='Saved field (not present)';choices.push(option);}
      select.replaceChildren(...choices);select.value=settings.datasetId??'';
    }
    const notes=getFrame()?.volumetric?.warnings??[];
    setText('volume-source-notes',notes.join(' '));if($('volume-source-notes'))$('volume-source-notes').hidden=!notes.length;
    if(!source){setText('volume-info',HELP);updateControls();return;}
    const stats=source.statistics??{};
    setText('volume-info',`${source.name} · ${source.dimensions.join(' × ')} samples · ${fieldUnit(source)}\nRange ${concise(stats.min)} to ${concise(stats.max)}${Number.isFinite(stats.integral)?` · Integral ${concise(stats.integral)} ${stats.integralUnit??`${source.unit||'file units'} Å³`}`:''}${stats.min<0?' · Signed field: negative isovalues are available.':''}`);
    if(settings.level===null&&Number.isFinite(stats.min)&&Number.isFinite(stats.max)) settings.level=stats.min*.8+stats.max*.2;
    const slider=$('volume-level-range');if(slider){slider.min=numeric(stats.min);slider.max=numeric(stats.max);slider.step='any';}
    const extent=source.dimensions[settings.sliceAxis]-1;settings.sliceIndex=Math.min(settings.sliceIndex,extent);
    for(const id of ['volume-slice-index','volume-slice-range'])if($(id)){$(id).max=String(extent);$(id).step='any';}
    setText('volume-slice-fraction',`${extent>0?(100*settings.sliceIndex/extent).toFixed(1):'0'}% of sampled axis`);
    applySettings();updateControls();
  }
  function current(task,kind,source,capturedFrame,version,isCurrent) {
    return (kind==='mesh'?meshTask:sliceTask)===task&&!task.signal.aborted&&dataset()===source
      &&getFrame()===capturedFrame&&getSourceVersion()===version&&isCurrent();
  }
  function backend(result) {
    return result.engine || (result.backend==='gpu'?'WebGPU':`CPU${result.workerCount?` · ${result.workerCount} Worker${result.workerCount===1?'':'s'}`:''}`);
  }
  async function run({automatic=false,isCurrent=()=>true}={}) {
    const source=dataset();if(!source||!isCurrent())return false;
    const level=$('volume-level')?.valueAsNumber??settings.level;
    if(!Number.isFinite(level)){state('Invalid input','Enter a finite isovalue in the field’s units.');return false;}
    abortMesh();settings.level=level;enabled=true;meshFailed=false;sync();if(!automatic)onEdit();
    const task=meshTask=new AbortController(),capturedFrame=getFrame(),version=getSourceVersion();
    state('Calculating','Extracting isosurface…');
    if($('volume-progress')){$('volume-progress').hidden=false;$('volume-progress').value=0;}
    const live=()=>current(task,'mesh',source,capturedFrame,version,isCurrent);
    try {
      const result=await client.analyze(source,{kind:'isosurface',level},{signal:task.signal,useGpu:Boolean(getGpuEnabled()),onProgress(progress){
        if(!live())return;
        setText('volume-status',progress.message??`${progress.backend==='gpu'?'GPU':'CPU'} · ${progress.phase??'extracting isosurface'}…`);
        const total=progress.totalCells??progress.total,completed=progress.completedCells??progress.completed??0;
        if($('volume-progress')&&total>0)$('volume-progress').value=completed/total;
      }});
      if(!live())return false;
      mesh=result;frame=capturedFrame;draw();retainResults();
      setText('volume-backend',backend(result));if($('volume-backend'))$('volume-backend').title=result.fallbackReason??result.routeReason??'';
      setText('volume-summary',`${(result.triangleCount??result.triangles?.length/3??0).toLocaleString('en-US')} triangles · isovalue ${numeric(level)} ${source.unit||''}${Number.isFinite(result.statistics?.surfaceArea)?` · area ${concise(result.statistics.surfaceArea)} Å²`:''}`);
      state('Calculated',result.fallbackReason?`CPU fallback: ${result.fallbackReason}`:'Isosurface ready. Color and opacity changes reuse the current surface.');
      return true;
    } catch(error) {
      if(live()&&error.name!=='AbortError'){meshFailed=true;mesh=null;draw();retainResults();state('Failed',error.message);notify(error.message);}
      return false;
    } finally {if(meshTask===task){meshTask=null;if($('volume-progress'))$('volume-progress').hidden=true;updateControls();onResultsChange();}}
  }
  function sliceLimits() {
    return settings.rangeAuto ? [slice?.statistics?.min??0,slice?.statistics?.max??1] : [settings.rangeMin,settings.rangeMax];
  }
  function updateProbe() {
    const sample=volumetricSliceProbe(slice,...probe);if(!sample)return;
    setText('volume-slice-probe',`Sample (${sample.x}, ${sample.y}) · value ${numeric(sample.value)} ${slice.unit||''} · XYZ (${sample.position.map(numeric).join(', ')}) Å`);
  }
  function paintSlice() {
    if(!slice)return; const canvas=$('volume-slice-canvas'),context=canvas?.getContext?.('2d'),[minimum,maximum]=sliceLimits();
    if($('volume-range-min'))$('volume-range-min').value=numeric(minimum);if($('volume-range-max'))$('volume-range-max').value=numeric(maximum);
    if(context){
      const pixels=volumetricSlicePixels(slice,{colorScheme:settings.colorScheme,minimum,maximum});
      canvas.width=pixels.width;canvas.height=pixels.height;
      const image=context.createImageData(pixels.width,pixels.height);image.data.set(pixels.data);context.putImageData(image,0,0);
    }
    setText('volume-slice-limits',`${concise(minimum)} → ${concise(maximum)} ${slice.unit||''} · horizontal ${'abc'[slice.axes[0]]}, vertical ${'abc'[slice.axes[1]]} · ${slice.width} × ${slice.height} native samples`);
    probe=[Math.min(probe[0],slice.width-1),Math.min(probe[1],slice.height-1)];updateProbe();
  }
  async function runSlice({isCurrent=()=>true}={}) {
    abortSlice();const source=dataset();if(!settings.sliceEnabled||!source||!isCurrent())return false;
    const task=sliceTask=new AbortController(),capturedFrame=getFrame(),version=getSourceVersion();sliceFailed=false;
    setText('volume-slice-status','Extracting section…');updateControls();
    const live=()=>current(task,'slice',source,capturedFrame,version,isCurrent);
    try {
      const result=await client.analyze(source,{kind:'slice',axis:settings.sliceAxis,index:settings.sliceIndex},{signal:task.signal,useGpu:Boolean(getGpuEnabled())});
      if(!live())return false;slice=result;retainResults();
      if($('volume-slice-results'))$('volume-slice-results').hidden=false;
      setText('volume-slice-status',`${backend(result)} · A fractional index interpolates adjacent grid planes. The map uses the lattice-grid axes; XYZ readout retains the skew cell geometry.`);
      paintSlice();return true;
    }catch(error){if(live()&&error.name!=='AbortError'){sliceFailed=true;slice=null;if($('volume-slice-results'))$('volume-slice-results').hidden=true;retainResults();setText('volume-slice-status',error.message);notify(error.message);}return false;}
    finally{if(sliceTask===task){sliceTask=null;updateControls();onResultsChange();}}
  }
  async function onFrame({isCurrent=()=>true}={}) {
    abortJobs();releaseResult();
    if(settings.datasetId===null&&datasets().length)settings.datasetId=datasets()[0].id;
    updateInfo();sync();
    if(!dataset()){state('Not available',HELP);return false;}
    if(!enabled)state('Not calculated','Choose an isovalue, then construct its surface.');
    const results=await Promise.all([enabled?run({automatic:true,isCurrent}):false,settings.sliceEnabled?runSlice({isCurrent}):false]);
    return results.some(Boolean);
  }
  async function exportSlice() {
    if(!slice||exportTask||!client.exportSliceCsv)return;
    const task=exportTask=new AbortController(),result=slice,source=getFrame(),version=getSourceVersion();updateControls();
    try {
      const output=await client.exportSliceCsv(result,{stem:getFileStem()},{signal:task.signal});
      if(!task.signal.aborted&&exportTask===task&&slice===result&&source===getFrame()&&version===getSourceVersion())onDownload(output.blob,output.filename);
    }catch(error){if(error.name!=='AbortError')notify(error.message);}
    finally{if(exportTask===task){exportTask=null;updateControls();}}
  }
  $('run-volume')?.addEventListener('click',()=>void run());
  $('cancel-volume')?.addEventListener('click',()=>{onEdit();cancel();});
  $('volume-dataset')?.addEventListener('change',()=>{
    abortJobs();releaseResult();settings.datasetId=$('volume-dataset').value;settings.level=null;settings.rangeAuto=true;
    settings.sliceIndex=Math.floor((dataset()?.dimensions?.[settings.sliceAxis]??1)/2);updateInfo();onEdit();
    if(enabled)void run({automatic:true});if(settings.sliceEnabled)void runSlice();
  });
  for(const id of ['volume-level','volume-level-range'])$(id)?.addEventListener(id.endsWith('range')?'input':'change',()=>{
    const value=$(id).valueAsNumber;if(!Number.isFinite(value))return;settings.level=value;applySettings();onEdit();
  });
  for(const id of ['volume-visible','volume-color','volume-opacity'])$(id)?.addEventListener(id==='volume-visible'?'change':'input',()=>{
    settings.visible=$('volume-visible')?.checked??settings.visible;settings.color=$('volume-color')?.value??settings.color;
    settings.opacity=Number($('volume-opacity')?.value??settings.opacity);applySettings();draw();onEdit();
  });
  $('volume-slice-enabled')?.addEventListener('change',()=>{
    settings.sliceEnabled=$('volume-slice-enabled').checked;sync();onEdit();
    if(settings.sliceEnabled)void runSlice();else{abortSlice();slice=null;retainResults();if($('volume-slice-results'))$('volume-slice-results').hidden=true;updateControls();}
  });
  $('volume-slice-axis')?.addEventListener('change',()=>{
    settings.sliceAxis=Number($('volume-slice-axis').value);updateInfo();onEdit();if(settings.sliceEnabled)void runSlice();
  });
  for(const id of ['volume-slice-index','volume-slice-range'])$(id)?.addEventListener('change',()=>{
    const value=$(id).valueAsNumber,extent=(dataset()?.dimensions[settings.sliceAxis]??1)-1;
    if(!Number.isFinite(value)||value<0||value>extent){notify('Choose an index within the sampled grid.');return;}
    settings.sliceIndex=value;updateInfo();onEdit();if(settings.sliceEnabled)void runSlice();
  });
  $('volume-slice-range')?.addEventListener('input',()=>{if($('volume-slice-index'))$('volume-slice-index').value=$('volume-slice-range').value;});
  $('volume-palette')?.addEventListener('change',()=>{settings.colorScheme=$('volume-palette').value;paintSlice();onEdit();});
  $('volume-range-auto')?.addEventListener('change',()=>{
    settings.rangeAuto=$('volume-range-auto').checked;
    if(!settings.rangeAuto){const limits=slice?.statistics;settings.rangeMin=limits?.min??0;settings.rangeMax=limits?.max??1;if(settings.rangeMin===settings.rangeMax)settings.rangeMax=settings.rangeMin+Math.max(1,Math.abs(settings.rangeMin)*.01);}
    paintSlice();onEdit();
  });
  for(const id of ['volume-range-min','volume-range-max'])$(id)?.addEventListener('change',()=>{
    const minimum=$('volume-range-min')?.valueAsNumber,maximum=$('volume-range-max')?.valueAsNumber;
    if(!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum>=maximum){notify('Slice color limits must be finite and increasing.');return;}
    settings.rangeMin=minimum;settings.rangeMax=maximum;settings.rangeAuto=false;if($('volume-range-auto'))$('volume-range-auto').checked=false;paintSlice();onEdit();
  });
  const canvas=$('volume-slice-canvas');
  const inspect=event=>{if(!slice)return;const r=canvas.getBoundingClientRect();if(!r.width||!r.height)return;
    probe=[Math.max(0,Math.min(slice.width-1,Math.floor((event.clientX-r.left)/r.width*slice.width))),Math.max(0,Math.min(slice.height-1,Math.floor((r.bottom-event.clientY)/r.height*slice.height)))];updateProbe();};
  canvas?.addEventListener('pointermove',inspect);canvas?.addEventListener('pointerdown',inspect);
  canvas?.addEventListener('keydown',event=>{
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowDown:[0,-1],ArrowUp:[0,1]}[event.key];if(!slice||!delta)return;
    event.preventDefault();probe=[Math.max(0,Math.min(slice.width-1,probe[0]+delta[0])),Math.max(0,Math.min(slice.height-1,probe[1]+delta[1]))];updateProbe();
  });
  $('export-volume-slice')?.addEventListener('click',()=>void exportSlice());
  const palette=$('volume-palette');if(palette&&globalThis.document?.createElement)palette.replaceChildren(...SCALAR_COLOR_SCHEMES.map(({value,label})=>{const option=document.createElement('option');option.value=value;option.textContent=label;return option;}));
  applySettings();updateInfo();state('Not calculated',HELP);
  return Object.freeze({run,runSlice,onFrame,cancel,abortJobs,redraw:draw,
    setEnabled(value){controlsEnabled=Boolean(value);updateControls();},
    reset(){cancel({silent:true});settings={...VOLUMETRIC_TOOL_DEFAULTS};applySettings();updateInfo();onResultsChange({clearSettings:true});},
    serialize:()=>({enabled,...settings}),
    async restore(saved,{isCurrent=()=>true}={}){if(!isCurrent())return false;cancel({silent:true});settings={...VOLUMETRIC_TOOL_DEFAULTS,...saved};enabled=Boolean(saved?.enabled);delete settings.enabled;applySettings();return onFrame({isCurrent});},
    failed:()=>meshFailed||sliceFailed?['volumetric']:[],
    pendingKinds:()=>meshTask||sliceTask?['volumetric']:[],
    isEnabled:()=>enabled||settings.sliceEnabled,
    getResult:()=>({mesh,slice}),
    isUntouched:()=>!enabled&&Object.entries(VOLUMETRIC_TOOL_DEFAULTS).every(([key,value])=>settings[key]===value),
  });
}
