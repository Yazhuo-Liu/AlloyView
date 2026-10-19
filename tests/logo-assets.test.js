import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { buildSite, checkLogoAssetBudget, LOGO_ASSET_BUDGET } from '../scripts/build.mjs';
import { initializeBccLogo } from '../src/render/bcc-logo.js';
import { initializeTheme } from '../src/ui/shell/theme.js';

const root = resolve(import.meta.dirname, '..');
const pngSize = bytes => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

test('runtime logos fit the aggregate budget with one small embedded mark per wordmark', async () => {
  const total = await checkLogoAssetBudget(root);
  assert.ok(total > 0 && total <= LOGO_ASSET_BUDGET);
  for (const theme of ['dark', 'light']) {
    const svg = await readFile(resolve(root, `src/assets/logo/AlloyView_logo_${theme}.svg`), 'utf8');
    const images = [...svg.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)];
    assert.equal(images.length, 1, 'SVG must not duplicate the bitmap in href and xlink:href');
    const bitmap = Buffer.from(images[0][1], 'base64');
    assert.deepEqual(pngSize(bitmap), [256, 256]);
    assert.equal(bitmap[25], 6, 'the original transparent mark remains RGBA');
    assert.match(svg, /viewBox="0 0 1700 500"/);
  }
  assert.deepEqual(pngSize(await readFile(resolve(root, 'src/assets/logo/AlloyView_favicon.png'))), [64, 64]);
  assert.deepEqual(pngSize(await readFile(resolve(root, 'src/assets/logo/AlloyView_logo_only.png'))), [264, 264]);
});

test('the budget is aggregate and recursive, permits absent fixtures and rejects before changing a build output', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'alloyview-logo-budget-'));
  try {
    assert.equal(await checkLogoAssetBudget(temporary), 0);
    const logo = resolve(temporary, 'src/assets/logo');
    await mkdir(resolve(logo, 'nested'), { recursive: true });
    await writeFile(resolve(logo, 'one.png'), new Uint8Array(100 * 1024));
    await writeFile(resolve(logo, 'nested/two.png'), new Uint8Array(100 * 1024));
    assert.equal(await checkLogoAssetBudget(temporary), LOGO_ASSET_BUDGET, '200 KiB exactly is accepted');
    await writeFile(resolve(logo, 'extra.svg'), 'x');
    const out = resolve(temporary, 'dist');
    await mkdir(out); await writeFile(resolve(out, 'existing.html'), 'previous deploy');
    await assert.rejects(buildSite(temporary, out), /Logo assets total 204,801 bytes.*200 KiB/);
    assert.equal(await readFile(resolve(out, 'existing.html'), 'utf8'), 'previous deploy');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('the template does not fetch an opposite-theme wordmark or an unused fallback', async () => {
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  const brand = html.match(/<img\s+[^>]*id="brand-logo"[^>]*>/)?.[0];
  const fallback = html.match(/<img\s+[^>]*class="empty-logo-fallback"[^>]*>/)?.[0];
  assert.ok(brand && fallback);
  assert.doesNotMatch(brand, /\ssrc=/);
  assert.doesNotMatch(fallback, /\ssrc=/);
  assert.match(fallback, /\shidden(?:\s|>)/);
  const lazyPath = fallback.match(/\sdata-src="([^"]+)"/)?.[1];
  assert.ok(lazyPath); assert.deepEqual(pngSize(await readFile(resolve(root, lazyPath))), [264,264]);
  const favicon = html.match(/<link\s+[^>]*rel="icon"[^>]*>/)?.[0];
  assert.match(favicon, /sizes="64x64"/);
  assert.deepEqual(pngSize(await readFile(resolve(root, favicon.match(/href="([^"]+)"/)[1]))), [64,64]);
});

function globals(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable:true, writable:true, value });
  t.after(() => { for (const [key, descriptor] of Object.entries(saved)) { if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key]; } });
}

test('theme initialization requests only the saved choice and switches the image when the user changes theme', t => {
  const sources = [], handlers = new Map(), logo = { set src(value) { sources.push(value); } };
  const buttons = Object.fromEntries(['light','dark'].map(theme => [`theme-${theme}`, {
    addEventListener: (_type, callback) => handlers.set(theme, callback), setAttribute() {},
  }]));
  const document = { documentElement:{dataset:{}}, getElementById:id=>id==='brand-logo'?logo:buttons[id] };
  globals(t, { document, matchMedia:()=>({matches:true,addEventListener(){}}), localStorage:{getItem:()=> 'dark',setItem(){}} });
  initializeTheme();
  assert.equal(sources.length,1); assert.ok(sources[0].endsWith('AlloyView_logo_light.svg'));
  assert.equal(document.documentElement.dataset.theme,'dark');
  handlers.get('light')();
  assert.equal(sources.length,2); assert.ok(sources[1].endsWith('AlloyView_logo_dark.svg'));
  assert.equal(document.documentElement.dataset.theme,'light');
});

test('unsupported WebGL loads the fallback on demand and repeated initialization does not reload it', () => {
  let source = null, loads = 0;
  const fallback = { hidden:true, dataset:{src:'./src/assets/logo/AlloyView_logo_only.png'},
    getAttribute:()=>source, set src(value){source=value;loads++;} };
  const canvas = { hidden:true, getContext:()=>null };
  const container = { querySelector:selector=>selector==='canvas'?canvas:fallback };
  const empty = { querySelector:()=>container };
  assert.equal(source,null);
  initializeBccLogo(empty).dispose();
  assert.equal(source,fallback.dataset.src); assert.equal(loads,1);
  assert.equal(fallback.hidden,false); assert.equal(canvas.hidden,true);
  initializeBccLogo(empty).dispose(); assert.equal(loads,1);
});
