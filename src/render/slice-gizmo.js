import { add, cross, dot, normalize, scale, subtract, transformPoint } from './math.js';
import { planeBoxPolygon, planeCellPolygon, validateSlices } from './slicing.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const PLANE_COLOR = '#6dcfe7';
const ACTIVE_COLOR = '#ffbd69';

// All screen coordinates are CSS pixels. Keeping projection separate from the
// DOM also makes the perspective and orthographic drag geometry testable.
export function projectWorldPoint(matrix, point, width, height) {
  const clip = transformPoint(matrix, ...point);
  if (!(clip[3] > 1e-10)) return null;
  return { x: (clip[0] / clip[3] + 1) * width / 2,
    y: (1 - clip[1] / clip[3]) * height / 2, depth: clip[2] / clip[3] };
}

export function inverseMatrix4(matrix) {
  const rows = Array.from({ length: 4 }, (_, row) => [
    ...Array.from({ length: 4 }, (_, column) => matrix[column * 4 + row]),
    ...Array.from({ length: 4 }, (_, column) => Number(column === row)),
  ]);
  for (let column = 0; column < 4; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 4; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-14) return null;
    [rows[pivot], rows[column]] = [rows[column], rows[pivot]];
    const divisor = rows[column][column];
    rows[column] = rows[column].map(value => value / divisor);
    for (let row = 0; row < 4; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      rows[row] = rows[row].map((value, index) => value - factor * rows[column][index]);
    }
  }
  return Float64Array.from({ length: 16 }, (_, index) => rows[index % 4][4 + Math.floor(index / 4)]);
}

export function unprojectScreenPoint(inverse, x, y, depth, width, height) {
  const world = transformPoint(inverse, x / width * 2 - 1, 1 - y / height * 2, depth);
  if (Math.abs(world[3]) < 1e-14) return null;
  return world.slice(0, 3).map(value => value / world[3]);
}

export function screenRay(inverse, x, y, width, height) {
  const near = unprojectScreenPoint(inverse, x, y, -1, width, height);
  const far = unprojectScreenPoint(inverse, x, y, 1, width, height);
  return near && far ? { origin: near, direction: normalize(subtract(far, near)) } : null;
}

// Parameter on the normal-axis line at the closest approach of a screen ray.
// A view-aligned axis has no usable screen direction; its handle instead uses
// an explicit vertical depth drag, with a scale fixed at pointer-down.
export function closestRayAxisParameter(ray, center, normal) {
  const alignment = dot(ray.direction, normal), denominator = 1 - alignment ** 2;
  if (denominator < 1e-3) return null;
  const relative = subtract(ray.origin, center);
  return (dot(normal, relative) - alignment * dot(ray.direction, relative)) / denominator;
}

// Beyond the sphere silhouette, continue onto its back rather than clamping
// rotation at the equator. Repeated drags can therefore reach every normal.
export function arcballVector(x, y, radius, hemisphere = 1) {
  const horizontal = x / radius, vertical = -y / radius;
  const distance = Math.hypot(horizontal, vertical);
  if (distance <= 1) return [horizontal, vertical, hemisphere * Math.sqrt(Math.max(0, 1 - distance ** 2))];
  const angle = Math.PI / 2 + Math.atan(distance - 1);
  return [horizontal / distance * Math.sin(angle), vertical / distance * Math.sin(angle), hemisphere * Math.cos(angle)];
}

export function rotateBetweenSpherePoints(normal, first, last) {
  const cosine = Math.max(-1, Math.min(1, dot(first, last)));
  let axis = cross(first, last), sine = Math.hypot(...axis);
  if (sine < 1e-12) {
    if (cosine > 0) return Array.from(normal);
    const reference = Math.abs(first[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
    axis = normalize(cross(first, reference));
    sine = 0;
  } else axis = scale(axis, 1 / sine);
  return normalize(add(add(scale(normal, cosine), scale(cross(axis, normal), sine)),
    scale(axis, dot(axis, normal) * (1 - cosine))));
}

function toCamera(vector, view) {
  return [view[0] * vector[0] + view[4] * vector[1] + view[8] * vector[2],
    view[1] * vector[0] + view[5] * vector[1] + view[9] * vector[2],
    view[2] * vector[0] + view[6] * vector[1] + view[10] * vector[2]];
}

function fromCamera(vector, view) {
  return [view[0] * vector[0] + view[1] * vector[1] + view[2] * vector[2],
    view[4] * vector[0] + view[5] * vector[1] + view[6] * vector[2],
    view[8] * vector[0] + view[9] * vector[1] + view[10] * vector[2]];
}

export function initializeSliceGizmo(renderer, { onChange = () => {}, onSelect = () => {} } = {}) {
  const canvas = renderer.canvas, document = canvas.ownerDocument, window = document.defaultView;
  const overlay = document.createElementNS(SVG_NAMESPACE, 'svg');
  overlay.classList.add('slice-gizmo');
  overlay.setAttribute('aria-label', 'Slice plane controls');
  Object.assign(overlay.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    zIndex: '2', pointerEvents: 'none', overflow: 'hidden' });
  canvas.parentElement.append(overlay);
  let slices = [], selectedId = null, visible = false, drag = null, geometry = null, anchoredFrame = null;
  const listeners = [], anchors = new Map();

  function element(name, attributes = {}, parent = overlay) {
    const node = document.createElementNS(SVG_NAMESPACE, name);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    parent.append(node);
    return node;
  }
  function attributes(node, values) {
    for (const [key, value] of Object.entries(values)) node.setAttribute(key, String(value));
  }
  function title(node, text) { const label = element('title', {}, node); label.textContent = text; }
  function listen(target, name, handler) {
    target.addEventListener(name, handler);
    listeners.push(() => target.removeEventListener(name, handler));
  }

  const planes = element('g', { class: 'slice-planes' });
  const sphere = element('g', { class: 'slice-rotation-sphere', 'pointer-events': 'none' });
  const controls = element('g', { class: 'slice-active-controls' });
  const shaftShadow = element('line', { stroke: '#071018', 'stroke-width': 6, 'stroke-linecap': 'round' }, controls);
  const shaft = element('line', { class: 'slice-position-shaft', 'data-action': 'position',
    stroke: ACTIVE_COLOR, 'stroke-width': 3, 'stroke-linecap': 'round', 'pointer-events': 'stroke' }, controls);
  Object.assign(shaft.style, { cursor: 'move', touchAction: 'none' });
  title(shaft, 'Drag the shaft to move the slice along its normal');
  const shaftHit = element('line', { 'data-action': 'position', stroke: 'transparent', 'stroke-width': 18,
    'pointer-events': 'stroke' }, controls);
  Object.assign(shaftHit.style, { cursor: 'move', touchAction: 'none' });
  const cone = element('polygon', { fill: ACTIVE_COLOR, stroke: '#071018', 'stroke-width': 1.4,
    'pointer-events': 'none' }, controls);
  const centerDot = element('circle', { r: 3, fill: ACTIVE_COLOR, 'pointer-events': 'none' }, controls);
  const leader = element('line', { stroke: ACTIVE_COLOR, 'stroke-width': 1, 'stroke-dasharray': '3 3',
    'pointer-events': 'none' }, controls);
  const positionHandle = element('circle', { class: 'slice-position-handle', 'data-action': 'position',
    r: 7, fill: '#071018', stroke: ACTIVE_COLOR, 'stroke-width': 2, 'pointer-events': 'all',
    role: 'button', tabindex: 0, 'aria-label': 'Move slice along its normal' }, controls);
  Object.assign(positionHandle.style, { cursor: 'move', touchAction: 'none' });
  title(positionHandle, 'Drag to move the slice; arrow keys also move it');
  const head = element('circle', { class: 'slice-normal-head', 'data-action': 'normal', r: 9,
    fill: ACTIVE_COLOR, stroke: '#071018', 'stroke-width': 2, 'pointer-events': 'all',
    role: 'button', tabindex: 0, 'aria-label': 'Rotate slice normal' }, controls);
  Object.assign(head.style, { cursor: 'grab', touchAction: 'none' });
  title(head, 'Drag the arrowhead around the sphere to rotate the slice normal');
  const label = element('text', { fill: ACTIVE_COLOR, 'font-size': 11,
    'font-family': 'ui-sans-serif, sans-serif', 'paint-order': 'stroke', stroke: '#071018',
    'stroke-width': 3, 'pointer-events': 'none' }, controls);

  function planeCenter(slice, bounds) {
    const center = bounds.minimum.map((value, axis) => (value + bounds.maximum[axis]) / 2);
    const old = anchors.get(slice.id);
    // Keep a rotated plane's pivot in place. Numeric edits move the same pivot
    // to the edited plane, so its handle remains attached to the actual plane.
    const anchor = old?.center ?? center;
    const point = add(anchor, scale(slice.normal, slice.position - dot(slice.normal, anchor)));
    anchors.set(slice.id, { center: point });
    return point;
  }

  function update() {
    const rectangle = canvas.getBoundingClientRect();
    const hasVisiblePlane = slices.some(slice => slice.showGizmo);
    overlay.style.display = visible && renderer.frame && hasVisiblePlane ? '' : 'none';
    if (!visible || !renderer.frame || !hasVisiblePlane || !rectangle.width || !rectangle.height) return;
    if (renderer.frame !== anchoredFrame) { anchors.clear(); anchoredFrame = renderer.frame; }
    attributes(overlay, { viewBox: `0 0 ${rectangle.width} ${rectangle.height}` });
    overlay.dataset.selectedId = selectedId ?? '';
    const bounds = renderer.getDisplayBounds?.() ?? renderer.sceneBounds;
    if (!bounds) return;
    const vertices = renderer.getDisplayCellVertices?.();
    const project = point => projectWorldPoint(renderer.viewProjectionMatrix, point, rectangle.width, rectangle.height);
    planes.replaceChildren();
    for (const slice of slices) {
      if (!slice.showGizmo) continue;
      let polygon = vertices ? planeCellPolygon(slice, vertices) : [];
      if (polygon.length < 3) polygon = planeBoxPolygon(slice, bounds);
      const screen = polygon.map(project);
      if (screen.length < 3 || screen.some(point => !point)) continue;
      const active = slice.id === selectedId;
      const node = element('polygon', { class: 'slice-plane', 'data-slice-id': slice.id,
        points: screen.map(point => `${point.x},${point.y}`).join(' '),
        fill: active ? ACTIVE_COLOR : PLANE_COLOR, 'fill-opacity': slice.enabled ? active ? 0.16 : 0.08 : 0.025,
        stroke: active ? ACTIVE_COLOR : PLANE_COLOR, 'stroke-opacity': active ? 0.9 : 0.55,
        'stroke-width': active ? 1.8 : 1, 'stroke-dasharray': slice.enabled ? 'none' : '5 4',
        'pointer-events': 'stroke' }, planes);
      node.style.cursor = 'pointer';
      title(node, `Select ${slice.name}`);
      // A slab also shows the two faces that bound the atoms it keeps.
      if (slice.slab) for (const sign of [-1, 1]) {
        const face = { ...slice, position: slice.position + sign * slice.thickness / 2 };
        let outline = vertices ? planeCellPolygon(face, vertices) : [];
        if (outline.length < 3) outline = planeBoxPolygon(face, bounds);
        const projected = outline.map(project);
        if (projected.length < 3 || projected.some(point => !point)) continue;
        element('polygon', { class: 'slice-slab-face', points: projected.map(point => `${point.x},${point.y}`).join(' '),
          fill: 'none', stroke: active ? ACTIVE_COLOR : PLANE_COLOR, 'stroke-opacity': slice.enabled ? 0.6 : 0.3,
          'stroke-width': 1, 'stroke-dasharray': '4 3', 'pointer-events': 'none' }, planes);
      }
    }
    const slice = slices.find(item => item.id === selectedId && item.showGizmo);
    controls.style.display = slice ? '' : 'none';
    sphere.replaceChildren();
    sphere.style.display = drag?.mode === 'normal' ? '' : 'none';
    if (!slice) { geometry = null; return; }
    const center = drag?.id === slice.id
      ? drag.mode === 'position' ? add(drag.center, scale(drag.normal, slice.position - drag.position)) : drag.center
      : planeCenter(slice, bounds);
    const origin = project(center);
    if (!origin) { controls.style.display = 'none'; geometry = null; return; }
    const inverse = inverseMatrix4(renderer.viewProjectionMatrix);
    if (!inverse) return;
    const screenRadius = Math.max(42, Math.min(88, rectangle.height * 0.2, rectangle.width * 0.2));
    const right = unprojectScreenPoint(inverse, origin.x + screenRadius, origin.y,
      origin.depth, rectangle.width, rectangle.height);
    if (!right) return;
    const radius = Math.hypot(...subtract(right, center));
    const endpoint = project(add(center, scale(slice.normal, radius)));
    if (!endpoint) { controls.style.display = 'none'; geometry = null; return; }
    const dx = endpoint.x - origin.x, dy = endpoint.y - origin.y, length = Math.hypot(dx, dy);
    const unit = length > 1e-5 ? [dx / length, dy / length] : [0, -1];
    attributes(shaft, { x1: origin.x, y1: origin.y, x2: endpoint.x, y2: endpoint.y });
    for (const line of [shaftHit, shaftShadow]) attributes(line,
      { x1: origin.x, y1: origin.y, x2: endpoint.x, y2: endpoint.y });
    const base = [endpoint.x - unit[0] * 16, endpoint.y - unit[1] * 16];
    attributes(cone, { points: `${endpoint.x},${endpoint.y} ${base[0] - unit[1] * 7},${base[1] + unit[0] * 7} ${base[0] + unit[1] * 7},${base[1] - unit[0] * 7}` });
    cone.style.display = length > 18 ? '' : 'none';
    attributes(centerDot, { cx: origin.x, cy: origin.y });
    const handle = length >= 32
      ? [origin.x + dx * 0.4, origin.y + dy * 0.4] : [origin.x + 28, origin.y + 22];
    attributes(positionHandle, { cx: handle[0], cy: handle[1] });
    attributes(leader, { x1: origin.x, y1: origin.y, x2: handle[0], y2: handle[1] });
    leader.style.display = length < 32 ? '' : 'none';
    attributes(head, { cx: endpoint.x, cy: endpoint.y });
    attributes(label, { x: handle[0] + 11, y: handle[1] + 4 });
    label.textContent = slice.name;
    geometry = { slice, center, origin, radius, screenRadius, inverse,
      width: rectangle.width, height: rectangle.height, rectangle, view: Array.from(renderer.viewMatrix),
      positionDepthDrag: length < 32 };
    if (drag?.mode === 'normal') {
      element('circle', { cx: origin.x, cy: origin.y, r: screenRadius,
        fill: '#78c9e5', 'fill-opacity': 0.055, stroke: '#a7dcec', 'stroke-opacity': 0.5,
        'stroke-width': 1 }, sphere);
      // World-axis great circles give depth and orientation cues while the
      // translucent sphere remains behind the plane's handles.
      for (let axis = 0; axis < 3; axis += 1) {
        const points = [];
        for (let step = 0; step <= 64; step += 1) {
          const angle = step / 64 * Math.PI * 2, point = Array.from(center);
          point[(axis + 1) % 3] += Math.cos(angle) * radius;
          point[(axis + 2) % 3] += Math.sin(angle) * radius;
          const screen = project(point);
          if (screen) points.push(`${screen.x},${screen.y}`);
        }
        element('polyline', { points: points.join(' '), fill: 'none', stroke: ['#ff8c83', '#9ce1a0', '#8cb8ff'][axis],
          'stroke-width': 1, 'stroke-opacity': 0.5, 'stroke-dasharray': '3 3' }, sphere);
      }
    }
  }

  function localPoint(event, rectangle = geometry.rectangle) {
    return { x: event.clientX - rectangle.left, y: event.clientY - rectangle.top };
  }
  function finish() {
    if (!drag) return;
    const pointerId = drag.pointerId;
    if (drag.mode === 'position') {
      const slice = slices.find(item => item.id === drag.id);
      if (slice) anchors.set(drag.id, { center: add(drag.center, scale(drag.normal, slice.position - drag.position)) });
    }
    drag = null;
    if (Number.isInteger(pointerId) && overlay.hasPointerCapture?.(pointerId)) overlay.releasePointerCapture(pointerId);
    head.style.cursor = 'grab';
    update();
  }
  listen(overlay, 'pointerdown', event => {
    if (drag || event.button !== 0 || !visible) return;
    const handle = event.target.closest?.('[data-action]');
    if (!handle) {
      const plane = event.target.closest?.('[data-slice-id]');
      if (plane) { event.preventDefault(); event.stopPropagation(); onSelect(plane.dataset.sliceId); }
      return;
    }
    if (!geometry) return;
    event.preventDefault(); event.stopPropagation();
    const point = localPoint(event), { slice, origin, screenRadius, view, inverse, width, height, center } = geometry;
    const cameraNormal = toCamera(slice.normal, view), hemisphere = cameraNormal[2] < 0 ? -1 : 1;
    const ray = screenRay(inverse, point.x, point.y, width, height);
    const parameter = ray && !geometry.positionDepthDrag ? closestRayAxisParameter(ray, center, slice.normal) : null;
    drag = { ...geometry, id: slice.id, mode: handle.dataset.action, pointerId: event.pointerId,
      start: point, normal: Array.from(slice.normal), position: slice.position,
      cameraNormal, hemisphere, parameter,
      sphereStart: arcballVector(point.x - origin.x, point.y - origin.y, screenRadius, hemisphere) };
    overlay.setPointerCapture(event.pointerId);
    head.style.cursor = 'grabbing';
    update();
  });
  listen(overlay, 'pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    const point = localPoint(event, drag.rectangle);
    if (drag.mode === 'normal') {
      const spherePoint = arcballVector(point.x - drag.origin.x, point.y - drag.origin.y, drag.screenRadius, drag.hemisphere);
      const cameraNormal = rotateBetweenSpherePoints(drag.cameraNormal, drag.sphereStart, spherePoint);
      const normal = normalize(fromCamera(cameraNormal, drag.view));
      // A freely rotated normal no longer follows Miller indices.
      onChange(drag.id, { normal, position: dot(normal, drag.center), miller: null });
    } else {
      let offset;
      if (drag.parameter !== null) {
        const ray = screenRay(drag.inverse, point.x, point.y, drag.width, drag.height);
        const next = ray ? closestRayAxisParameter(ray, drag.center, drag.normal) : null;
        offset = next === null ? 0 : next - drag.parameter;
      } else offset = (drag.start.y - point.y) * drag.radius / drag.screenRadius;
      onChange(drag.id, { normal: Array.from(drag.normal), position: drag.position + offset });
    }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    listen(overlay, name, event => { if (drag?.pointerId === event.pointerId) finish(); });
  }
  listen(overlay, 'keydown', event => {
    const handle = event.target.closest?.('[data-action]');
    if (!handle || !geometry || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { slice, center, view, radius } = geometry;
    const sign = ['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1;
    if (handle.dataset.action === 'position') {
      onChange(slice.id, { normal: Array.from(slice.normal), position: slice.position + sign * radius * (event.shiftKey ? 0.2 : 0.04) });
    } else {
      const angle = sign * (event.shiftKey ? 0.15 : 0.03), horizontal = ['ArrowLeft', 'ArrowRight'].includes(event.key);
      const normal = normalize(fromCamera(rotateBetweenSpherePoints(toCamera(slice.normal, view), [0, 0, 1],
        horizontal ? [Math.sin(angle), 0, Math.cos(angle)] : [0, Math.sin(angle), Math.cos(angle)]), view));
      onChange(slice.id, { normal, position: dot(normal, center), miller: null });
    }
  });
  listen(window, 'blur', finish);
  listen(document, 'visibilitychange', () => { if (document.hidden) finish(); });
  update();

  return {
    setState(state) {
      slices = validateSlices(state.slices ?? []).map((slice, index) => ({ ...slice,
        showGizmo: state.slices[index].showGizmo !== false }));
      selectedId = state.selectedId ?? null;
      visible = Boolean(state.visible);
      const ids = new Set(slices.map(slice => slice.id));
      for (const id of anchors.keys()) if (!ids.has(id)) anchors.delete(id);
      if (drag && (!visible || !ids.has(drag.id) || selectedId !== drag.id
        || !slices.find(slice => slice.id === drag.id)?.showGizmo)) finish();
      update();
    },
    update,
    dispose() { finish(); for (const remove of listeners) remove(); overlay.remove(); },
  };
}
