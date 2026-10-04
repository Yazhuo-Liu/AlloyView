import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { crystalFrame } from '../tests/helpers/crystals.js';

/** Real pointer gestures, persistent groups and physical/display replication. */
export async function runSelectionGroupsSmoke({ call, evaluate, waitFor, showTool,
  exportConfiguration, reloadPage, compareSettings, profile, screenshots = false }) {
  await reloadPage();
  await waitFor('document.readyState === "complete" && document.getElementById("replicate-atoms").disabled', 'fresh selection page');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(async () => {
    const appUrl = document.querySelector('script[type="module"]').src;
    const { WebGLRenderer } = await import(new URL('./render/webgl-renderer.js', appUrl));
    const original = WebGLRenderer.prototype.setFrame;
    WebGLRenderer.prototype.setFrame = function(...args) {
      if (this.canvas.id === 'viewport') window.selectionGroupsRenderer = this;
      return original.apply(this, args);
    };
  })()`);
  const fixture = crystalFrame('fcc', 1, 3.6);
  const dump = (step, rows = [0, 1, 2, 3], pbc = 'pp pp pp') => [
    'ITEM: TIMESTEP', step, 'ITEM: NUMBER OF ATOMS', 4, `ITEM: BOX BOUNDS ${pbc}`,
    '0 3.6', '0 3.6', '0 3.6', 'ITEM: ATOMS id type element xs ys zs',
    ...rows.map(atom => `${step && atom === 0 ? 5 : atom + 1} 1 Ni ${Array.from(fixture.fractional.slice(atom * 3, atom * 3 + 3), value => value + (step ? .03 : 0)).join(' ')}`),
  ].join('\n') + '\n';
  const trajectoryPath = resolve(profile, 'selection-groups.dump');
  await writeFile(trajectoryPath, dump(0) + dump(100, [3, 2, 1, 0]));
  async function inputNode(selector) {
    const { root } = await call('DOM.getDocument');
    return (await call('DOM.querySelector', { nodeId: root.nodeId, selector })).nodeId;
  }
  async function load(path, name) {
    await call('DOM.setFileInputFiles', { nodeId: await inputNode('#file-input'), files: [path] });
    await waitFor(`document.getElementById('file-name').textContent === ${JSON.stringify(name)} && document.getElementById('loading').hidden`, `load ${name}`);
  }
  async function selectValue(id, value) {
    await evaluate(`(() => { const input = document.getElementById(${JSON.stringify(id)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('change')); })()`);
  }
  async function manualIds(ids) {
    await evaluate(`document.getElementById('selection-group-ids').value = ${JSON.stringify(ids)}; document.getElementById('apply-selection-group-ids').click();`);
  }
  const groups = async () => (await exportConfiguration()).settings.selectionGroups;
  async function screenshot(name, anchor = null) {
    if (!screenshots) return;
    const scroll = await evaluate(`(() => {
      const sidebar=document.getElementById('sidebar'),panel=${anchor ? `document.getElementById(${JSON.stringify(anchor)})` : `document.querySelector('[data-tool-panel]:not([hidden])')`};
      const previous=sidebar.scrollTop;
      if(panel)sidebar.scrollTop+=panel.getBoundingClientRect().top-sidebar.getBoundingClientRect().top;
      return previous;
    })()`);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const capture = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(`/tmp/alloyview-${name}.png`, Buffer.from(capture.data, 'base64'));
    await evaluate(`document.getElementById('sidebar').scrollTop=${scroll}`);
  }
  async function mouse(point, type, button = 'left', buttons = type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1) {
    await call('Input.dispatchMouseEvent', { type, ...point, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
  async function viewport() {
    return evaluate(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height }; })()`);
  }
  async function box({ touch = false } = {}) {
    const rect = await viewport();
    const start = { x: rect.left + 3, y: rect.top + 3 }, end = { x: rect.right - 3, y: rect.bottom - 3 };
    if (touch) {
      const point = (position) => [{ id: 1, ...position, radiusX: 1, radiusY: 1, force: 1 }];
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(start) });
      await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point(end) });
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await mouse(start, 'mousePressed');
      await mouse(end, 'mouseMoved');
      await mouse(end, 'mouseReleased');
    }
    await waitFor('!document.querySelector(".selection-marquee")', 'completed selection box');
  }
  await load(trajectoryPath, 'selection-groups.dump');
  assert.equal(await evaluate('document.getElementById("replicate-atoms").checked'), false, 'physical replication defaults off');
  await showTool('coordination');
  await evaluate(`document.getElementById('cutoff').value = '3.1'; document.getElementById('run-analysis').click();`);
  await waitFor('document.getElementById("analysis-state").textContent === "Calculated"', 'initial thin-cell coordination');
  assert.deepEqual(await evaluate('Array.from(selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data)'), [3, 3, 3, 3]);
  await evaluate('window.groupOriginalCoordination = selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data');
  await showTool('selectionGroups');
  const picked = await evaluate(`(async () => {
    const r = selectionGroupsRenderer, appUrl = document.querySelector('script[type="module"]').src;
    const { transformPoint } = await import(new URL('./render/math.js', appUrl));
    r.updateMatrices(); const rect = r.canvas.getBoundingClientRect();
    for (let index=0; index<r.atomCount; index++) {
      const p=transformPoint(r.viewProjectionMatrix,...r.displayPositions.slice(index*3,index*3+3));
      const x=rect.left+(p[0]/p[3]*.5+.5)*rect.width,y=rect.top+(.5-p[1]/p[3]*.5)*rect.height;
      if(document.elementFromPoint(x,y)===r.canvas&&r.pick(x,y)===index)return {x,y,id:r.frame.ids[index]};
    }
    throw new Error('No directly pickable fixture atom.');
  })()`);
  await mouse(picked, 'mousePressed'); await mouse(picked, 'mouseReleased');
  await waitFor('document.querySelectorAll("[data-selection-group-id]").length === 1', 'click creates first group');
  assert.deepEqual((await groups()).groups[0].atomIds, [picked.id]);
  await evaluate(`(() => {
    const name=document.getElementById('selection-group-name'); name.value='Boundary'; name.dispatchEvent(new Event('input'));
    const color=document.getElementById('selection-group-color'); color.value='#ef7621'; color.dispatchEvent(new Event('input'));
    document.getElementById('selection-group-visible').click();
  })()`);
  assert.equal(await evaluate(`selectionGroupsRenderer.visibility[Array.from(selectionGroupsRenderer.frame.ids).indexOf(${JSON.stringify(picked.id)})]`), 0, 'hidden group hides its member');
  await selectValue('selection-group-operation', 'replace'); await manualIds('1, 2');
  assert.deepEqual((await groups()).groups[0].atomIds, [1, 2], 'manual editing works while group is hidden');
  await selectValue('selection-group-operation', 'remove'); await manualIds('2');
  await selectValue('selection-group-operation', 'add'); await manualIds('3, 99');
  assert.deepEqual((await groups()).groups[0].atomIds, [1, 3, 99]);
  assert.match(await evaluate('document.getElementById("selection-group-count").textContent'), /^2 atoms in this frame · 1 IDs absent/);
  await evaluate('document.getElementById("selection-group-visible").click()');
  await selectValue('selection-group-operation', 'replace'); await selectValue('selection-group-mode', 'box');
  const camera = await evaluate('[selectionGroupsRenderer.yaw,selectionGroupsRenderer.pitch]');
  await box();
  assert.deepEqual((await groups()).groups[0].atomIds, [1, 2, 3, 4], 'box selects projected centers across depth');
  assert.deepEqual(await evaluate('[selectionGroupsRenderer.yaw,selectionGroupsRenderer.pitch]'), camera, 'group box does not orbit camera');
  assert.equal(await evaluate('selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data === groupOriginalCoordination'), true, 'group edits preserve completed analysis data');
  const initialTheme = await evaluate('document.documentElement.dataset.theme');
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.getElementById('theme-${theme}').click()`);
    const styles = await evaluate(`['selection-group-name','selection-group-mode'].map(id=>{
      const style=getComputedStyle(document.getElementById(id));
      return [style.backgroundColor,style.color,style.borderRadius];
    })`);
    assert.deepEqual(styles[0], styles[1], `group name follows ${theme} input theme`);
    await screenshot(theme === 'light' ? 'selection-groups-desktop' : 'selection-groups-dark');
  }
  await evaluate(`document.getElementById('theme-${initialTheme}').click()`);
  const rect = await viewport();
  await mouse({ x: rect.left + 3, y: rect.top + 3 }, 'mousePressed');
  await mouse({ x: rect.left + rect.width * .6, y: rect.top + rect.height * .6 }, 'mouseMoved');
  assert.equal(await evaluate('Boolean(document.querySelector(".selection-marquee"))'), true);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mouse({ x: rect.left + rect.width * .6, y: rect.top + rect.height * .6 }, 'mouseReleased');
  assert.equal(await evaluate('Boolean(document.querySelector(".selection-marquee"))'), false);
  assert.deepEqual((await groups()).groups[0].atomIds, [1, 2, 3, 4], 'Escape retains existing group membership');
  await evaluate('document.getElementById("add-selection-group").click()');
  await manualIds('1');
  await evaluate(`const color=document.getElementById('selection-group-color');color.value='#0102ab';color.dispatchEvent(new Event('input'));`);
  assert.deepEqual(await evaluate('Array.from(selectionGroupsRenderer.atomColors.slice(0,3))'), [1, 2, 171], 'later group color takes precedence');
  await evaluate('document.getElementById("delete-selection-group").click()');
  assert.equal((await groups()).groups.length, 1);
  assert.deepEqual(await evaluate('Array.from(selectionGroupsRenderer.atomColors.slice(0,3))'), [239, 118, 33], 'deleting group restores prior color');
  await showTool('replicate');
  assert.equal(await evaluate('selectionGroupsRenderer.selectionInteraction.mode'), 'off', 'switching tools ends group picking');
  await evaluate('document.getElementById("replicate-a").value="2";document.getElementById("apply-replicate").click()');
  assert.equal(await evaluate('selectionGroupsRenderer.atomCount'), 4, 'display copies keep original analysis atom count');
  assert.deepEqual(await evaluate('selectionGroupsRenderer.repetitions'), [2, 1, 1]);
  assert.equal(await evaluate('selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data === groupOriginalCoordination'), true);
  await evaluate('document.getElementById("replicate-atoms").click()');
  await waitFor('selectionGroupsRenderer.atomCount === 8 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent === "Calculated"', 'physical copies analyzed');
  assert.deepEqual(await evaluate('selectionGroupsRenderer.repetitions'), [1, 1, 1], 'physical copies are not repeated twice by renderer');
  assert.deepEqual(await evaluate('Array.from(selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data)'), new Array(8).fill(5), 'physical copies add distinct neighbor IDs in thin periodic cell');
  const copiedId = await evaluate('Array.from(selectionGroupsRenderer.frame.ids).find(id=>typeof id === "string")');
  assert.equal(typeof copiedId, 'string');
  await showTool('selectionGroups'); await evaluate('document.getElementById("add-selection-group").click()');
  await manualIds(copiedId);
  assert.deepEqual((await groups()).groups[1].atomIds, [copiedId], 'physical copies can be selected independently');
  const recipe = await exportConfiguration();
  assert.equal(recipe.settings.replicateAtoms, true); assert.deepEqual(recipe.settings.replicate, [2, 1, 1]);
  assert.equal(recipe.settings.selectionGroups.groups[0].name, 'Boundary');
  const recipePath = resolve(profile, 'selection-physical-recipe.json'); await writeFile(recipePath, JSON.stringify(recipe));
  await showTool('replicate'); await screenshot('physical-replication');
  await evaluate('document.getElementById("replicate-atoms").click()');
  await waitFor('selectionGroupsRenderer.atomCount === 4 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent === "Calculated"', 'source atoms restored');
  assert.deepEqual(await evaluate('selectionGroupsRenderer.repetitions'), [2, 1, 1]);
  assert.deepEqual(await evaluate('Array.from(selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data)'), [3, 3, 3, 3]);
  await call('DOM.setFileInputFiles', { nodeId: await inputNode('#configuration-file'), files: [recipePath] });
  await waitFor('selectionGroupsRenderer.atomCount === 8 && document.getElementById("configuration-status").textContent.includes("restored")', 'physical mode and groups JSON restore');
  compareSettings((await exportConfiguration()).settings, recipe.settings);
  await evaluate('document.getElementById("frame-last").click()');
  await waitFor('document.getElementById("frame-label").textContent === "2 / 2" && selectionGroupsRenderer.atomCount === 8 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent === "Calculated"', 'physical replication follows next frame');
  await showTool('selectionGroups'); await evaluate('document.querySelector("[data-selection-group-id=selection-0]").click()');
  assert.match(await evaluate('document.getElementById("selection-group-count").textContent'), /^3 atoms in this frame · 1 IDs absent/, 'groups follow IDs after row reorder and a missing atom');
  assert.deepEqual((await groups()).groups[0].atomIds, [1, 2, 3, 4], 'missing IDs remain stored for later frames');
  await showTool('replicate'); await evaluate('document.getElementById("replicate-atoms").click()');
  await waitFor('selectionGroupsRenderer.atomCount === 4 && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent === "Calculated"', 'source restored before rapid physical cancel');
  await evaluate(`(() => {
    const a=document.getElementById('replicate-a'),b=document.getElementById('replicate-b'),physical=document.getElementById('replicate-atoms');
    a.value='64';b.value='64';physical.click();
    a.value='1';b.value='1';physical.click();
  })()`);
  await waitFor('selectionGroupsRenderer.atomCount === 4 && !document.getElementById("replicate-atoms").checked && document.getElementById("loading").hidden && document.getElementById("analysis-state").textContent === "Calculated"', 'rapid physical cancel restores source and completed analysis');
  assert.deepEqual(await evaluate('selectionGroupsRenderer.repetitions'), [1, 1, 1]);
  assert.deepEqual(await evaluate('Array.from(selectionGroupsRenderer.frame.properties.find(p=>p.name==="coordination").data)'), [3, 3, 3, 3], 'canceled replication retains source coordination');
  const mixedPath = resolve(profile, 'selection-nonperiodic.dump'); await writeFile(mixedPath, dump(0, [0, 1, 2, 3], 'pp ff pp'));
  await load(mixedPath, 'selection-nonperiodic.dump'); await showTool('replicate');
  assert.equal(await evaluate('document.getElementById("replicate-b").disabled'), true);
  assert.equal(await evaluate('document.getElementById("replicate-atoms").checked'), false, 'new source restores display mode');
  assert.equal((await groups()).groups.length, 0, 'new source clears groups');
  await evaluate('document.getElementById("replicate-a").value="2";document.getElementById("replicate-atoms").click()');
  await waitFor('selectionGroupsRenderer.atomCount === 8 && document.getElementById("loading").hidden', 'physical replication respects mixed PBC');
  assert.equal(await evaluate('document.getElementById("replicate-b").value'), '1');
  await load(trajectoryPath, 'selection-groups.dump');
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await showTool('selectionGroups'); await selectValue('selection-group-mode', 'box');
  const touchCamera = await evaluate('[selectionGroupsRenderer.yaw,selectionGroupsRenderer.pitch]');
  await box({ touch: true });
  assert.deepEqual((await groups()).groups[0].atomIds, [1, 2, 3, 4], 'one-finger box selects atoms on phone');
  assert.deepEqual(await evaluate('[selectionGroupsRenderer.yaw,selectionGroupsRenderer.pitch]'), touchCamera);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'group settings fit phone viewport');
  await screenshot('selection-groups-phone');
  await screenshot('selection-groups-phone-editor', 'selection-group-settings');
  await call('Emulation.setTouchEmulationEnabled', { enabled: false });
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate('document.getElementById("close-file").click()');
  assert.equal((await evaluate('document.querySelectorAll("[data-selection-group-id]").length')), 0);
  assert.equal(await evaluate('document.getElementById("add-selection-group").disabled'), true);
  console.log('Selection and physical replication passed: native click/box/Escape and phone touch; persistent named/color/visibility/member groups; stable trajectory IDs; display-only reuse; distinct physical IDs and larger neighbor counts; rapid physical cancellation; mixed PBC; JSON mode/group restore; source cleanup.');
}
