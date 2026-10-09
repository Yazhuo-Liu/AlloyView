import { cellVertices, invert3 } from '../data/model.js';
import { normalizePeriodicOrigin } from './periodic-origin.js';

// Dragging the crystal moves the periodic display origin. While the pointer
// moves, only shader uniforms change: each display fractional coordinate f is
// moved to f′ = f − shift and rewrapped on periodic axes, without CPU work or
// buffer uploads. Releasing commits the origin through the normal path, which
// rebuilds every derived display exactly as a typed origin does.

/** Committed drag origins are rounded to this many decimal places, so typing
 * the value shown in the origin fields reproduces the committed state. */
export const CRYSTAL_DRAG_DIGITS = 4;
/** Keyboard nudge step at camera gear 5, in fractions of a cell vector. */
export const CRYSTAL_NUDGE_STEP = 0.05;

/** Shared by atom, bond/vector and site-marker vertex shaders. The returned
 * step is f′ − f; open axes have zero shift and zero wrap, so they never move. */
export const CRYSTAL_DRAG_GLSL = `
uniform bool uCrystalDrag;
uniform vec3 uCrystalShift;
uniform vec3 uCrystalWrap;
uniform mat3 uCrystalCell;
vec3 crystalDragStep(vec3 fractional) {
  if (!uCrystalDrag) return vec3(0.0);
  return -uCrystalShift - uCrystalWrap * floor(fractional - uCrystalShift);
}`;
export const CRYSTAL_DRAG_UNIFORMS = ['uCrystalDrag', 'uCrystalShift', 'uCrystalWrap', 'uCrystalCell'];

/** `markers` wrap on every periodic axis, as site markers always do. */
export function applyCrystalDragUniforms(gl, uniforms, drag, { markers = false } = {}) {
  gl.uniform1i(uniforms.uCrystalDrag, drag ? 1 : 0);
  if (!drag) return;
  gl.uniform3f(uniforms.uCrystalShift, ...drag.shift);
  gl.uniform3f(uniforms.uCrystalWrap, ...(markers ? drag.periodic : drag.wrap));
  gl.uniformMatrix3fv(uniforms.uCrystalCell, false, drag.cell);
}

const cleanZero = value => value || 0;

/** Renderer state for a drag preview. `shift` is relative to the committed
 * origin; it is masked to the periodic axes. */
export function createCrystalDragState(renderer, shift) {
  const cell = renderer.frame.cell;
  const values = normalizePeriodicOrigin(shift).map((value, axis) => cell.pbc[axis] ? cleanZero(value) : 0);
  const periodic = cell.pbc.map(value => value ? 1 : 0);
  const wrap = renderer.coordinateMode === 'unwrapped' ? [0, 0, 0] : periodic;
  return { active: true, shift: values, wrap, periodic, cell: Float32Array.from(cell.vectors),
    bounds: crystalDragBounds(renderer.sceneBounds, cellVertices(renderer.displayCell ?? cell), cell, values) };
}

/** Conservative near/far bounds during a drag. Wrapped geometry stays in the
 * displayed cell, but anything overhanging one face (bonds, arrows, radii)
 * may now overhang the opposite face; unwrapped atoms and trajectory lines
 * translate by −H·shift. */
export function crystalDragBounds(base, vertices, cell, shift) {
  if (!base) return null;
  const minimum = [...base.minimum], maximum = [...base.maximum];
  const cellMinimum = [Infinity, Infinity, Infinity], cellMaximum = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertices.length; index += 1) {
    const axis = index % 3;
    cellMinimum[axis] = Math.min(cellMinimum[axis], vertices[index]);
    cellMaximum[axis] = Math.max(cellMaximum[axis], vertices[index]);
  }
  const h = cell.vectors;
  for (let axis = 0; axis < 3; axis += 1) {
    const overhang = Math.max(0, cellMinimum[axis] - base.minimum[axis], base.maximum[axis] - cellMaximum[axis]);
    minimum[axis] = Math.min(minimum[axis], cellMinimum[axis] - overhang);
    maximum[axis] = Math.max(maximum[axis], cellMaximum[axis] + overhang);
    const translation = -(shift[0] * h[axis] + shift[1] * h[3 + axis] + shift[2] * h[6 + axis]);
    minimum[axis] = Math.min(minimum[axis], base.minimum[axis] + translation);
    maximum[axis] = Math.max(maximum[axis], base.maximum[axis] + translation);
  }
  return { minimum, maximum };
}

/** Translations that preview geometry cut at the committed cell faces, such
 * as DXA lines. The pieces lie in the displayed cell and move by −H·shift. In
 * wrapped mode a piece at fraction f ∈ [0, 1] is shown at f − shift + n with
 * n ∈ {⌊shift⌋, ⌊shift⌋ + 1} on each wrapped axis, clipped to the cell, so a
 * piece pushed through a face reappears at the opposite face. */
export function crystalDragImages(cell, drag) {
  const h = cell.vectors;
  let images = [[0, 1, 2].map(axis => -(drag.shift[0] * h[axis] + drag.shift[1] * h[3 + axis] + drag.shift[2] * h[6 + axis]))];
  for (let axis = 0; axis < 3; axis += 1) {
    if (!drag.wrap[axis]) continue;
    const lowest = Math.floor(drag.shift[axis]);
    images = images.flatMap(image => [lowest, lowest + 1].map(step => image.map((value, component) => value + step * h[axis * 3 + component])));
  }
  return images.map(image => image.map(cleanZero));
}

/** Cartesian displacement for a screen drag of (dx, dy) CSS pixels, in the
 * plane parallel to the screen through `anchor`. Works for perspective and
 * orthographic projection: clip w is constant on that plane. */
export function screenDragDisplacement({ viewMatrix: v, projectionMatrix: p, width, height }, anchor, dx, dy) {
  if (!(width > 0) || !(height > 0)) throw new Error('The viewport has no size.');
  const [x, y, z] = anchor;
  const viewX = v[0] * x + v[4] * y + v[8] * z + v[12];
  const viewY = v[1] * x + v[5] * y + v[9] * z + v[13];
  const viewZ = v[2] * x + v[6] * y + v[10] * z + v[14];
  // Behind the eye a grabbed point has no meaningful depth; use unit depth.
  const w = Math.max(1e-6, Math.abs(p[3] * viewX + p[7] * viewY + p[11] * viewZ + p[15]));
  const moveX = 2 * dx / width * w / p[0], moveY = -2 * dy / height * w / p[5];
  return [0, 1, 2].map(axis => moveX * v[axis * 4] + moveY * v[axis * 4 + 1]);
}

/** Change of the reduced display origin that moves the crystal by
 * `displacement`. Atoms follow the pointer, so the origin moves opposite to
 * them; open axes keep their origin (the motion is projected along them). */
export function originChangeForDisplacement(displacement, cell) {
  const inverse = invert3(cell.vectors), [x, y, z] = displacement;
  return [0, 1, 2].map(axis => cell.pbc[axis]
    ? cleanZero(-(x * inverse[axis] + y * inverse[3 + axis] + z * inverse[6 + axis])) : 0);
}

/** Round an origin to CRYSTAL_DRAG_DIGITS decimals. In wrapped mode, whole
 * cell shifts are invisible, so each periodic component is reduced to [0, 1);
 * unwrapped display keeps the continuous translation. */
export function snapCrystalOrigin(origin, cell, coordinateMode = 'wrapped', digits = CRYSTAL_DRAG_DIGITS) {
  const scale = 10 ** digits;
  return normalizePeriodicOrigin(origin).map((value, axis) => {
    if (!cell.pbc[axis]) return 0;
    let steps = Math.round(value * scale);
    if (coordinateMode !== 'unwrapped') steps = ((steps % scale) + scale) % scale;
    return cleanZero(steps / scale);
  });
}

/** CPU mirror of the shader: display positions and fractions after shifting
 * the committed display by `drag.shift`. `float32` rounds like the GPU. */
export function crystalDragDisplay(displayPositions, displayFractional, cell, drag, { float32 = false } = {}) {
  const round = float32 ? Math.fround : value => value;
  const positions = new Float64Array(displayPositions.length), fractional = new Float64Array(displayFractional.length);
  const h = Array.from(cell.vectors, round), shift = drag.shift.map(round), step = [0, 0, 0];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = round(displayFractional[index + axis]);
      step[axis] = round(-shift[axis] - drag.wrap[axis] * Math.floor(round(value - shift[axis])));
      fractional[index + axis] = round(value + step[axis]);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      positions[index + axis] = round(round(displayPositions[index + axis])
        + round(round(h[axis] * step[0]) + round(h[3 + axis] * step[1]) + round(h[6 + axis] * step[2])));
    }
  }
  return { positions, fractional };
}

/** CPU mirror of the bond shader's image shift for the second atom. */
export function crystalDragBondShifts(bonds, shifts, displayFractional, drag) {
  const output = new Int32Array(bonds.count * 3);
  for (let bond = 0; bond < bonds.count; bond += 1) {
    const first = bonds.indices[bond * 2] * 3, second = bonds.indices[bond * 2 + 1] * 3;
    for (let axis = 0; axis < 3; axis += 1) {
      const step = value => -drag.shift[axis] - drag.wrap[axis] * Math.floor(value - drag.shift[axis]);
      output[bond * 3 + axis] = shifts[bond * 3 + axis]
        + Math.round(step(displayFractional[first + axis]) - step(displayFractional[second + axis]));
    }
  }
  return output;
}

const sameOrigin = (left, right) => left.every((value, axis) => Object.is(cleanZero(value), cleanZero(right[axis])));

/** Pointer-driven drag on one renderer. `update` receives a pointer with
 * start and current client coordinates; the drag starts once it has moved. */
export class CrystalDragGesture {
  constructor(renderer, { getOrigin, getCoordinateMode = () => renderer.coordinateMode ?? 'wrapped',
    onChange = () => {}, onCommit = () => {}, onEnd = () => {} } = {}) {
    Object.assign(this, { renderer, getOrigin, getCoordinateMode, onChange, onCommit, onEnd });
    this.state = null;
  }

  get active() { return Boolean(this.state); }

  begin(clientX, clientY) {
    const renderer = this.renderer, cell = renderer.frame?.cell;
    if (!cell || !cell.pbc.some(Boolean)) return false;
    // Grab the atom under the pointer, so it follows the pointer exactly in
    // perspective; otherwise use the depth of the orbit center.
    const atom = renderer.pick(clientX, clientY);
    const anchor = atom >= 0 && renderer.lastPick?.position ? [...renderer.lastPick.position]
      : [0, 1, 2].map(axis => renderer.target[axis] + renderer.pan[axis]);
    const origin = normalizePeriodicOrigin(this.getOrigin()).map((value, axis) => cell.pbc[axis] ? cleanZero(value) : 0);
    this.state = { cell, anchor, origin, target: origin, accumulated: [0, 0, 0], coordinateMode: this.getCoordinateMode(),
      x: clientX, y: clientY };
    return true;
  }

  /** Add a pointer movement; returns the origin the release would commit. */
  moveTo(clientX, clientY) {
    const state = this.state, renderer = this.renderer;
    if (!state) return null;
    const rectangle = renderer.canvas.getBoundingClientRect();
    const displacement = screenDragDisplacement({ viewMatrix: renderer.viewMatrix, projectionMatrix: renderer.projectionMatrix,
      width: rectangle.width, height: rectangle.height }, state.anchor, clientX - state.x, clientY - state.y);
    state.x = clientX; state.y = clientY;
    const change = originChangeForDisplacement(displacement, state.cell);
    state.accumulated = state.accumulated.map((value, axis) => value + change[axis]);
    state.target = snapCrystalOrigin(state.origin.map((value, axis) => value + state.accumulated[axis]), state.cell, state.coordinateMode);
    // Preview relative to the committed display. A drag back to an all-zero
    // origin from zero is the unwrapped source display, i.e. no preview.
    const unchanged = sameOrigin(state.target, state.origin);
    renderer.setCrystalDragShift(unchanged && state.origin.every(value => value === 0) ? null
      : state.target.map((value, axis) => value - state.origin[axis]));
    this.onChange(state.target);
    return state.target;
  }

  /** Release: clear the preview, then commit through the normal origin path. */
  commit() {
    const state = this.end();
    if (state && !sameOrigin(state.target, state.origin)) this.onCommit([...state.target]);
    return state?.target ?? null;
  }

  /** Escape, a second finger or an interrupted pointer restore the previous origin. */
  cancel() { return Boolean(this.end()); }

  end() {
    const state = this.state;
    if (!state) return null;
    this.state = null;
    this.renderer.setCrystalDragShift(null);
    this.onEnd(state);
    return state;
  }
}
