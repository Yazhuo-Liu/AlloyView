import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crystalFrame } from '../tests/helpers/crystals.js';
import { useSoftwareAdapter, withWebGpuBrowser } from './webgpu-browser.mjs';

// Production UI, local file parsers, and real CPU Workers. The software display
// adapter only draws the page; GPU computing is disabled before loading files.
const root = resolve(import.meta.dirname, '..');
assert.ok(existsSync(resolve(root, 'dist/index.html')), 'Run npm run build first.');
const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-coordination-presets-'));
const nickel = crystalFrame('fcc', 3, 3.52), aluminium = crystalFrame('fcc', 3, 4.05), iron = crystalFrame('bcc', 3, 2.86);
function xyz(frame, species, { scale = 1, step = 0 } = {}) {
  return [String(frame.ids.length),
    `Lattice="${Array.from(frame.cell.vectors, value => value * scale).join(' ')}" Properties=species:S:1:pos:R:3:id:I:1 pbc="T T T" Step=${step}`,
    ...Array.from(frame.ids, (id, atom) => `${typeof species === 'function' ? species(atom) : species} ${Array.from(frame.positions.subarray(atom * 3, atom * 3 + 3), value => value * scale).join(' ')} ${id}`),
    '',
  ].join('\n');
}
const files = {
  nickel: 'nickel.xyz', aluminium: 'aluminium.xyz', iron: 'iron.xyz', alloy: 'nickel-aluminium.xyz',
  trajectory: 'nickel-trajectory.xyz', unknown: 'numeric-type.dump', unused: 'ni-unused-types.xyz',
};
await Promise.all([
  writeFile(resolve(temporary, files.nickel), xyz(nickel, 'Ni')),
  writeFile(resolve(temporary, files.aluminium), xyz(aluminium, 'Al')),
  writeFile(resolve(temporary, files.iron), xyz(iron, 'Fe')),
  writeFile(resolve(temporary, files.alloy), xyz(nickel, atom => atom % 2 ? 'Al' : 'Ni')),
  writeFile(resolve(temporary, files.trajectory), xyz(nickel, 'Ni') + xyz(nickel, 'Ni', { scale: 1.01, step: 1 })),
  writeFile(resolve(temporary, files.unused), xyz(nickel, 'Ni')),
  writeFile(resolve(temporary, files.unknown), [
    'ITEM: TIMESTEP', '0', 'ITEM: NUMBER OF ATOMS', String(nickel.ids.length), 'ITEM: BOX BOUNDS pp pp pp',
    ...[0, 1, 2].map(axis => `0 ${nickel.cell.vectors[axis * 4]}`), 'ITEM: ATOMS id type x y z',
    ...Array.from(nickel.ids, (id, atom) => `${id} 1 ${Array.from(nickel.positions.subarray(atom * 3, atom * 3 + 3)).join(' ')}`), '',
  ].join('\n')),
]);

try {
  const report = await withWebGpuBrowser(async ({ call, evaluate, adapter }) => {
    const origin = await evaluate('location.origin');
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await call('Page.navigate', { url: `${origin}/AlloyView/dist/index.html` });
    async function waitFor(expression, label, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await delay(40);
      }
      throw new Error(`${label}: ${await evaluate('JSON.stringify({state:document.getElementById("analysis-state")?.textContent,toast:document.getElementById("toast")?.textContent,recipe:document.getElementById("configuration-status")?.textContent})')}`);
    }
    await waitFor('document.readyState === "complete" && document.getElementById("coordination-cutoff-preset")', 'Preset production page startup');
    await evaluate(`(${initializeChecks.toString()})()`);
    await evaluate(`if (document.getElementById('enable-gpu-computing').getAttribute('aria-pressed') === 'true') document.getElementById('enable-gpu-computing').click()`);
    assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'false');
    const defaults = [], results = [];
    async function openFile(key, preset, cutoff) {
      const before = await evaluate('presetChecks.analyses');
      const { root: document } = await call('DOM.getDocument');
      const { nodeId } = await call('DOM.querySelector', { nodeId: document.nodeId, selector: '#file-input' });
      await call('DOM.setFileInputFiles', { nodeId, files: [resolve(temporary, files[key])] });
      await evaluate('document.getElementById("file-input").dispatchEvent(new Event("change",{bubbles:true}))');
      await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(files[key])}
        && presetChecks.renderer?.frame && document.getElementById('loading').hidden
        && !document.getElementById('coordination-cutoff-preset').disabled`, `${key} import`);
      // Wait past the cutoff debounce to catch an accidental calculation during
      // suggestion or source reset. Backend prewarm is deliberately allowed.
      await delay(350);
      const actual = await evaluate('presetChecks.snapshot()');
      assert.equal(actual.preset, preset); assert.equal(actual.cutoff, cutoff);
      assert.equal(actual.state, 'Not calculated'); assert.equal(actual.analyses, before, `${key} import must only suggest a cutoff.`);
      assert.equal(actual.hasCoordination, false);
      defaults.push({ source: key, ...actual });
      return actual;
    }
    async function change(id, value, event = 'change', checkbox = false) {
      await evaluate(`presetChecks.change(${JSON.stringify(id)},${JSON.stringify(value)},${JSON.stringify(event)},${checkbox})`);
    }
    async function calculated(cutoff, label, atoms = null, frameIndex = null) {
      await waitFor(`document.getElementById('analysis-state').textContent === 'Calculated'
        && presetChecks.property()?.analysisCutoff === ${cutoff}
        ${atoms === null ? '' : `&& presetChecks.renderer.frame.ids.length === ${atoms}`}
        ${frameIndex === null ? '' : `&& presetChecks.renderer.frame.frameIndex === ${frameIndex}`}`, label);
      const actual = await evaluate('presetChecks.parity()');
      assert.equal(actual.parity, true, `${label}: CPU Worker coordination must equal the independent linked-cell calculation.`);
      assert.equal(actual.gpuRequested, false); assert.doesNotMatch(actual.engine, /WebGPU/);
      results.push({ label, ...actual });
      return actual;
    }
    async function exportRecipe() {
      return evaluate(`(async () => {
        const createUrl = URL.createObjectURL, click = HTMLAnchorElement.prototype.click; let saved;
        URL.createObjectURL = function(blob) { saved = blob; return createUrl.call(this, blob); };
        HTMLAnchorElement.prototype.click = () => {};
        try {
          document.getElementById('export-configuration').click();
          if (!saved) throw new Error('Preset configuration export did not produce a Blob.');
          return JSON.parse(await saved.text());
        } finally { URL.createObjectURL = createUrl; HTMLAnchorElement.prototype.click = click; }
      })()`);
    }
    async function restoreRecipe(recipe, cutoff, preset, label) {
      await evaluate(`(() => {
        const transfer = new DataTransfer(); transfer.items.add(new File([${JSON.stringify(JSON.stringify(recipe))}], 'cutoff-recipe.json', { type: 'application/json' }));
        const input = document.getElementById('configuration-file'); input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor('document.getElementById("configuration-status").textContent.includes("restored")', label);
      await calculated(cutoff, label);
      assert.equal(await evaluate('presetChecks.snapshot().preset'), preset);
      assert.equal(await evaluate('document.getElementById("cutoff").valueAsNumber'), cutoff, 'Recipe numeric cutoff must retain full precision.');
    }

    const nickelDefault = await openFile('nickel', 'Ni', 2.85);
    assert.match(nickelDefault.help, /Ni/);
    const controls = await evaluate(`(() => {
      const numeric = document.getElementById('cutoff'), preset = document.getElementById('coordination-cutoff-preset');
      return { numericFirst: Boolean(numeric.compareDocumentPosition(preset) & Node.DOCUMENT_POSITION_FOLLOWING),
        first: preset.options[0].value, labels: Array.from(preset.options, option => option.textContent),
        choices: Array.from(preset.options, option => option.value) };
    })()`);
    assert.equal(controls.numericFirst, true); assert.equal(controls.first, 'custom');
    assert.ok(['Ni', 'Al', 'Fe'].every(symbol => controls.choices.includes(symbol)));
    assert.ok(controls.choices.length >= 30, 'Common metal presets must remain available for manual selection.');
    assert.ok(controls.labels.find(label => label.includes('Nickel'))?.includes('2.85'));
    await evaluate('presetChecks.showTool("coordination"); document.getElementById("run-analysis").click()');
    assert.deepEqual((await calculated(2.85, 'Nickel suggested cutoff')).histogram, { 12: nickel.ids.length });
    await change('coordination-cutoff-preset', 'Al');
    assert.deepEqual((await calculated(3.3, 'Select Al for a Ni source')).histogram, { 12: nickel.ids.length });
    const beforeCustom = await evaluate('presetChecks.snapshot()');
    await change('coordination-cutoff-preset', 'custom'); await delay(350);
    const custom = await evaluate('presetChecks.snapshot()');
    assert.equal(custom.cutoff, 3.3); assert.equal(custom.analyses, beforeCustom.analyses);
    await change('cutoff', '3.8', 'input');
    assert.deepEqual((await calculated(3.8, 'Manual cutoff includes the second FCC shell')).histogram, { 18: nickel.ids.length });
    assert.equal(await evaluate('presetChecks.snapshot().preset'), 'custom');

    await evaluate('presetChecks.lastValid = presetChecks.property(); presetChecks.beforeIncomplete = presetChecks.analyses; document.getElementById("cutoff").focus(); document.getElementById("cutoff").select()');
    await call('Input.insertText', { text: '2e' });
    await delay(350);
    const incomplete = await evaluate(`({ invalid: !Number.isFinite(document.getElementById('cutoff').valueAsNumber),
      focused: document.activeElement === document.getElementById('cutoff'),
      preset: document.getElementById('coordination-cutoff-preset').value,
      resultPreserved: presetChecks.property() === presetChecks.lastValid,
      analysesUnchanged: presetChecks.analyses === presetChecks.beforeIncomplete,
      state: document.getElementById('analysis-state').textContent })`);
    assert.equal(incomplete.invalid, true); assert.equal(incomplete.focused, true);
    assert.equal(incomplete.resultPreserved, true); assert.equal(incomplete.analysesUnchanged, true);
    assert.equal(incomplete.preset, 'custom'); assert.equal(incomplete.state, 'Calculated');
    await change('cutoff', '3.8', 'input'); await calculated(3.8, 'Complete a partial numeric edit');

    await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('presetChecks.showTool("coordination"); document.getElementById("coordination-cutoff-preset").scrollIntoView({block:"center"})');
    await delay(100);
    const mobile = await evaluate(`(() => {
      const bounds = ['cutoff','coordination-cutoff-preset'].map(id => {
        const field = document.getElementById(id), box = field.getBoundingClientRect();
        return { id, enabled: !field.disabled, width: box.width, fits: box.left >= 0 && box.right <= innerWidth };
      }); return { width: innerWidth, panelShown: !document.getElementById('tool-coordination').hidden, bounds };
    })()`);
    assert.equal(mobile.panelShown, true); assert.ok(mobile.bounds.every(field => field.enabled && field.fits && field.width > 0), JSON.stringify(mobile));
    await change('coordination-cutoff-preset', 'Fe'); await calculated(2.85, 'Phone preset selection');
    await change('cutoff', '3.6', 'input'); await calculated(3.6, 'Phone custom cutoff');
    assert.equal(await evaluate('presetChecks.snapshot().preset'), 'custom');
    const { data: phoneImage } = await call('Page.captureScreenshot', { format: 'png' });
    const phoneScreenshot = resolve(tmpdir(), 'alloyview-coordination-presets-mobile.png');
    await writeFile(phoneScreenshot, Buffer.from(phoneImage, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

    await change('coordination-cutoff-preset', 'Ni'); await calculated(2.85, 'Preset recipe preparation');
    const presetRecipe = await exportRecipe();
    assert.equal(presetRecipe.settings.analyses.coordination.preset, 'Ni');
    assert.equal(presetRecipe.settings.analyses.coordination.cutoff, 2.85);
    await restoreRecipe(presetRecipe, 2.85, 'Ni', 'Restore a selected element preset');
    const numericRecipe = structuredClone(presetRecipe);
    numericRecipe.settings.analyses.coordination.cutoff = 3.141592653589793;
    await restoreRecipe(numericRecipe, 3.141592653589793, 'custom', 'Obsolete preset value keeps the saved numeric cutoff');
    await change('cutoff', '3.7777', 'input'); await calculated(3.7777, 'Custom recipe preparation');
    const customRecipe = await exportRecipe();
    assert.equal(customRecipe.settings.analyses.coordination.preset, 'custom');
    assert.equal(customRecipe.settings.analyses.coordination.cutoff, 3.7777);
    const legacyRecipe = structuredClone(customRecipe);
    delete legacyRecipe.settings.analyses.coordination.preset;
    legacyRecipe.settings.analyses.coordination.cutoff = 3.123456789012345;
    await restoreRecipe(legacyRecipe, 3.123456789012345, 'custom', 'Legacy recipe keeps its numeric cutoff');

    await openFile('trajectory', 'Ni', 2.85);
    await change('cutoff', '3.8', 'input'); await calculated(3.8, 'Trajectory custom cutoff', nickel.ids.length, 0);
    await change('frame-slider', '1', 'input'); await calculated(3.8, 'Custom choice survives frame changes', nickel.ids.length, 1);
    assert.equal(await evaluate('presetChecks.snapshot().preset'), 'custom');
    const beforeReplication = await evaluate('presetChecks.analyses');
    await evaluate('presetChecks.showTool("replicate"); presetChecks.change("replicate-a","2"); document.getElementById("apply-replicate").click()');
    await waitFor('presetChecks.renderer.repetitions[0] === 2', 'Display replication');
    assert.equal(await evaluate('presetChecks.analyses'), beforeReplication);
    assert.equal(await evaluate('presetChecks.snapshot().preset'), 'custom');
    await change('replicate-atoms', true, 'change', true);
    await evaluate('document.getElementById("apply-replicate").click()');
    await calculated(3.8, 'Custom choice survives physical replication', nickel.ids.length * 2, 1);
    assert.equal(await evaluate('presetChecks.snapshot().preset'), 'custom');
    await change('coordination-cutoff-preset', 'Al'); await calculated(3.3, 'Element choice on a replicated source');
    await change('frame-slider', '0', 'input'); await calculated(3.3, 'Element preset survives frame changes', nickel.ids.length * 2, 0);
    assert.equal(await evaluate('presetChecks.snapshot().preset'), 'Al');
    await evaluate('document.getElementById("cancel-analysis").click()');
    const cancellation = await evaluate('presetChecks.snapshot()');
    assert.equal(cancellation.state, 'Not calculated'); assert.equal(cancellation.hasCoordination, false);
    assert.equal(cancellation.cutoff, 3.3); assert.equal(cancellation.preset, 'Al');
    await change('coordination-cutoff-preset', 'custom'); await delay(350);
    assert.equal(await evaluate('presetChecks.analyses'), cancellation.analyses);

    const alDefault = await openFile('aluminium', 'Al', 3.3); assert.match(alDefault.help, /Al/);
    await openFile('iron', 'Fe', 2.85);
    await evaluate('presetChecks.showTool("coordination"); document.getElementById("run-analysis").click()');
    assert.deepEqual((await calculated(2.85, 'Fe first-shell preset')).histogram, { 8: iron.ids.length });
    await change('coordination-cutoff-preset', 'Al');
    assert.deepEqual((await calculated(3.3, 'Choose an absent element preset explicitly')).histogram, { 14: iron.ids.length });
    const alloy = await openFile('alloy', 'Al', 3.3);
    assert.match(alloy.help, /Ni/); assert.match(alloy.help, /Al/); assert.match(alloy.help, /largest/i);
    const unknown = await openFile('unknown', 'custom', 3);
    assert.deepEqual(unknown.typeLabels, ['Type 1']); assert.match(unknown.help, /fallback/i);
    const unused = await openFile('unused', 'Ni', 2.85);
    assert.deepEqual(unused.typeLabels, ['Ni', 'Pb', 'Type 99']);
    assert.match(unused.help, /Ni/); assert.doesNotMatch(unused.help, /Pb|Type 99/);
    return { adapter, gpuComputing: false, defaults, results, controls, custom, incomplete,
      mobile, cancellation, phoneScreenshot, recipeChecks: ['selected preset','saved numeric value','custom','legacy without preset'] };
  }, { software: useSoftwareAdapter(true), isolated: false });
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }

async function initializeChecks() {
  const app = document.querySelector('script[type=module][src]').src;
  const [{ WebGLRenderer }, { AnalysisPool }, { StructureWorkerClient }, { calculateCoordination }] = await Promise.all([
    import(new URL('./render/webgl-renderer.js', app)), import(new URL('./analysis/analysis-pool.js', app)),
    import(new URL('./worker-client.js', app)), import(new URL('./analysis/coordination.js', app)),
  ]);
  const checks = window.presetChecks = { analyses: 0, jobs: [] };
  const setFrame = WebGLRenderer.prototype.setFrame;
  WebGLRenderer.prototype.setFrame = function(...args) {
    if (this.canvas.id === 'viewport') checks.renderer = this;
    return setFrame.apply(this, args);
  };
  const analyze = AnalysisPool.prototype.analyze;
  AnalysisPool.prototype.analyze = function(frame, parameters, ...args) {
    checks.analyses++; checks.jobs.push({ kind: parameters.kind, cutoff: parameters.cutoff });
    return analyze.call(this, frame, parameters, ...args);
  };
  const load = StructureWorkerClient.prototype.load;
  StructureWorkerClient.prototype.load = async function(input) {
    const result = await load.call(this, input);
    // Current text parsers omit unused labels. Simulate an imported type table
    // at the real Worker boundary; every actual atom remains Ni (type index 0).
    if ((Array.isArray(input) ? input : [input]).some(entry => (entry.file ?? entry).name === 'ni-unused-types.xyz')) {
      result.frame.typeLabels = [...result.frame.typeLabels, 'Pb', 'Type 99'];
    }
    return result;
  };
  checks.change = (id, value, event = 'change', checkbox = false) => {
    const input = document.getElementById(id);
    if (checkbox) input.checked = value; else input.value = String(value);
    input.dispatchEvent(new Event(event, { bubbles: true }));
  };
  checks.showTool = name => {
    if (document.querySelector(`[data-tool-panel="${name}"]`).hidden) document.querySelector(`[data-tool-button="${name}"]`).click();
  };
  checks.property = () => checks.renderer?.frame.properties.find(property => property.name === 'coordination');
  checks.snapshot = () => ({ preset: document.getElementById('coordination-cutoff-preset').value,
    cutoff: document.getElementById('cutoff').valueAsNumber, help: document.getElementById('cutoff-help').textContent,
    analyses: checks.analyses, state: document.getElementById('analysis-state').textContent,
    hasCoordination: Boolean(checks.property()), typeLabels: checks.renderer.frame.typeLabels });
  checks.parity = () => {
    const p = checks.property(), expected = calculateCoordination(checks.renderer.frame, p.analysisCutoff).coordination;
    return { atoms: expected.length, cutoff: p.analysisCutoff, preset: document.getElementById('coordination-cutoff-preset').value,
      engine: p.analysisEngine ?? '', gpuRequested: Boolean(p.analysisGpuRequested),
      parity: p.data.every((value, atom) => value === expected[atom]),
      histogram: Array.from(p.data).reduce((histogram, value) => { histogram[value] = (histogram[value] ?? 0) + 1; return histogram; }, {}) };
  };
}
