import { transformPoint } from './math.js';
import { dislocationSlicePlanes } from './dislocation-layer.js';
import { SLICE_EPSILON } from './slicing.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const ROOT_COLOR = '#ffcf66';
const translated = (point, offset) => point.map((value, axis) => value + offset[axis]);
const interpolate = (first, last, fraction) => first.map((value, axis) => value + (last[axis] - value) * fraction);

/** Clip a world segment to the visible slice volume and camera frustum before
 * projecting. Returned fractions still refer to the original segment. */
function screenSegment(first, last, matrix, width, height, planes = []) {
  let lower = 0, upper = 1;
  const retain = (firstDistance, lastDistance) => {
    if (firstDistance < 0 && lastDistance < 0) return false;
    if (firstDistance < 0) lower = Math.max(lower, firstDistance / (firstDistance - lastDistance));
    else if (lastDistance < 0) upper = Math.min(upper, firstDistance / (firstDistance - lastDistance));
    return lower <= upper;
  };
  for (const { normal, offset } of planes) {
    const distance = point => offset + SLICE_EPSILON
      - normal[0] * point[0] - normal[1] * point[1] - normal[2] * point[2];
    if (!retain(distance(first), distance(last))) return null;
  }
  const a = transformPoint(matrix, ...first), b = transformPoint(matrix, ...last);
  if (![...a, ...b].every(Number.isFinite)) return null;
  if (!retain(a[3] - 1e-10, b[3] - 1e-10)) return null;
  for (let axis = 0; axis < 3; axis++) {
    if (!retain(a[3] + a[axis], b[3] + b[axis]) || !retain(a[3] - a[axis], b[3] - b[axis])) return null;
  }
  const project = fraction => {
    const clip = interpolate(a, b, fraction), w = clip[3];
    return { x: (clip[0] / w + 1) * width / 2, y: (1 - clip[1] / w) * height / 2,
      depth: clip[2] / w, w };
  };
  return { first: project(lower), last: project(upper), lower, upper };
}

/** Find the nearest visible point on one dislocation's displayed paths. Screen
 * interpolation is corrected by clip-space w, so dragging remains attached to
 * the same physical curve with either perspective or orthographic cameras.
 * Disconnected periodic pieces retain their supplied source arc fractions. */
export function closestDislocationAnchor(paths, pointer, {
  matrix, width, height, offset = [0, 0, 0], planes = [], preferredPosition,
} = {}) {
  if (!matrix || !(width > 0 && height > 0) || !Number.isFinite(pointer?.x) || !Number.isFinite(pointer?.y)) return null;
  let best = null;
  for (const { points, fractions } of paths ?? []) {
    if (!points || !fractions || points.length !== fractions.length * 3) continue;
    for (let index = 0; index < fractions.length - 1; index++) {
      const first = translated(Array.from(points.slice(index * 3, index * 3 + 3)), offset);
      const last = translated(Array.from(points.slice(index * 3 + 3, index * 3 + 6)), offset);
      const screen = screenSegment(first, last, matrix, width, height, planes);
      if (!screen) continue;
      const dx = screen.last.x - screen.first.x, dy = screen.last.y - screen.first.y, squaredLength = dx * dx + dy * dy;
      // A line viewed end-on has no screen direction. Preserve its current
      // source position if it falls on this interval, instead of jumping ends.
      const preferred = Number.isFinite(preferredPosition) && fractions[index + 1] !== fractions[index]
        ? Math.max(screen.lower, Math.min(screen.upper,
          (preferredPosition - fractions[index]) / (fractions[index + 1] - fractions[index]))) : screen.lower;
      const screenFraction = squaredLength > 1e-12
        ? Math.max(0, Math.min(1, ((pointer.x - screen.first.x) * dx + (pointer.y - screen.first.y) * dy) / squaredLength)) : 0;
      const denominator = (1 - screenFraction) * screen.last.w + screenFraction * screen.first.w;
      const localFraction = denominator > 0 ? screenFraction * screen.first.w / denominator : 0;
      const fraction = squaredLength > 1e-12 ? screen.lower + (screen.upper - screen.lower) * localFraction : preferred;
      const x = screen.first.x + screenFraction * dx, y = screen.first.y + screenFraction * dy;
      const distanceSquared = (pointer.x - x) ** 2 + (pointer.y - y) ** 2;
      const position = fractions[index] + (fractions[index + 1] - fractions[index]) * fraction;
      const continuity = Number.isFinite(preferredPosition) ? Math.abs(position - preferredPosition) : 0;
      if (!best || distanceSquared < best.distanceSquared - 1e-8
        || Math.abs(distanceSquared - best.distanceSquared) <= 1e-8 && continuity < best.continuity) {
        best = { position: Math.max(0, Math.min(1, position)), point: interpolate(first, last, fraction),
          distanceSquared, continuity, screen: { x, y } };
      }
    }
  }
  return best;
}

function clippingPlanes(renderer) {
  const packed = dislocationSlicePlanes(renderer), planes = [];
  for (let index = 0; index < packed.count; index++) {
    planes.push({ normal: Array.from(packed.values.slice(index * 4, index * 4 + 3)), offset: packed.values[index * 4 + 3] });
  }
  return planes;
}

/** Editing overlay for WebGL Burgers-vector objects. Only the selected root
 * marker is drawn here; the actual arrows remain in the render/export layer.
 * A sibling SVG receives its own pointer events, keeping camera and atom-pick
 * handlers on the canvas out of an arrow selection or constrained drag. */
export function initializeDislocationVectorGizmo(renderer, {
  onSelect = () => {}, onChange = () => {}, onFlip = () => {},
} = {}) {
  const canvas = renderer.canvas, document = canvas.ownerDocument, window = document.defaultView;
  const overlay = document.createElementNS(SVG_NAMESPACE, 'svg');
  overlay.classList.add('dislocation-vector-gizmo');
  overlay.setAttribute('aria-label', 'Dislocation Burgers vector controls');
  Object.assign(overlay.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    zIndex: '3', pointerEvents: 'none', overflow: 'hidden' });
  canvas.parentElement.append(overlay);
  const nodes = new Map(), instances = new Map(), listeners = [];
  let enabled = false, drag = null, currentNetwork = null, currentFrame = null, selectedReplica = null, altHeld = false;

  function element(name, attributes, parent = overlay) {
    const node = document.createElementNS(SVG_NAMESPACE, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.append(node);
    return node;
  }
  function attributes(node, values) {
    for (const [key, value] of Object.entries(values)) node.setAttribute(key, String(value));
  }
  function listen(target, name, callback) {
    target.addEventListener(name, callback);
    listeners.push(() => target.removeEventListener(name, callback));
  }
  // Keep the active drag handle above every arrow's transparent pick region.
  // Separate stable parents avoid reordering (and blurring) a focused handle.
  const targets = element('g', { class: 'dxa-burgers-targets' });
  const handles = element('g', { class: 'dxa-burgers-handles' });
  function allowed() {
    return enabled && !altHeld && renderer.frame && !renderer.presentationPending && !renderer.crystalDrag
      && !canvas.classList.contains('crystal-drag-mode')
      && renderer.dislocationNetwork && renderer.dislocationOptions?.enabled !== false
      && renderer.dislocationOptions?.showBurgersVectors;
  }
  function finish() {
    const pointerId = drag?.pointerId;
    drag = null;
    if (Number.isInteger(pointerId) && overlay.hasPointerCapture?.(pointerId)) overlay.releasePointerCapture(pointerId);
  }
  function makeNodes(key, segmentId) {
    const group = element('g', { 'data-vector-key': key, 'data-segment-id': segmentId }, targets);
    const hit = element('line', { class: 'dxa-burgers-hit', stroke: 'transparent', 'stroke-width': 16,
      'stroke-linecap': 'round', 'pointer-events': 'stroke', 'data-vector-action': 'select',
      role: 'button', tabindex: 0, 'aria-label': `Select Burgers vector on dislocation ${segmentId}` }, group);
    const rootHit = element('circle', { class: 'dxa-burgers-root-hit', r: 8, fill: 'transparent',
      'pointer-events': 'all', 'data-vector-action': 'select' }, group);
    const root = element('circle', { class: 'dxa-burgers-root', r: 7, fill: '#18212b', stroke: ROOT_COLOR,
      'stroke-width': 2.5, 'pointer-events': 'all', 'data-vector-action': 'drag',
      'data-vector-key': key, 'data-segment-id': segmentId,
      role: 'button', tabindex: 0, 'aria-label': `Slide Burgers vector along dislocation ${segmentId}` }, handles);
    const label = element('title', {}, root);
    label.textContent = 'Drag the root along this dislocation. Arrow keys move it; F flips both directions.';
    for (const node of [hit, rootHit, root]) Object.assign(node.style, { cursor: node === root ? 'grab' : 'pointer', touchAction: 'none' });
    return { group, hit, rootHit, root };
  }

  function update() {
    if (currentNetwork !== renderer.dislocationNetwork || currentFrame !== renderer.frame) {
      finish(); currentNetwork = renderer.dislocationNetwork; currentFrame = renderer.frame; selectedReplica = null;
      for (const { group, root } of nodes.values()) { group.remove(); root.remove(); }
      nodes.clear();
    }
    const visible = allowed(), rectangle = canvas.getBoundingClientRect();
    overlay.style.display = visible ? '' : 'none';
    if (!visible || !rectangle.width || !rectangle.height) { finish(); instances.clear(); return; }
    const objects = renderer.dislocationLayer?.vectorGeometry?.objects ?? [];
    const selectedId = renderer.dislocationOptions?.selectedVectorId;
    if (drag && (drag.network !== currentNetwork || drag.displayRevision !== renderer.displayRevision || selectedId !== drag.segmentId
      || !objects.some(object => object.segmentId === drag.segmentId))) finish();
    attributes(overlay, { viewBox: `0 0 ${rectangle.width} ${rectangle.height}` });
    const planes = clippingPlanes(renderer), seen = new Set();
    instances.clear();
    const replicas = renderer.replicas ?? [{ indices: [0, 0, 0], offset: [0, 0, 0] }];
    if (selectedReplica && !replicas.some(replica => replica.indices.join(',') === selectedReplica)) selectedReplica = null;
    for (const object of objects) {
      if (!object.root || !object.burgersEnd) continue;
      for (const replica of replicas) {
        const replicaKey = replica.indices.join(','), key = `${object.segmentId}:${replicaKey}`;
        const root = translated(object.root, replica.offset), end = translated(object.burgersEnd, replica.offset);
        const screen = screenSegment(root, end, renderer.viewProjectionMatrix, rectangle.width, rectangle.height, planes);
        if (!screen) continue;
        const originalRoot = screenSegment(root, root, renderer.viewProjectionMatrix, rectangle.width, rectangle.height, planes)?.first;
        seen.add(key);
        let node = nodes.get(key);
        if (!node) { node = makeNodes(key, object.segmentId); nodes.set(key, node); }
        const selected = object.segmentId === selectedId;
        if (selected && selectedReplica === null) selectedReplica = replicaKey;
        attributes(node.hit, { x1: screen.first.x, y1: screen.first.y, x2: screen.last.x, y2: screen.last.y,
          'aria-pressed': selected });
        const activeRoot = selected && selectedReplica === replicaKey && originalRoot;
        node.root.style.display = activeRoot ? '' : 'none';
        node.rootHit.style.display = originalRoot ? '' : 'none';
        if (originalRoot) {
          attributes(node.root, { cx: originalRoot.x, cy: originalRoot.y });
          attributes(node.rootHit, { cx: originalRoot.x, cy: originalRoot.y });
        }
        node.group.style.display = '';
        instances.set(key, { object, offset: replica.offset, replicaKey, key, rectangle, planes });
      }
    }
    for (const [key, node] of nodes) if (!seen.has(key)) {
      node.group.remove(); node.root.remove(); nodes.delete(key);
    }
    if (drag && !instances.has(drag.key)) finish();
  }

  function instanceFor(event) {
    const group = event.target.closest?.('[data-vector-key]');
    return group && instances.get(group.dataset.vectorKey);
  }
  function select(instance) {
    selectedReplica = instance.replicaKey;
    onSelect(instance.object.segmentId);
    update();
  }
  function move(event) {
    if (!drag || drag.pointerId !== event.pointerId || !allowed()
      || renderer.dislocationNetwork !== drag.network || renderer.frame !== drag.frame
      || renderer.displayRevision !== drag.displayRevision) { finish(); update(); return; }
    const object = renderer.dislocationLayer?.vectorGeometry?.objects.find(item => item.segmentId === drag.segmentId);
    if (!object) { finish(); update(); return; }
    const currentPlanes = clippingPlanes(renderer);
    const nearest = closestDislocationAnchor(object.paths, {
      x: event.clientX - drag.rectangle.left, y: event.clientY - drag.rectangle.top,
    }, { matrix: drag.matrix, width: drag.rectangle.width, height: drag.rectangle.height,
      offset: drag.offset, planes: currentPlanes, preferredPosition: object.position });
    if (nearest && Math.abs(nearest.position - object.position) > 1e-10) onChange(drag.segmentId, { position: nearest.position });
  }

  listen(overlay, 'pointerdown', event => {
    if (!allowed()) { update(); return; }
    if (renderer.crystalDragController?.accepts(event)) {
      altHeld = Boolean(event.altKey); update();
      return;
    }
    if (drag || event.button !== 0) return;
    const instance = instanceFor(event), action = event.target.closest?.('[data-vector-action]')?.dataset.vectorAction;
    if (!instance || !action) return;
    event.preventDefault(); event.stopPropagation();
    const canDrag = action === 'drag' && renderer.dislocationOptions?.selectedVectorId === instance.object.segmentId;
    select(instance);
    if (!canDrag || !allowed()) { nodes.get(instance.key)?.hit.focus?.({ preventScroll: true }); return; }
    drag = { key: instance.key, segmentId: instance.object.segmentId, network: renderer.dislocationNetwork,
      frame: renderer.frame, displayRevision: renderer.displayRevision,
      pointerId: event.pointerId, offset: [...instance.offset], rectangle: instance.rectangle,
      matrix: Array.from(renderer.viewProjectionMatrix), originalPosition: instance.object.position };
    overlay.setPointerCapture(event.pointerId);
    nodes.get(instance.key)?.root.focus?.({ preventScroll: true });
  });
  listen(overlay, 'pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation(); move(event);
  });
  listen(overlay, 'pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault(); event.stopPropagation(); move(event); finish(); update();
  });
  for (const name of ['pointercancel', 'lostpointercapture']) listen(overlay, name, event => {
    if (event.pointerId === drag?.pointerId) { finish(); update(); }
  });
  listen(overlay, 'keydown', event => {
    if (!allowed()) { update(); return; }
    if (event.key === 'Escape' && drag) {
      const previous = drag; finish();
      if (previous.network === renderer.dislocationNetwork && previous.frame === renderer.frame
        && previous.displayRevision === renderer.displayRevision) {
        onChange(previous.segmentId, { position: previous.originalPosition });
      }
      event.preventDefault(); event.stopPropagation(); update(); return;
    }
    const instance = instanceFor(event);
    if (!instance) return;
    const action = event.target.closest?.('[data-vector-action]')?.dataset.vectorAction;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation(); select(instance); return;
    }
    if (renderer.dislocationOptions?.selectedVectorId !== instance.object.segmentId) return;
    if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation(); finish(); onFlip(instance.object.segmentId); return;
    }
    if (action !== 'drag' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault(); event.stopPropagation();
    const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1;
    const position = Math.max(0, Math.min(1, instance.object.position + direction * (event.shiftKey ? .1 : .01)));
    onChange(instance.object.segmentId, { position });
  });
  // Alt is the crystal-drag modifier. Hide the SVG before pointer hit testing
  // so the canvas keeps ownership of that existing gesture.
  listen(window, 'keydown', event => {
    if (event.key === 'Alt' && !altHeld) { altHeld = true; update(); }
  });
  listen(window, 'keyup', event => {
    if (event.key === 'Alt' && altHeld) { altHeld = false; update(); }
  });
  listen(window, 'blur', () => { altHeld = false; finish(); update(); });
  listen(window, 'resize', () => { finish(); update(); });
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  update();
  return {
    update,
    setEnabled(value) { enabled = Boolean(value); update(); },
    dispose() { finish(); for (const remove of listeners) remove(); nodes.clear(); instances.clear(); overlay.remove(); },
  };
}
