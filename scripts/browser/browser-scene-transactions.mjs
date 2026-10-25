import assert from 'node:assert/strict';
import { withWebGpuBrowser } from '../lib/webgpu-browser.mjs';

// Isolate the renderer contract from application orchestration: real GL
// resources must continue to show the old complete scene during a transaction.
const report = await withWebGpuBrowser(async ({ evaluate }) => evaluate(`(async () => {
  const [{ WebGLRenderer }, { createCell }] = await Promise.all([
    import('/AlloyView/src/render/webgl-renderer.js'), import('/AlloyView/src/data/model.js')
  ]);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:400px;height:400px'; document.body.append(canvas);
  const shown = [];
  const renderer = new WebGLRenderer(canvas, { onRender(view) { shown.push(view.frame?.frameIndex); } });
  const cell = createCell({ vectors: [10,0,0,0,10,0,0,0,10] });
  const frame = (index, x) => ({ frameIndex:index, ids:Uint32Array.of(1,2), positions:Float32Array.of(x,2,3,x+2,2,3),
    fractional:Float32Array.of(x/10,.2,.3,(x+2)/10,.2,.3), cell, properties:[] });
  const first=frame(0,1), second=frame(7,5), third=frame(23,3);
  renderer.setFrame(first,Uint8Array.of(0,255,0,0,255,0)); renderer.resetCamera();
  renderer.setBonds({count:1,indices:Uint32Array.of(0,1),vectors:Float32Array.of(2,0,0)}, {visible:true});
  renderer.render();
  const pixels = () => { const values=new Uint8Array(canvas.width*canvas.height*4);
    renderer.gl.readPixels(0,0,canvas.width,canvas.height,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,values);
    let hash=2166136261; for(const value of values)hash=Math.imul(hash^value,16777619);return hash>>>0; };
  const oldHash=pixels(), oldFrame=renderer.frame;
  let programs=0; const createProgram=renderer.gl.createProgram.bind(renderer.gl);
  renderer.gl.createProgram=()=>{programs++;return createProgram();};
  const token=renderer.beginSceneUpdate();
  renderer.setFrame(second,Uint8Array.of(0,0,255,0,0,255)); renderer.render();
  const held={hash:pixels(),shown:shown.at(-1),target:renderer.frame.frameIndex,oldBonds:!!renderer.sceneUpdate.retained.atomBonds,
    presented:renderer.presentedFrame.frameIndex,pick:renderer.pick(200,200)};
  renderer.orbitCamera(.2,.1); renderer.render(); const movedHash=pixels();
  const latest=renderer.beginSceneUpdate();
  renderer.setFrame(third,Uint8Array.of(255,0,0,255,0,0));
  const staleRejected=!renderer.commitSceneUpdate(token);
  let presented=false;
  const presentation=renderer.whenPresented(third).then(()=>{presented=true;return shown.at(-1);});
  await Promise.resolve(); const heldBarrier=!presented;
  renderer.commitSceneUpdate(latest);
  const commitBeforePaint=!presented;
  const presentedFrame=await presentation;
  renderer.render();
  const committed={shown:shown.at(-1),frame:renderer.frame.frameIndex,hash:pixels(),pending:renderer.presentationPending};
  const cancelToken=renderer.beginSceneUpdate();renderer.setFrame(second,Uint8Array.of(0,0,255,0,0,255));
  renderer.cancelSceneUpdate(cancelToken);renderer.render();
  const cancelled={shown:shown.at(-1),frame:renderer.frame.frameIndex,hash:pixels()};
  renderer.clearFrame();
  return {oldHash,held,movedHash,staleRejected,committed,cancelled,presentation:{heldBarrier,commitBeforePaint,presentedFrame},programsCreatedDuringTransitions:programs,
    retainedSourceClosed:renderer.presentedFrame===null,glError:renderer.gl.getError()};
})()`), { requireGpu:false });

assert.equal(report.held.hash,report.oldHash,'pending target still draws the previous complete scene');
assert.equal(report.held.target,7); assert.equal(report.held.presented,0);assert.equal(report.held.shown,0);
assert.equal(report.held.oldBonds,true);assert.equal(report.held.pick,-1);
assert.notEqual(report.movedHash,report.oldHash,'old scene remains orbitable');
assert.equal(report.staleRejected,true);assert.equal(report.committed.frame,23);assert.equal(report.committed.shown,23);
assert.equal(report.committed.pending,false);assert.notEqual(report.committed.hash,report.movedHash);
assert.equal(report.cancelled.frame,23);assert.equal(report.cancelled.hash,report.committed.hash);
assert.equal(report.presentation.heldBarrier,true);assert.equal(report.presentation.commitBeforePaint,true);
assert.equal(report.presentation.presentedFrame,23,'presentation resolves after the actual RAF draw');
assert.equal(report.programsCreatedDuringTransitions,0,'retained banks reuse shader programs');
assert.equal(report.retainedSourceClosed,true);assert.equal(report.glError,0);
console.log(JSON.stringify({result:'passed',...report},null,2));
