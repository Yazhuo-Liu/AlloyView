import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withWebGpuBrowser } from './webgpu-browser.mjs';

const production = process.argv.includes('--production');
const fixture = [8, 'Lattice="4 0 0 0 4 0 0 0 4" pbc="T T T" Properties=species:S:1:pos:R:3:id:I:1:energy:R:1',
  ...Array.from({ length: 8 }, (_, atom) => `${atom % 2 ? 'Cu' : 'Ni'} ${(atom & 1) * 2} ${((atom >> 1) & 1) * 2} ${((atom >> 2) & 1) * 2} ${atom + 1} ${atom}`), ''].join('\n');

const report = await withWebGpuBrowser(async ({ evaluate, call }) => {
  const origin = await evaluate('location.origin');
  await call('Emulation.setHardwareConcurrencyOverride', { hardwareConcurrency: 4 });
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
  async function wait(expression, label) {
    for (let attempt = 0; attempt < 400; attempt++) {
      if (await evaluate(expression)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${label}`);
  }
  await wait('document.querySelector(".feature-help-link") && document.querySelector("#show-keyboard-shortcuts")', 'page controls and late-loaded styles');
  await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
  await evaluate(`(() => { const files = new DataTransfer(); files.items.add(new File([${JSON.stringify(fixture.repeat(3))}], 'touch-targets.xyz')); const input = document.getElementById('file-input'); input.files = files.files; input.dispatchEvent(new Event('change')); })()`);
  await wait('document.getElementById("file-name").textContent === "touch-targets.xyz" && document.getElementById("loading").hidden && !document.getElementById("frame-next").disabled', 'three-frame fixture');
  function measurements(selector) {
    return `(() => [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node=>node.getClientRects().length).map(node=>{const b=node.getBoundingClientRect();return {id:node.id || node.getAttribute('aria-label') || node.textContent.trim().slice(0,45),width:b.width,height:b.height}}))()`;
  }
  const desktop = await evaluate(measurements('#close-tool, .feature-help-link, .trajectory-controls > button'));
  assert.deepEqual(await evaluate(`['#theme-light','#theme-dark','#theme-toggle'].map(selector=>Boolean(document.querySelector(selector).getClientRects().length))`), [true, true, false]);
  assert.equal(desktop.find(row => row.id === 'close-tool').height < 32, true, 'desktop text action remains compact');
  assert.ok(desktop.some(row => row.width === 19 && row.height === 19), 'desktop help retains its original size');
  let mobile = true;
  async function press(selector, { edge = false, inset = 3 } = {}) {
    const point = await evaluate(`(async () => { const node=document.querySelector(${JSON.stringify(selector)}); if(!node)throw new Error('Missing '+${JSON.stringify(selector)});node.scrollIntoView({block:'center',inline:'nearest'});await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const b=node.getBoundingClientRect();const x=b.left+( ${edge} ? ${inset} : b.width/2),y=b.top+( ${edge} ? b.height-${inset} : b.height/2),hit=document.elementFromPoint(x,y);return {x,y,enabled:!node.disabled,hit:hit===node||node.contains(hit),actual:hit?.id||hit?.className};})()`);
    assert.ok(point.enabled && point.hit, `${selector} is reachable including its enlarged edge: ${JSON.stringify(point)}`);
    if (mobile) {
      await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y }] });
      await delay(60);
      await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, x: point.x, y: point.y, clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, x: point.x, y: point.y, clickCount: 1 });
    }
    await delay(35);
  }
  const screens = [];
  for (const [width, height] of [[320, 740], [375, 812], [430, 932], [844, 390]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    // Each device is an independent page: native range gesture/capture state
    // must not be carried into a different emulated screen or orientation.
    await call('Emulation.setTouchEmulationEnabled', { enabled: false });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await call('Page.navigate', { url: `${origin}/AlloyView/${production ? 'dist/' : ''}index.html` });
    await wait('document.querySelector(".feature-help-link") && document.querySelector("#show-keyboard-shortcuts")', 'mobile page styles');
    await evaluate('if(document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")==="true")document.getElementById("enable-gpu-computing").click()');
    await wait('document.getElementById("brand-logo").complete && document.getElementById("brand-logo").naturalWidth > 0', 'compact logo');
    const header = await evaluate(`(() => {
      const bounds=selector=>{const b=document.querySelector(selector).getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height}};
      return {bar:bounds('.topbar'),logo:bounds('#brand-logo'),theme:bounds('#theme-toggle'),gpu:bounds('#enable-gpu-computing'),
        source:document.getElementById('brand-logo').currentSrc,
        buttons:[...document.querySelectorAll('.compute-theme-controls button')].filter(node=>node.getClientRects().length).map(node=>node.id),
        resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/assets/logo/')).map(entry=>entry.name.split('/').at(-1))};
    })()`);
    assert.deepEqual(header.buttons, ['theme-toggle', 'enable-gpu-computing'], 'phone shows one theme toggle and one GPU toggle');
    assert.equal(header.logo.width, 32); assert.equal(header.logo.height, 32);
    assert.ok(header.source.endsWith('AlloyView_favicon.png'), 'phone uses the small icon instead of the full wordmark');
    assert.ok(!header.resources.some(name=>name.endsWith('.svg')), 'phone does not download an unused desktop wordmark');
    assert.ok(header.bar.height <= (width >= 540 ? 50 : 90), `compact header: ${JSON.stringify(header.bar)}`);
    assert.ok(header.logo.right < header.theme.left && header.theme.right < header.gpu.left && header.gpu.right <= width, 'logo and toggles fit without overlap');
    for (const control of [header.theme, header.gpu]) assert.ok(control.height >= 36 && control.width >= 36, 'compact controls retain touch targets');
    const themeBefore = await evaluate('document.documentElement.dataset.theme');
    await press('#theme-toggle');
    const expectedTheme = themeBefore === 'dark' ? 'light' : 'dark';
    assert.deepEqual(await evaluate(`({theme:document.documentElement.dataset.theme,saved:localStorage.getItem('alloyview-theme'),pressed:document.getElementById('theme-toggle').getAttribute('aria-pressed')})`),
      {theme:expectedTheme,saved:expectedTheme,pressed:String(expectedTheme==='dark')});
    await press('#theme-toggle');
    assert.equal(await evaluate('document.documentElement.dataset.theme'), themeBefore, 'second tap turns dark mode off or on again');
    await press('#enable-gpu-computing');
    assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'true');
    await press('#enable-gpu-computing');
    assert.equal(await evaluate('document.getElementById("enable-gpu-computing").getAttribute("aria-pressed")'), 'false');
    await evaluate(`(() => {const files=new DataTransfer();files.items.add(new File([${JSON.stringify(fixture.repeat(3))}],'touch-targets.xyz'));const input=document.getElementById('file-input');input.files=files.files;input.dispatchEvent(new Event('change'));})()`);
    await wait('document.getElementById("file-name").textContent === "touch-targets.xyz" && document.getElementById("loading").hidden && !document.getElementById("frame-next").disabled', 'mobile fixture');
    await delay(100);
    console.error(`Mobile targets: ${width}x${height}`);
    await evaluate('if(!document.querySelector("[data-tool-button=display]").classList.contains("active"))document.querySelector("[data-tool-button=display]").click()');
    const checked = [];
    async function checkTargets(label, selector) {
      const sizes = await evaluate(measurements(selector));
      assert.ok(sizes.length, `${width}px ${label} has controls`);
      for (const size of sizes) assert.ok(size.width >= 31.9 && size.height >= 31.9,
        `${width}px ${label}: ${JSON.stringify(size)} must provide at least a 32px target`);
      checked.push({ label, count: sizes.length, minimumWidth: Math.min(...sizes.map(size=>size.width)), minimumHeight: Math.min(...sizes.map(size=>size.height)) });
    }
    await checkTargets('toolbar and playback', '.view-toolbar button:not([hidden]), .trajectory-controls > button, #toggle-atom-details, #toggle-view-controls, #toggle-legend');
    await checkTargets('Display', '#tool-display button, #tool-display .feature-help-link, #tool-display label:has(>input[type=checkbox]), #tool-display summary, #tool-display .element-style-row input[type=checkbox]');
    await press('label:has(>#compare-view)');
    await wait('document.querySelector(".comparison-view")?.getClientRects().length', 'second view');
    await checkTargets('second view', '.comparison-view button');
    // A short landscape frame can place the floating window beneath another
    // overlay; its titlebar is the existing control for bringing it forward.
    await press('#comparison-drag-handle', { edge: true, inset: 8 });
    await press('.comparison-close');
    await press('#toggle-camera-controls');
    await checkTargets('camera', '.camera-controls button, .camera-controls label:has(>input[type=checkbox])');
    await press('.camera-controls > header button');
    const boxBefore = await evaluate('document.getElementById("show-cell").checked');
    await press('label:has(>#show-cell)', { edge: true });
    assert.equal(await evaluate('document.getElementById("show-cell").checked'), !boxBefore, 'tap in the enlarged label changes its checkbox');
    await press('label:has(>#show-cell)', { edge: true });
    for (const tool of ['coordination', 'cna', 'ptm', 'voronoi', 'slice', 'selectionGroups', 'expressions']) {
      const selector = `[data-tool-button="${tool}"]`;
      if (!await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) throw new Error(`Unknown tool ${tool}`);
      const category = await evaluate(`document.querySelector(${JSON.stringify(selector)}).closest('[data-tool-category-panel]').dataset.toolCategoryPanel`);
      if (await evaluate(`document.getElementById('tool-category-${category}').getAttribute('aria-selected')`) !== 'true') await press(`#tool-category-${category}`);
      if (!await evaluate(`document.querySelector(${JSON.stringify(selector)}).classList.contains('active')`)) await press(selector);
      await evaluate('document.querySelector("[data-tool-panel]:not([hidden]) details")?.setAttribute("open","")');
      await checkTargets(tool, '[data-tool-panel]:not([hidden]) button, [data-tool-panel]:not([hidden]) .feature-help-link, [data-tool-panel]:not([hidden]) label:has(>input[type=checkbox]), [data-tool-panel]:not([hidden]) summary');
    }
    await press('#close-tool', { edge: true });
    assert.equal(await evaluate('document.querySelector("[data-tool-panel]:not([hidden])") === null'), true, 'enlarged Close action works');
    // At the smallest screen the toolbar, Details and View must remain disjoint.
    const topTargets = await evaluate(`['.view-toolbar','#toggle-atom-details','#toggle-view-controls'].map(s=>{const b=document.querySelector(s).getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}})`);
    assert.ok(topTargets[0].right <= topTargets[1].left && topTargets[1].right <= topTargets[2].left,
      `${width}px toolbar and overlays do not overlap: ${JSON.stringify(topTargets)}`);
    await press('#toggle-legend');
    await checkTargets('categorical legend', '.legend-category-actions button, .legend-items label');
    const firstType = await evaluate('document.querySelector(".legend-items input[type=checkbox]").checked');
    await press('.legend-items label', { edge: true, inset: 10 });
    assert.equal(await evaluate('document.querySelector(".legend-items input[type=checkbox]").checked'), !firstType, 'legend enlarged checkbox label toggles visibility');
    await press('.legend-items label', { edge: true, inset: 10 });
    await evaluate('(() => {const color=document.getElementById("legend-color-mode");color.value="property:energy";color.dispatchEvent(new Event("change"));})()');
    await checkTargets('scalar legend', '.legend-actions button, .legend-controls .legend-visibility, .legend-controls input[type=number], .legend-property select');
    const screenshotPath = resolve(tmpdir(), `alloyview-mobile-targets-${width}.png`);
    const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));
    if (await evaluate('document.getElementById("legend-auto").getAttribute("aria-pressed")') !== 'true') await evaluate('document.getElementById("legend-auto").click()');
    await press('#legend-auto', { edge: true, inset: 8 });
    await wait('document.getElementById("legend-auto").getAttribute("aria-pressed")=="false"', 'Auto toggled at enlarged edge');
    await press('#legend-auto');
    await wait('document.getElementById("legend-auto").getAttribute("aria-pressed")=="true"', 'Auto toggled on');
    const thumb = await evaluate(`(() => {const input=document.querySelector('.legend-slider input[data-limit=minimum]');input.parentElement.scrollIntoView({block:'center'});const b=input.getBoundingClientRect(),x=b.left+16,y=b.top+b.height/2+12;return {x,y,value:Number(input.value),hit:document.elementFromPoint(x,y)===input};})()`);
    assert.ok(thumb.hit, 'a point 12px below the slider center hits the enlarged thumb');
    await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: thumb.x, y: thumb.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: thumb.x + 36, y: thumb.y }] });
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok(await evaluate(`Number(document.querySelector('.legend-slider input[data-limit=minimum]').value)>${thumb.value}`), 'touching the enlarged thumb and dragging changes the range');
    await wait('document.getElementById("legend-auto").getAttribute("aria-pressed")=="false"', 'slider drag disables Auto');
    // Test the native range gesture separately from tap synthesis. Close this
    // scrollable overlay as fixture cleanup before switching viewport metrics.
    await evaluate('document.getElementById("toggle-legend").click()');
    await evaluate('(() => {const color=document.getElementById("color-mode");color.value="type";color.dispatchEvent(new Event("change"));})()');
    const overflow = await evaluate('({page:document.documentElement.scrollWidth>innerWidth,sidebar:document.querySelector(".sidebar").scrollWidth>document.querySelector(".sidebar").clientWidth})');
    assert.deepEqual(overflow, { page: false, sidebar: false }, `${width}px page and tool panel stay within the phone`);
    screens.push({ width, height, header, checked, screenshotPath });
  }
  mobile = false;
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  await evaluate('if(!document.querySelector("[data-tool-button=display]").classList.contains("active"))document.querySelector("[data-tool-button=display]").click()');
  assert.deepEqual(await evaluate(measurements('#close-tool, .feature-help-link, .trajectory-controls > button')), desktop, 'desktop dimensions restore after every mobile viewport');
  await wait('document.getElementById("brand-logo").currentSrc.endsWith(".svg") && document.getElementById("brand-logo").naturalWidth>0', 'desktop wordmark restored');
  assert.deepEqual(await evaluate(`['#theme-light','#theme-dark','#theme-toggle'].map(selector=>Boolean(document.querySelector(selector).getClientRects().length))`), [true, true, false]);
  await evaluate('document.getElementById("theme-dark").click()');
  assert.equal(await evaluate('document.getElementById("theme-toggle").getAttribute("aria-pressed")'), 'true', 'desktop theme choices synchronize the phone toggle');
  await evaluate('document.getElementById("theme-light").click()');
  assert.equal(await evaluate('document.getElementById("theme-toggle").getAttribute("aria-pressed")'), 'false');
  return { production, desktop, screens };
}, { requireGpu: false });
console.log(JSON.stringify(report, null, 2));
