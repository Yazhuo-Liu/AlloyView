import test from 'node:test';
import assert from 'node:assert/strict';
import { constrainFloatingWindow, normalizeFloatingWindow, defaultFloatingWindow, initializeFloatingWindow } from '../src/floating-window.js';
import { copyRendererCamera } from '../src/atomeye-tools.js';
import { WebGLRenderer } from '../src/render/webgl-renderer.js';

function bounded(rect, bounds) {
  assert.ok(rect.left >= 0 && rect.top >= 0 && rect.width > 0 && rect.height > 0);
  assert.ok(rect.left + rect.width <= bounds.width + 1e-10);
  assert.ok(rect.top + rect.height <= bounds.height + 1e-10);
}

function element() {
  const listeners = new Map(), classes = new Set();
  return { listeners, style: {}, classList: {add: value => classes.add(value), remove: value => classes.delete(value)},
    addEventListener(type, callback) { listeners.set(type, callback); }, removeEventListener(type) { listeners.delete(type); },
    closest() { return null; }, setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; }, releasePointerCapture() { this.captured = null; }, focus() {} };
}
function harness() {
  const parent = {clientWidth:900, clientHeight:600}, panel = element(), header = element(), corner = element();
  let reflow, edits = 0;
  panel.ownerDocument = {defaultView: {ResizeObserver: class {constructor(callback) {reflow = callback;} observe() {} disconnect() {}},
    matchMedia() {return {matches:false};} }};
  const controls = initializeFloatingWindow({element:panel,parent,dragHandle:header,resizeHandle:corner,onEdit() {edits++;}});
  function send(handle, type, patch = {}) {
    const event = {target:handle,pointerId:1,button:0,clientX:0,clientY:0,preventDefault() {},stopPropagation() {}, ...patch};
    handle.listeners.get(type)?.(event);
  }
  return {parent,panel,header,corner,controls,send,reflow:()=>reflow(),edits:()=>edits};
}

test('floating windows remain bounded at extreme sizes and normalized layouts survive viewport changes', () => {
  for (const bounds of [{width:1200,height:800}, {width:390,height:400}, {width:100,height:80}, {width:1,height:1}]) {
    const fitted = constrainFloatingWindow({left:-999,top:999,width:10000,height:10},bounds);
    bounded(fitted,bounds);
    const recipe = normalizeFloatingWindow(fitted,bounds);
    assert.ok(Object.values(recipe).every(value=>Number.isFinite(value)&&value>=0&&value<=1));
    assert.ok(recipe.left+recipe.width<=1+1e-12 && recipe.top+recipe.height<=1+1e-12);
  }
  assert.throws(()=>constrainFloatingWindow({left:0,top:0,width:NaN,height:100},{width:400,height:300}),/finite/);
  const h = harness(), layout = {left:.5,top:.5,width:.4,height:.4};
  h.controls.restore(layout); assert.deepEqual(h.controls.serialize(),layout);
  h.parent.clientWidth = 390; h.parent.clientHeight = 400; h.reflow();
  const narrow = h.controls.serialize(); bounded({left:narrow.left*390,top:narrow.top*400,width:narrow.width*390,height:narrow.height*400},{width:390,height:400});
  h.parent.clientWidth = 900; h.parent.clientHeight = 600; h.reflow();
  assert.deepEqual(h.controls.serialize(),layout,'minimum-size fitting on a phone does not destroy the preferred desktop layout');
  h.controls.dispose();
});

test('header and corner pointer/keyboard gestures move and resize independently of canvas camera controls', () => {
  const h = harness(), original = h.controls.serialize();
  h.send(h.header,'pointerdown',{clientX:20,clientY:20});
  h.send(h.header,'pointermove',{clientX:70,clientY:100});
  h.send(h.header,'pointerup');
  const moved = h.controls.serialize();
  assert.ok(moved.left>original.left && moved.top>original.top);
  assert.equal(moved.width,original.width); assert.equal(moved.height,original.height);
  h.send(h.corner,'pointerdown'); h.send(h.corner,'pointermove',{clientX:10000,clientY:10000}); h.send(h.corner,'pointerup');
  const resized = h.controls.serialize();
  assert.ok(resized.width>moved.width && resized.height>moved.height);
  assert.equal(resized.left,moved.left); assert.equal(resized.top,moved.top,'resizing keeps the opposite window corner fixed');
  assert.ok(resized.left+resized.width<=1 && resized.top+resized.height<=1);
  h.send(h.header,'keydown',{key:'Home'}); assert.deepEqual(h.controls.serialize(),original);
  h.send(h.header,'keydown',{key:'ArrowRight',shiftKey:true});
  assert.ok(Math.abs(h.controls.serialize().left-original.left-24/900)<1e-12);
  const before = h.controls.serialize();
  h.send(h.header,'pointerdown',{target:{closest:()=>({tagName:'BUTTON'})}});
  h.send(h.header,'pointermove',{clientX:100,clientY:100});
  assert.deepEqual(h.controls.serialize(),before,'export/apply/close buttons never initiate window dragging');
  h.send(h.corner,'keydown',{key:'ArrowDown'}); assert.ok(h.controls.serialize().height>before.height);
  h.controls.dispose(); assert.equal(h.header.listeners.size,0); assert.equal(h.corner.listeners.size,0);
});

test('responsive defaults avoid desktop atom details and the narrow collapsed details toggle', () => {
  const desktop = defaultFloatingWindow({width:1000,height:650});
  assert.equal(desktop.left,12); assert.equal(desktop.top,56);
  assert.ok(desktop.left+desktop.width<1000-340-18,'default window stays left of the desktop details panel');
  const phone = defaultFloatingWindow({width:390,height:400},{narrow:true});
  assert.ok(phone.top>=104,'collapsed Atom details at top60 plus34px stays accessible');
  bounded(phone,{width:390,height:400});
  const toggle = {left:12,top:60,width:106,height:38};
  for (const width of [390,320]) {
    const bounds = {width,height:270.703};
    const short = defaultFloatingWindow(bounds,{narrow:true});
    bounded(short,bounds);
    assert.ok(short.left>=toggle.left+toggle.width || short.top>=toggle.top+toggle.height,
      'a short pinned viewport never puts the default window over the Atom details toggle');
    const h = harness(); h.parent.clientWidth=width; h.parent.clientHeight=bounds.height;
    h.panel.ownerDocument.defaultView.matchMedia=()=>({matches:true});
    h.controls.restore({left:0,top:0,width:1,height:1});
    h.send(h.header,'keydown',{key:'Home'});
    const reset = h.controls.serialize();
    assert.ok(reset.left*width>=toggle.left+toggle.width || reset.top*bounds.height>=toggle.top+toggle.height,
      'keyboard Home uses the same safe narrow default and minimum size');
    h.controls.dispose();
  }
});

function camera(width,height) {
  return Object.assign(Object.create(WebGLRenderer.prototype), {
    canvas:{width,height}, target:[1,2,3],pan:[4,5,6],yaw:-.62,pitch:.38,roll:.73,constrainUp:false,
    distance:17,orthographicScale:5,fov:40*Math.PI/180,projectionMode:'orthographic',modelRadius:2,
    resize() {},requestRender() {},onProjectionChange(mode) {this.lastProjection=mode;},
  });
}
function near(actual,expected) {assert.ok(Math.abs(actual-expected)<1e-10,`${actual} ≈ ${expected}`);}

test('applying a second camera preserves full physical view, pan and field width across viewport aspects and pole crossings', () => {
  for (const projectionMode of ['perspective','orthographic']) for (const pitch of [.38,2.5,-2.5]) {
    const source = camera(400,300), main = camera(900,400);
    Object.assign(source,{projectionMode,pitch}); Object.assign(main,{yaw:1,pitch:-.2,roll:0,constrainUp:true,pan:[0,0,0]});
    const wanted = source.getCameraState(); copyRendererCamera(source,main); const actual = main.getCameraState();
    for (const key of ['position','direction','up','center']) actual[key].forEach((value,axis)=>near(value,wanted[key][axis]));
    for (const key of ['distance','fov','fieldWidth','yaw','pitch','roll']) near(actual[key],wanted[key]);
    assert.equal(actual.projectionMode,projectionMode); assert.equal(main.lastProjection,projectionMode);
    assert.deepEqual(main.pan,source.pan); assert.deepEqual(main.target,source.target);
    main.pan[0] = 90; assert.equal(source.pan[0],4,'camera arrays are copied rather than shared');
  }
});

test('a closed-window recipe retains layout and camera before creation, export and later reopening', async () => {
  const {createPendingComparisonRestore} = await import('../src/atomeye-tools.js');
  const layout = {left:.25,top:.35,width:.4,height:.45}, source = camera(400,300);
  const savedCamera = Object.fromEntries(['yaw','pitch','roll','fov','constrainUp','distance','orthographicScale','projectionMode','target','pan']
    .map(key=>[key,structuredClone(source[key])]));
  const settings = {enabled:false,preset:'custom',projectionMode:'perspective',camera:savedCamera,layout};
  const pending = createPendingComparisonRestore();
  pending.restore(settings,null);
  const exported = pending.snapshot({enabled:false,preset:'custom',projectionMode:'orthographic',camera:null});
  assert.deepEqual(exported,settings,'exporting a not-yet-created closed window preserves its entire saved view');
  const h = harness(), destination = camera(900,400); destination.frame = null;
  pending.apply(destination,h.controls);
  assert.deepEqual(h.controls.serialize(),layout,'layout can restore before a renderer frame exists');
  assert.deepEqual(pending.snapshot({enabled:false,preset:'custom',layout:h.controls.serialize()}).camera,savedCamera);
  destination.frame = {}; pending.apply(destination,h.controls);
  assert.equal(destination.projectionMode,'perspective');
  for (const key of ['yaw','pitch','roll','distance','orthographicScale']) assert.equal(destination[key],savedCamera[key]);
  assert.deepEqual(destination.pan,savedCamera.pan); assert.deepEqual(destination.target,savedCamera.target);
  destination.pan[0] = 80; assert.equal(settings.camera.pan[0],4,'restored camera does not mutate the imported recipe');
  h.controls.reset(); pending.reset();
  pending.restore(settings,h.controls);
  assert.deepEqual(h.controls.serialize(),layout,'an already-created hidden window restores layout immediately after reset');
  pending.apply(destination,h.controls);
  assert.deepEqual(pending.snapshot({enabled:false,layout:h.controls.serialize(),camera:null}),
    {enabled:false,layout,camera:null},'restored settings are consumed once; later live edits are authoritative');
  h.controls.dispose();
});
