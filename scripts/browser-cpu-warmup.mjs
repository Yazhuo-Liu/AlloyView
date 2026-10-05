import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fccScrewFrame } from '../tests/helpers/dislocations.js';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const directory = await mkdtemp(resolve(tmpdir(), 'alloyview-cpu-warmup-'));
const frame = fccScrewFrame({ screw: false, nx: 16, ny: 12, nz: 8 });
const atoms = frame.ids.length, repetitions = 20, expandedAtoms = atoms * repetitions;
const source = resolve(directory, 'cpu-warmup-fcc.xyz');
const lines = [String(atoms), `Lattice="${Array.from(frame.cell.vectors).join(' ')}" Properties=species:S:1:pos:R:3:id:I:1 pbc="F F T"`];
for (let atom = 0; atom < atoms; atom++) lines.push(`Ni ${Array.from(frame.positions.subarray(atom * 3, atom * 3 + 3)).join(' ')} ${atom + 1}`);
await writeFile(source, `${lines.join('\n')}\n`);

async function checkCores(cores) {
  return withWebGpuBrowser(async ({ evaluate, call }) => {
    await call('Page.enable');
    await call('Page.addScriptToEvaluateOnNewDocument', { source: `
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => ${cores} });
      window.cpuWorkerEvents = [];
      const NativeWorker = Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          const source = String(args[0]);
          super(...args);
          const row = { url: source, terminated: false, created: performance.now() };
          cpuWorkerEvents.push(row);
          const terminate = this.terminate.bind(this);
          this.terminate = () => { row.terminated = true; return terminate(); };
        }
      };
    ` });
    const origin = await evaluate('location.origin');
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(30);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({events:cpuWarmupChecks?.events,workers:cpuWorkerEvents,toast:document.getElementById("toast")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.querySelector("[data-tool-button=replicate]")', 'Application startup');
    await evaluate(`(async () => {
      const app = document.querySelector('script[type=module][src]').src;
      const { AnalysisPool } = await import(new URL('./analysis/analysis-pool.js', app));
      const { DxaClient } = await import(new URL('./analysis/dxa-client.js', app));
      const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', app));
      const checks = window.cpuWarmupChecks = { events: [], analyses: 0 };
      const instrument = (prototype, method, backend) => {
        const original = prototype[method];
        prototype[method] = function(options = {}) {
          checks[backend] = this;
          const row = { kind: 'warmup', backend, atoms: options.atomCount, started: performance.now() };
          checks.events.push(row);
          return original.call(this, options).then(status => {
            row.status = status; row.finished = performance.now(); return status;
          }, error => { row.error = error.name; row.finished = performance.now(); throw error; });
        };
      };
      instrument(AnalysisPool.prototype, 'warmupCpu', 'analysis');
      instrument(DxaClient.prototype, 'warmup', 'dxa');
      const setFrame = WebGLRenderer.prototype.setFrame;
      WebGLRenderer.prototype.setFrame = function(...args) {
        if (this.canvas.id === 'viewport') {
          checks.renderer = this;
          checks.events.push({ kind: 'display', atoms: args[0].ids.length, started: performance.now() });
        }
        return setFrame.apply(this, args);
      };
      for (const prototype of [AnalysisPool.prototype, DxaClient.prototype]) {
        const analyze = prototype.analyze;
        prototype.analyze = function(...args) { checks.analyses++; return analyze.apply(this, args); };
      }
      checks.change = (id, value, checkbox = false) => {
        const input = document.getElementById(id);
        if (checkbox) input.checked = value; else input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      checks.showTool = name => {
        if (document.querySelector('[data-tool-panel="' + name + '"]').hidden)
          document.querySelector('[data-tool-button="' + name + '"]').click();
      };
      checks.snapshot = () => ({ events: checks.events, analyses: checks.analyses,
        workers: cpuWorkerEvents.filter(row => /\\/(analysis|dxa)-worker\\.js(?:$|[?#])/.test(row.url)),
        status: checks.analysis?.cpuWarmupStatus, limit: checks.analysis?.limit,
        dxaCoordinator: checks.dxa?.worker !== null, atomCount: checks.renderer?.frame.ids.length,
        sharedBudget: checks.analysis?.cpuBudget === checks.dxa?.cpuBudget });
    })()`);
    async function load() {
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [source] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`cpuWarmupChecks.renderer?.frame.ids.length === ${atoms}`, 'Source import');
      await waitFor(`['analysis','dxa'].every(backend => cpuWarmupChecks.events.some(row => row.backend === backend && row.atoms === ${atoms} && row.status))`, 'Loaded-source CPU and DXA prewarm');
    }
    await load();
    const loaded = await evaluate('cpuWarmupChecks.snapshot()');
    assert.equal(loaded.limit, cores - 2);
    assert.equal(loaded.sharedBudget, true, 'Both analysis systems must share one application concurrency budget.');
    assert.equal(loaded.analyses, 0, 'Loading prewarms modules without running any analysis.');
    assert.equal(loaded.status.readyWorkers, 1);
    const initialDxa = loaded.events.find(row => row.backend === 'dxa' && row.atoms === atoms && row.status).status;
    assert.equal(initialDxa.workerCount, 1);

    await evaluate(`cpuWarmupChecks.showTool('replicate'); cpuWarmupChecks.change('replicate-c', '${repetitions}'); document.getElementById('apply-replicate').click();`);
    await waitFor(`cpuWarmupChecks.renderer.repetitions[2] === ${repetitions}`, 'Display replication');
    const displayed = await evaluate('cpuWarmupChecks.snapshot()');
    assert.equal(displayed.atomCount, atoms);
    assert.equal(displayed.events.filter(row => row.kind === 'warmup').length, loaded.events.filter(row => row.kind === 'warmup').length,
      'Display replication must not increase CPU prewarm targets.');
    assert.equal(displayed.workers.length, loaded.workers.length);

    await evaluate('cpuWarmupChecks.change("replicate-atoms",true,true)');
    await waitFor(`cpuWarmupChecks.renderer.frame.ids.length === ${expandedAtoms}`, 'Physical replication');
    await waitFor(`['analysis','dxa'].every(backend => cpuWarmupChecks.events.some(row => row.backend === backend && row.atoms === ${expandedAtoms} && row.status))`, 'Expanded-source prewarm');
    const expanded = await evaluate('cpuWarmupChecks.snapshot()');
    assert.equal(expanded.analyses, 0);
    assert.equal(expanded.status.readyWorkers, cores - 2);
    const expansionDisplay = expanded.events.find(row => row.kind === 'display' && row.atoms === expandedAtoms);
    const expansionWarmups = expanded.events.filter(row => row.kind === 'warmup' && row.atoms === expandedAtoms);
    assert.ok(expansionWarmups.length >= 2);
    assert.ok(expansionWarmups.every(row => row.started < expansionDisplay.started),
      'Physical replication starts prewarm before expanded geometry reaches the renderer.');
    const expandedDxa = expansionWarmups.find(row => row.backend === 'dxa' && row.status).status;
    assert.equal(expandedDxa.workerCount, cores - 2);
    assert.equal(expandedDxa.poolSize, cores - 3, 'DXA pool size counts child pthreads; its coordinator supplies the remaining thread.');
    assert.equal(expandedDxa.kernelGeneration, initialDxa.kernelGeneration);
    assert.ok(expandedDxa.wasmMemoryBytes >= initialDxa.wasmMemoryBytes);
    assert.equal(expanded.workers.filter(row => /dxa-worker\.js/.test(row.url)).length, 1,
      'Physical replication grows the existing DXA pool instead of creating another coordinator.');
    assert.ok(expanded.workers.every(row => !row.terminated));

    // Source reset must retain the larger warmed pools and the same Wasm heap.
    await load();
    const reloaded = await evaluate('cpuWarmupChecks.snapshot()');
    await waitFor(`cpuWarmupChecks.events.filter(row => row.backend === 'dxa' && row.atoms === ${atoms} && row.status).length >= 2`, 'Reloaded-source prewarm');
    const final = await evaluate('cpuWarmupChecks.snapshot()');
    const reloadedDxa = final.events.filter(row => row.backend === 'dxa' && row.atoms === atoms && row.status).at(-1).status;
    assert.equal(final.workers.length, expanded.workers.length);
    assert.ok(final.workers.every(row => !row.terminated));
    assert.equal(final.status.readyWorkers, expanded.status.readyWorkers);
    assert.equal(reloadedDxa.kernelGeneration, initialDxa.kernelGeneration);
    assert.equal(reloadedDxa.poolSize, expandedDxa.poolSize);
    assert.equal(final.analyses, 0);

    await evaluate(`(() => {
      if (document.getElementById('enable-gpu-computing').checked) document.getElementById('enable-gpu-computing').click();
      cpuWarmupChecks.showTool('coordination'); cpuWarmupChecks.change('cutoff','2.8');
      document.getElementById('run-analysis').click();
    })()`);
    await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'Foreground CPU analysis on the prewarmed pool');
    const analyzed = await evaluate(`({ snapshot: cpuWarmupChecks.snapshot(),
      hasCoordination: cpuWarmupChecks.renderer.frame.properties.some(property => property.name === 'coordination'),
      sourceCoordinateBytes: cpuWarmupChecks.renderer.frame.fractional.byteLength })`);
    assert.equal(analyzed.snapshot.analyses, 1);
    assert.equal(analyzed.snapshot.workers.length, final.workers.length);
    assert.ok(analyzed.snapshot.workers.every(row => !row.terminated));
    assert.equal(analyzed.hasCoordination, true);
    assert.ok(analyzed.sourceCoordinateBytes > 0, 'CPU preparation and analysis leave displayed coordinates attached.');
    await evaluate('Promise.all([cpuWarmupChecks.analysis.close(),cpuWarmupChecks.dxa.close()])');
    return { reportedLogicalProcessors: cores, applicationThreadLimit: loaded.limit,
      loadedAtoms: atoms, replicatedAtoms: expandedAtoms,
      loaded: { ordinaryReady: loaded.status.readyWorkers, dxa: initialDxa },
      expanded: { ordinaryReady: expanded.status.readyWorkers, dxa: expandedDxa },
      reloaded: { ordinaryReady: reloaded.status.readyWorkers, dxa: reloadedDxa },
      workerCoordinatorsCreated: final.workers.length, analysesRunDuringPrewarm: final.analyses,
      foregroundCoordinationReusedWorkers: true,
      replicationStartedWarmupBeforeRender: true, retainedAcrossSourceReset: true };
  }, { software: useSoftwareAdapter(true), isolated: true });
}

try {
  const eight = await checkCores(8);
  const sixteen = await checkCores(16);
  console.log(JSON.stringify({ scope: 'Production load/physical-replication CPU prewarm, logical-core scaling and persistent Worker/Wasm reuse', eight, sixteen }, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
