import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';
import { crystalFrame, dumpText } from '../tests/helpers/crystals.js';

const root = resolve(import.meta.dirname, '..');
const source = process.argv.includes('--source');
if (!source) assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-source-loading-'));
const original = resolve(directory, 'original.dump'), invalid = resolve(directory, 'invalid.xyz');
const cancelled = resolve(directory, 'cancelled.xyz'), replacement = resolve(directory, 'replacement.xyz');
await writeFile(original, dumpText(Array.from({ length: 12 }, () => crystalFrame('fcc', 2, 4.05))));
await writeFile(invalid, '2\nRecognized XYZ with an incomplete row\nFe 0 0 0\n');
await writeFile(cancelled, '1\ncandidate\nC 1 2 3\n');
await writeFile(replacement, '1\nreplacement\nNi 4 5 6\n');
try {
  const result = await withWebGpuBrowser(async ({ call, evaluate }) => {
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 5 });
    ` });
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/${source ? '' : 'dist/'}index.html` });
    async function waitFor(expression, label, timeoutMs = 90_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
      throw new Error(`${label}: ${await evaluate('document.getElementById("toast")?.textContent')}`);
    }
    await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=coordination]")', 'Application startup');
    await evaluate(`(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const { StructureWorkerClient } = await import(new URL('./data/structure-worker-client.js', app));
      const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', app));
      const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
      const checks = window.sourceLoadChecks = { starts: [], clearedGpu: 0, clearedCpu: 0, displays: 0, holds: false };
      const prepare = StructureWorkerClient.prototype.prepareSource;
      StructureWorkerClient.prototype.prepareSource = function(...args) {
        checks.client = this;
        checks.starts.push(args[0].map(file => file.name));
        return prepare.apply(this, args);
      };
      const load = StructureWorkerClient.prototype.load;
      StructureWorkerClient.prototype.load = function(...args) {
        const result = load.apply(this, args);
        if (!checks.holds) return result;
        checks.holds = false;
        return result.then(value => new Promise(resolve => {
          checks.held = true; checks.release = () => resolve(value);
        }));
      };
      for (const [name, counter] of [['clearGpuFrames', 'clearedGpu'], ['clearVoronoiFrames', 'clearedCpu']]) {
        const method = AnalysisPool.prototype[name];
        AnalysisPool.prototype[name] = function(...args) { checks.pool = this; checks[counter]++; return method.apply(this, args); };
      }
      const analyze = AnalysisPool.prototype.analyze;
      AnalysisPool.prototype.analyze = function(frame, settings, ...rest) {
        const result = analyze.call(this, frame, settings, ...rest);
        if (!checks.holdEstimate || settings.kind !== 'ptm') return result;
        checks.holdEstimate = false;
        return result.then(value => new Promise(resolve => {
          checks.estimateHeld = true; checks.releaseEstimate = () => resolve(value);
        }));
      };
      const setFrame = WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame = function(...args) {
        if (this.canvas.id === 'viewport') { checks.renderer = this; checks.displays++; }
        return setFrame.apply(this, args);
      };
    })()`);
    const { root: dom } = await call('DOM.getDocument');
    const { nodeId } = await call('DOM.querySelector', { nodeId: dom.nodeId, selector: '#file-input' });
    async function open(file) {
      await call('DOM.setFileInputFiles', { nodeId, files: [file] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
    }
    await open(original);
    await waitFor('sourceLoadChecks.renderer?.frame.ids.length === 32 && document.getElementById("frame-count").textContent === "12" && document.getElementById("loading").hidden', 'Original trajectory loaded');
    await evaluate(`document.querySelector('[data-tool-button="coordination"]').click();
      document.getElementById('cutoff').value = '3'; document.getElementById('run-analysis').click();`);
    await waitFor('document.getElementById("analysis-state").textContent === "Calculated" && sourceLoadChecks.renderer.frame.properties.some(p=>p.name==="coordination")', 'Original completed analysis');
    await waitFor('sourceLoadChecks.pool.cpuWarmupStatus.readyModules.ptm >= 1 && sourceLoadChecks.pool.cpuWarmupStatus.readyModules.voronoi >= 1', 'Retained native modules');
    await evaluate(`(() => {
      const checks = sourceLoadChecks;
      checks.old = { client: checks.client, worker: checks.client.worker, generation: checks.client.sourceGeneration,
        frame: checks.renderer.frame, property: checks.renderer.frame.properties.find(p=>p.name==='coordination'),
        mode: document.getElementById('color-mode').value, file: document.getElementById('file-name').textContent,
        gpu: checks.pool.gpuBackend.worker, slots: [...checks.pool.slots].map(slot=>slot.worker),
        clearsGpu: checks.clearedGpu, clearsCpu: checks.clearedCpu, displays: checks.displays };
    })()`);
    await evaluate(`sourceLoadChecks.holdEstimate=true;
      const reference=document.querySelector('[data-lattice-a]');reference.value='';reference.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('lattice-estimate').click();`);
    await waitFor('sourceLoadChecks.estimateHeld && !document.getElementById("lattice-estimate-cancel").hidden', 'Previous source estimation in progress');
    await open(invalid);
    await waitFor('!sourceLoadChecks.client.stagedSource && document.getElementById("loading").hidden && /expected|incomplete|truncated|end|atom/i.test(document.getElementById("toast").textContent)', 'Candidate parsing failure surfaced');
    const failure = await evaluate(`(async () => {
      const checks = sourceLoadChecks, old = checks.old;
      const raw = await checks.client.frame(11, { reportProgress:false, background:true });
      return { sameClient:checks.client===old.client, sameWorker:checks.client.worker===old.worker,
        sameGeneration:checks.client.sourceGeneration===old.generation,
        sameFrame:checks.renderer.frame===old.frame, sameProperty:checks.renderer.frame.properties.find(p=>p.name==='coordination')===old.property,
        sameMode:document.getElementById('color-mode').value===old.mode, sameFile:document.getElementById('file-name').textContent===old.file,
        sameGpuWorker:checks.pool.gpuBackend.worker===old.gpu,
        keptNativeWorkers:old.slots.every(worker=>[...checks.pool.slots].some(slot=>slot.worker===worker)),
        noGpuInvalidation:checks.clearedGpu===old.clearsGpu, noCpuInvalidation:checks.clearedCpu===old.clearsCpu,
        noFrameUpload:checks.displays===old.displays, uncachedReadAtoms:raw.frame.ids.length,
        cpuBudget:checks.client.cpuBudget.limit, analysisState:document.getElementById('analysis-state').textContent,
        estimationStillActive:!document.getElementById('lattice-estimate-cancel').hidden };
    })()`);
    for (const [key, value] of Object.entries(failure)) if (typeof value === 'boolean') assert.equal(value, true, key);
    assert.equal(failure.uncachedReadAtoms, 32); assert.equal(failure.analysisState, 'Calculated'); assert.equal(failure.cpuBudget, 3);
    await evaluate('sourceLoadChecks.releaseEstimate()');
    await waitFor('document.getElementById("lattice-estimate-status").textContent.includes("Estimated from the current frame")', 'Previous estimation survives rejected selection');
    await evaluate('sourceLoadChecks.holds=true');
    await open(cancelled);
    await waitFor('sourceLoadChecks.held && sourceLoadChecks.client.stagedSource', 'Ready candidate held before commit');
    await open(replacement);
    await waitFor('sourceLoadChecks.renderer.frame.ids.length===1 && document.getElementById("file-name").textContent==="replacement.xyz" && document.getElementById("loading").hidden', 'Newer source replaces only after confirmation');
    await evaluate('sourceLoadChecks.release()');
    await delay(100);
    const committed = await evaluate(`({file:document.getElementById('file-name').textContent,
      label:sourceLoadChecks.renderer.frame.typeLabels[0], position:Array.from(sourceLoadChecks.renderer.frame.positions),
      sameClient:sourceLoadChecks.client===sourceLoadChecks.old.client,
      newWorker:sourceLoadChecks.client.worker!==sourceLoadChecks.old.worker,
      retainedNativeWorkers:sourceLoadChecks.old.slots.every(worker=>[...sourceLoadChecks.pool.slots].some(slot=>slot.worker===worker)),
      glError:sourceLoadChecks.renderer.gl.getError()})`);
    assert.equal(committed.file, 'replacement.xyz'); assert.equal(committed.label, 'Ni');
    assert.deepEqual(committed.position, [4,5,6]); assert.equal(committed.sameClient, true); assert.equal(committed.newWorker, true);
    assert.equal(committed.retainedNativeWorkers, true); assert.equal(committed.glError, 0);
    await evaluate('sourceLoadChecks.held=false; sourceLoadChecks.holds=true');
    await open(cancelled);
    await waitFor('sourceLoadChecks.held && sourceLoadChecks.client.stagedSource', 'Closing candidate held before commit');
    await evaluate('document.getElementById("close-file").click()');
    await waitFor('!sourceLoadChecks.client.worker && !sourceLoadChecks.client.stagedSource && !sourceLoadChecks.renderer.frame', 'Close disposes active and candidate source');
    await evaluate('sourceLoadChecks.release()');
    await delay(100);
    const closed = await evaluate(`({file:document.getElementById('file-name').textContent, frame:sourceLoadChecks.renderer.frame,
      worker:sourceLoadChecks.client.worker, candidate:sourceLoadChecks.client.stagedSource, cpuActive:sourceLoadChecks.client.cpuBudget.active})`);
    assert.equal(closed.file, 'No structure loaded'); assert.equal(closed.frame, null);
    assert.equal(closed.worker, null); assert.equal(closed.candidate, null); assert.equal(closed.cpuActive, 0);
    return { failure, committed, closed };
  }, { requireGpu: false, isolated: process.argv.includes('--isolated') });
  console.log(JSON.stringify({ result:'passed', tree:source?'source':'production', ...result }, null, 2));
} finally { await rm(directory, { recursive:true, force:true }); }
