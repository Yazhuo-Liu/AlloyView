import { DIFFRACTION_DEFAULTS, normalizeDiffractionParameters } from '../../analysis/diffraction.js';
import { downloadBlob } from '../../io/export-archive.js';

export const DIFFRACTION_WAVELENGTHS = Object.freeze({ 'cu-ka1': 1.5406, 'co-ka1': 1.78897, 'mo-ka1': 0.7093 });
export const DIFFRACTION_UI_DEFAULTS = Object.freeze({ ...DIFFRACTION_DEFAULTS, wavelengthPreset: 'cu-ka1' });
const PAGE_SIZE = 40, SVG = 'http://www.w3.org/2000/svg';
const PLOT = Object.freeze({ left: 58, right: 624, top: 18, bottom: 230 });
const concise = value => Number.isFinite(value) ? Number(value.toPrecision(7)).toString() : '—';
const exact = value => Number.isFinite(value) ? String(value) : '—';
const HELP = 'Calculate a powder X-ray pattern from the complete periodic structure, including hidden atoms.';
const numericFields = [['diffraction-wavelength','wavelength'],['diffraction-min-angle','minAngle'],
  ['diffraction-max-angle','maxAngle'],['diffraction-fwhm','fwhm'],['diffraction-step','step']];
const booleanFields = [['diffraction-thermal','useThermal'],['diffraction-lp','lorentzPolarization']];
const peakLabel = peak => (peak.hkls ?? []).map(hkl => `(${hkl.join(' ')})`).join(', ');
const sourcePropertyNames = new Set(['occupancy','Uiso','uiso','U_iso_or_equiv','Biso','biso','bfactor','B_iso_or_equiv',
  ...['xx','yy','zz','xy','xz','yz'].map(axis => `displacementU${axis}`)]);
// Match the diffraction client's scientific inputs without scanning atom arrays.
// In-place atom edits publish revision markers; cell and label metadata is small
// enough to compare by value, including edits to an existing array.
function sourceKey(frame) {
  return [frame?.fractional,frame?.types,frame?.geometryRevision??0,frame?.revision??0,
    frame?.propertyRevision??0,frame?.typesRevision??0,
    ...(frame?.cell?.vectors??[]),...(frame?.cell?.pbc??[]),...(frame?.typeLabels??[]),
    ...(frame?.properties??[]).filter(property=>sourcePropertyNames.has(property.name))
      .flatMap(property=>[property.name,property.data,property.revision??0])];
}
const sameSourceKey = (left,right) => left?.length===right.length && right.every((value,index)=>Object.is(value,left[index]));

/** The drawing is bounded; native profile samples remain intact for CSV. */
export function diffractionChartPaths(result, maximumPoints = 1800) {
  const parameters = result.parameters, span = parameters.maxAngle - parameters.minAngle;
  const x = value => PLOT.left + (value - parameters.minAngle) / span * (PLOT.right - PLOT.left);
  const y = value => PLOT.bottom - Math.max(0, Math.min(100, value)) / 100 * (PLOT.bottom - PLOT.top);
  const values = result.profile?.relativeIntensity ?? [], angles = result.profile?.twoTheta ?? [];
  let curve = '', sticks = '';
  // Keep both extrema of each contiguous bin: narrow diffraction maxima must
  // not disappear when a large scientific profile is reduced for the screen.
  const stride = Math.max(1, Math.ceil(values.length / Math.max(2, Math.floor(maximumPoints / 2))));
  let first = true;
  for (let start = 0; start < values.length; start += stride) {
    const end = Math.min(values.length, start + stride); let low = start, high = start;
    for (let index = start + 1; index < end; index++) { if (values[index] < values[low]) low = index; if (values[index] > values[high]) high = index; }
    for (const index of low === high ? [low] : low < high ? [low,high] : [high,low]) {
      if (!Number.isFinite(angles[index]) || !Number.isFinite(values[index])) continue;
      curve += `${first?'M':'L'}${x(angles[index]).toFixed(3)},${y(values[index]).toFixed(3)}`; first = false;
    }
  }
  // Dense supercells may have many closely spaced peaks. Keep the strongest
  // native stick in each screen bin; every exact peak remains in the table,
  // probe and CSV. Bound path size as well as the number of DOM nodes.
  let peaks = result.peaks ?? [];
  if (peaks.length > maximumPoints) {
    const bins = new Array(maximumPoints);
    for (const peak of peaks) {
      const bin = Math.max(0,Math.min(maximumPoints-1,Math.floor((peak.twoTheta-parameters.minAngle)/span*maximumPoints)));
      if (!bins[bin] || peak.relativeIntensity > bins[bin].relativeIntensity) bins[bin] = peak;
    }
    peaks = bins.filter(Boolean);
  }
  for (const peak of peaks) sticks += `M${x(peak.twoTheta).toFixed(3)},${PLOT.bottom}V${y(peak.relativeIntensity).toFixed(3)}`;
  return { curve, sticks, x, y };
}

export function nearestDiffractionPeak(peaks, angle) {
  if (!peaks?.length || !Number.isFinite(angle)) return -1;
  let low = 0, high = peaks.length;
  while (low < high) { const mid = (low + high) >>> 1; if (peaks[mid].twoTheta < angle) low = mid + 1; else high = mid; }
  if (low === 0) return 0; if (low === peaks.length) return low - 1;
  return angle - peaks[low - 1].twoTheta <= peaks[low].twoTheta - angle ? low - 1 : low;
}

export function initializeDiffractionControls({ client, getFrame, getSourceVersion = () => 0,
  getGpuEnabled = () => false, getFileStem = () => 'structure', onEdit = () => {}, onResultsChange = () => {},
  notify = () => {}, onDownload = downloadBlob }) {
  const doc = globalThis.document, $ = id => doc?.getElementById(id) ?? null;
  let settings = { ...DIFFRACTION_UI_DEFAULTS }, enabled = false, controlsEnabled = false;
  let result = null, source = null, version = null, identity = null, task = null, exportTask = null, failed = false;
  let serial = 0, page = 0, inspected = 0, chart = null, cursor = null;
  const fresh = () => result && source === getFrame() && version === getSourceVersion() && sameSourceKey(identity,sourceKey(getFrame()));
  const text = (id, value) => { if ($(id)) $(id).textContent = value; };
  function controls() {
    const available = controlsEnabled && Boolean(getFrame());
    for (const [id] of [...numericFields,...booleanFields]) if ($(id)) $(id).disabled = !available;
    if ($('diffraction-preset')) $('diffraction-preset').disabled = !available;
    if ($('run-diffraction')) $('run-diffraction').disabled = !available || Boolean(task);
    if ($('cancel-diffraction')) $('cancel-diffraction').disabled = !enabled && !task && !failed;
    for (const kind of ['peaks','profile']) if ($(`export-diffraction-${kind}`)) $(`export-diffraction-${kind}`).disabled = !fresh() || Boolean(exportTask);
    if ($('diffraction-peak-slider')) $('diffraction-peak-slider').disabled = !fresh() || !result.peaks.length;
  }
  function state(label, message) {
    text('diffraction-state', label); if (message !== undefined) text('diffraction-status', message);
    $('diffraction-state')?.classList?.toggle('ready', label === 'Calculated'); controls();
  }
  function applySettings() {
    for (const [id,key] of numericFields) if ($(id)) $(id).value = String(settings[key]);
    for (const [id,key] of booleanFields) if ($(id)) $(id).checked = settings[key];
    if ($('diffraction-preset')) $('diffraction-preset').value = settings.wavelengthPreset;
  }
  function readSettings() {
    const parameters = {};
    for (const [id,key] of numericFields) parameters[key] = $(id)?.valueAsNumber ?? settings[key];
    for (const [id,key] of booleanFields) parameters[key] = $(id)?.checked ?? settings[key];
    return { ...normalizeDiffractionParameters(parameters), wavelengthPreset: settings.wavelengthPreset };
  }
  function releaseResult() {
    if (source?.atomeyeResults?.diffraction === result) delete source.atomeyeResults.diffraction;
    result = null; source = null; identity = null; chart = cursor = null; page = inspected = 0;
    $('diffraction-chart')?.replaceChildren(); $('diffraction-table-body')?.replaceChildren();
    if ($('diffraction-results')) $('diffraction-results').hidden = true;
    text('diffraction-backend','—'); text('diffraction-summary',''); onResultsChange();
  }
  function abortJobs() {
    const wasRunning = Boolean(task);
    serial++; task?.abort(); task = null; exportTask?.abort(); exportTask = null;
    if ($('diffraction-progress')) $('diffraction-progress').hidden = true;
    if (wasRunning) { text('diffraction-state','Not calculated');text('diffraction-status','Calculation cancelled. Calculate again when ready.'); }
    controls();
  }
  function invalidate(message = 'Parameters changed. Calculate again to update the diffraction pattern.') {
    abortJobs(); releaseResult(); failed = false; state('Not calculated', message);
  }
  function cancel({ silent = false } = {}) {
    enabled = false; invalidate(HELP); if (!silent) onResultsChange({ clearSettings: true });
  }
  function svg(tag, attributes = {}, content) {
    const node = doc.createElementNS(SVG,tag);
    for (const [name,value] of Object.entries(attributes)) node.setAttribute(name,String(value));
    if (content !== undefined) node.textContent = content;
    return node;
  }
  function inspect(index) {
    if (!fresh() || !result.peaks.length) return;
    inspected = Math.max(0,Math.min(result.peaks.length-1,Number(index)||0)); const peak = result.peaks[inspected];
    const labels = peakLabel(peak);
    text('diffraction-probe',`Peak ${inspected+1}/${result.peaks.length} · 2θ ${exact(peak.twoTheta)}° · d ${exact(peak.dSpacing)} Å · I/Imax ${exact(peak.relativeIntensity)}% · multiplicity ${peak.multiplicity} · ${labels}`);
    if ($('diffraction-peak-slider')) $('diffraction-peak-slider').value = String(inspected);
    if (cursor) { const x = diffractionChartPaths({ ...result,profile:null,peaks:[] }).x(peak.twoTheta); cursor.setAttribute('x1',x);cursor.setAttribute('x2',x); }
  }
  function table() {
    const body = $('diffraction-table-body'); if (!body || !fresh() || !doc?.createElement) return;
    const pages = Math.max(1,Math.ceil(result.peaks.length/PAGE_SIZE)); page = Math.min(page,pages-1);
    const start = page*PAGE_SIZE, rows = result.peaks.slice(start,start+PAGE_SIZE).map((peak,index) => {
      const row = doc.createElement('tr');
      for (const value of [concise(peak.twoTheta),concise(peak.dSpacing),concise(peak.relativeIntensity),String(peak.multiplicity)]) {
        const cell = doc.createElement('td'); cell.textContent = value; row.append(cell);
      }
      const cell = doc.createElement('td'), button = doc.createElement('button');button.type='button';button.className='text-button';
      const labels=peakLabel(peak);button.textContent=labels.length>110?`${labels.slice(0,107)}…`:labels;button.title=labels;
      button.addEventListener('click',()=>inspect(start+index));cell.append(button);row.append(cell);return row;
    });
    body.replaceChildren(...rows);
    text('diffraction-table-caption',result.peaks.length?`Peaks ${start+1}–${start+rows.length} of ${result.peaks.length}. CSV includes every reflection group.`:'No nonzero Bragg peaks in this angle range.');
    if ($('diffraction-previous')) $('diffraction-previous').disabled = page===0;
    if ($('diffraction-next')) $('diffraction-next').disabled = page+1===pages;
  }
  function draw() {
    if (!fresh()) return;
    if ($('diffraction-results')) $('diffraction-results').hidden = false;
    const container = $('diffraction-chart');
    if (container && doc?.createElementNS) {
      chart = svg('svg',{viewBox:'0 0 640 280',role:'img','aria-label':'Powder X-ray diffraction pattern, relative intensity versus two theta'});
      const paths = diffractionChartPaths(result);
      chart.append(svg('path',{d:`M${PLOT.left},${PLOT.top}V${PLOT.bottom}H${PLOT.right}`,fill:'none',stroke:'currentColor','stroke-width':1}));
      for (let index=0;index<=4;index++) {
        const intensity=index*25, y=paths.y(intensity);
        chart.append(svg('line',{x1:PLOT.left,y1:y,x2:PLOT.right,y2:y,stroke:'currentColor','stroke-opacity':.12}));
        chart.append(svg('text',{x:PLOT.left-8,y:y+4,'text-anchor':'end','font-size':11,fill:'currentColor'},intensity));
      }
      for (let index=0;index<=4;index++) {
        const angle=result.parameters.minAngle+(result.parameters.maxAngle-result.parameters.minAngle)*index/4;
        chart.append(svg('text',{x:paths.x(angle),y:249,'text-anchor':'middle','font-size':11,fill:'currentColor'},concise(angle)));
      }
      chart.append(svg('text',{x:340,y:273,'text-anchor':'middle','font-size':12,fill:'currentColor'},'2θ (degrees)'));
      chart.append(svg('text',{x:14,y:125,transform:'rotate(-90 14 125)','text-anchor':'middle','font-size':12,fill:'currentColor'},'Relative intensity (%)'));
      chart.append(svg('path',{d:paths.sticks,fill:'none',stroke:'#d98932','stroke-width':1,'stroke-opacity':.75}));
      chart.append(svg('path',{d:paths.curve,fill:'none',stroke:'#008996','stroke-width':1.8}));
      cursor=svg('line',{x1:0,y1:PLOT.top,x2:0,y2:PLOT.bottom,stroke:'currentColor','stroke-dasharray':'4 3','stroke-opacity':.55});chart.append(cursor);
      const probe=event=>{if(!fresh())return;const rect=chart.getBoundingClientRect();if(!rect.width)return;
        const x=(event.clientX-rect.left)/rect.width*640;
        if(x<PLOT.left||x>PLOT.right)return;
        const angle=result.parameters.minAngle+(x-PLOT.left)/(PLOT.right-PLOT.left)*(result.parameters.maxAngle-result.parameters.minAngle);
        inspect(nearestDiffractionPeak(result.peaks,angle));};
      chart.addEventListener('pointermove',probe);chart.addEventListener('pointerdown',probe);container.replaceChildren(chart);
      if (!result.peaks.length) cursor.setAttribute('visibility','hidden');
    }
    if ($('diffraction-peak-slider')) {$('diffraction-peak-slider').max=String(Math.max(0,result.peaks.length-1));$('diffraction-peak-slider').value=String(inspected);}
    text('diffraction-summary',`${result.peaks.length.toLocaleString('en-US')} peaks · ${result.reflectionCount?.toLocaleString('en-US')??'—'} reciprocal reflections · λ ${result.parameters.wavelength} Å · ${Math.round(result.elapsedMs??0)} ms`);
    text('diffraction-warnings',(result.warnings??[]).join(' '));if($('diffraction-warnings'))$('diffraction-warnings').hidden=!result.warnings?.length;
    if (!result.peaks.length) text('diffraction-probe','No nonzero Bragg peaks in this angle range.');
    table();inspect(inspected);
  }
  async function run({ automatic = false, isCurrent = () => true } = {}) {
    const frame=getFrame();if(!frame||!isCurrent())return false;
    let next;try {next=readSettings();}catch(error){invalidate();state('Invalid input',error.message);return false;}
    abortJobs();releaseResult();settings=next;enabled=true;failed=false;if(!automatic)onEdit();
    const request=serial, controller=task=new AbortController(), sourceVersion=getSourceVersion(), sourceIdentity=sourceKey(frame);
    const live=()=>task===controller&&!controller.signal.aborted&&serial===request&&getFrame()===frame&&getSourceVersion()===sourceVersion&&sameSourceKey(sourceIdentity,sourceKey(frame))&&isCurrent();
    state('Calculating','Preparing reciprocal reflections…');if($('diffraction-progress')){$('diffraction-progress').hidden=false;$('diffraction-progress').value=0;}
    const {wavelengthPreset,...parameters}=settings;
    try {
      const output=await client.analyze(frame,parameters,{signal:controller.signal,useGpu:Boolean(getGpuEnabled()),onProgress(progress){
        if(!live())return;const total=progress.totalReflections??progress.total,completed=progress.completedReflections??progress.completed??0;
        if($('diffraction-progress')&&total>0)$('diffraction-progress').value=completed/total;
        text('diffraction-status',progress.phase==='cpu-precision-correction'?'CPU · checking reflection precision…':
          progress.message??`${progress.backend==='gpu'?'GPU':'CPU'} · ${progress.phase??'calculating'}…`);
      }});
      if(!live())return false;
      result=output;source=frame;version=sourceVersion;identity=sourceIdentity;
      frame.atomeyeResults??={};frame.atomeyeResults.diffraction=output;
      draw();text('diffraction-backend',output.backend==='gpu'?'WebGPU structure factors':`CPU · ${output.workerCount??1} Worker${output.workerCount===1?'':'s'}`);
      if($('diffraction-backend'))$('diffraction-backend').title=output.backend==='gpu'&&output.correctedReflections>0?
        `${output.correctedReflections.toLocaleString('en-US')} reflection${output.correctedReflections===1?'':'s'} checked on CPU`:
        output.fallbackReason??'';
      state('Calculated',output.fallbackReason?`CPU fallback: ${output.fallbackReason}`:'Pattern ready. Peak sticks and the broadened profile are normalized independently to 100.');
      onResultsChange();return true;
    } catch(error) {if(live()&&error.name!=='AbortError'){failed=true;state('Failed',error.message);notify(error.message);}return false;}
    finally {if(task===controller){
      if(!live())state('Not calculated','Structure changed. Calculate again to update the diffraction pattern.');
      task=null;if($('diffraction-progress'))$('diffraction-progress').hidden=true;controls();onResultsChange();}}
  }
  async function exportCsv(kind) {
    if(!fresh()||exportTask)return false;
    const captured=result,controller=exportTask=new AbortController(),request=serial;controls();
    try {
      const output=await client.export(captured,kind,{stem:getFileStem()},{signal:controller.signal});
      if(controller.signal.aborted||exportTask!==controller||request!==serial||result!==captured||!fresh())return false;
      onDownload(output.blob,output.filename);return true;
    }catch(error){if(error.name!=='AbortError')notify(error.message);return false;}
    finally{if(exportTask===controller){exportTask=null;controls();}}
  }
  async function onFrame({isCurrent=()=>true}={}) {
    invalidate(HELP);if(!isCurrent())return false;
    return enabled&&getFrame()?run({automatic:true,isCurrent}):false;
  }
  $('run-diffraction')?.addEventListener('click',()=>void run());
  $('cancel-diffraction')?.addEventListener('click',()=>{onEdit();cancel();});
  for(const [id,key] of numericFields)$(id)?.addEventListener('change',()=>{
    if(key==='wavelength'){settings.wavelengthPreset='custom';if($('diffraction-preset'))$('diffraction-preset').value='custom';}
    try{settings=readSettings();}catch(error){invalidate();state('Invalid input',error.message);onEdit();return;}
    invalidate();onEdit();
  });
  for(const [id,key] of booleanFields)$(id)?.addEventListener('change',()=>{settings[key]=$(id).checked;invalidate();onEdit();});
  $('diffraction-preset')?.addEventListener('change',()=>{
    const preset=$('diffraction-preset').value;if(preset!=='custom'&&!Object.hasOwn(DIFFRACTION_WAVELENGTHS,preset))return;
    settings.wavelengthPreset=preset;if(preset!=='custom')settings.wavelength=DIFFRACTION_WAVELENGTHS[preset];applySettings();invalidate();onEdit();
  });
  $('diffraction-peak-slider')?.addEventListener('input',()=>inspect(Number($('diffraction-peak-slider').value)));
  $('diffraction-previous')?.addEventListener('click',()=>{if(page>0){page--;table();}});
  $('diffraction-next')?.addEventListener('click',()=>{if(result&&(page+1)*PAGE_SIZE<result.peaks.length){page++;table();}});
  for(const kind of ['peaks','profile'])$(`export-diffraction-${kind}`)?.addEventListener('click',()=>void exportCsv(kind));
  $('diffraction-controls')?.addEventListener('toggle',()=>{if($('diffraction-controls').open&&controlsEnabled)void client.warm?.({useGpu:Boolean(getGpuEnabled())}).catch(()=>{});});
  applySettings();state('Not calculated',HELP);
  return Object.freeze({run,cancel,onFrame,abortJobs,exportCsv,getResult:()=>fresh()?result:null,
    setEnabled(value){controlsEnabled=Boolean(value);controls();},
    reset(){cancel({silent:true});settings={...DIFFRACTION_UI_DEFAULTS};applySettings();onResultsChange({clearSettings:true});},
    serialize:()=>({enabled,...settings}),
    async restore(saved,{isCurrent=()=>true}={}){if(!isCurrent())return false;cancel({silent:true});settings={...DIFFRACTION_UI_DEFAULTS,...saved};enabled=Boolean(saved?.enabled);delete settings.enabled;applySettings();return onFrame({isCurrent});},
    isUntouched:()=>!enabled&&Object.entries(DIFFRACTION_UI_DEFAULTS).every(([key,value])=>settings[key]===value),
    isEnabled:()=>enabled,failed:()=>failed?['diffraction']:[],pendingKinds:()=>task?['diffraction']:[]});
}
