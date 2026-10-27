/** The SVG axis triad in the viewport corner. The renderer reports the three
 * projected axis directions on every render; the triad redraws only when they
 * change. `elements` supplies the `axis-*-line`, `axis-*-label` and
 * `axis-arrows` nodes; gradients are looked up by id. */
export function createAxisTriad({ elements, document: root = document }) {
  let axisTriadKey = '';

  function update(directions) {
    // Every render reports the camera, including frame changes and recoloring
    // that leave it still. The triad depends only on these three directions.
    const key = ['x', 'y', 'z'].map(axis => `${directions[axis].x},${directions[axis].y},${directions[axis].depth}`).join(';');
    if (key === axisTriadKey) return;
    axisTriadKey = key;
    const origin = 48;
    const length = 35;
    const renderOrder = [];
    for (const axis of ['x', 'y', 'z']) {
      const direction = directions[axis];
      const endpointX = origin + direction.x * length;
      const endpointY = origin + direction.y * length;
      const projectedLength = Math.hypot(direction.x, direction.y);
      const unitX = projectedLength > 1e-5 ? direction.x / projectedLength : 0;
      const unitY = projectedLength > 1e-5 ? direction.y / projectedLength : -1;
      const perpendicularX = -unitY;
      const perpendicularY = unitX;
      const labelDistance = projectedLength > 0.08 ? 7.5 / projectedLength : 0;
      const line = elements[`axis-${axis}-line`];
      const label = elements[`axis-${axis}-label`];
      const group = line.parentElement;
      const shadow = group.querySelector('.axis-shadow');
      const shaftHighlight = group.querySelector('.axis-shaft-highlight');
      const cone = group.querySelector('.axis-cone');
      const coneBase = group.querySelector('.axis-cone-base');
      const coneHighlight = group.querySelector('.axis-cone-highlight');
      const depth = Math.max(0, Math.min(1, (direction.depth + 1) / 2));
      const viewAligned = projectedLength < 0.08;
      const visibleLength = projectedLength * length;
      const coneLength = Math.min(10.5 + depth * 2, Math.max(3.5, visibleLength * 0.42));
      const coneRadius = 4.2 + depth * 1.35;
      const shaftEndX = endpointX - unitX * coneLength;
      const shaftEndY = endpointY - unitY * coneLength;
      const coneSideAX = shaftEndX + perpendicularX * coneRadius;
      const coneSideAY = shaftEndY + perpendicularY * coneRadius;
      const coneSideBX = shaftEndX - perpendicularX * coneRadius;
      const coneSideBY = shaftEndY - perpendicularY * coneRadius;
      const highlightOffset = -0.85;
      const lineWidth = 4.2 + depth * 1.25;

      for (const shaft of [line, shadow]) {
        shaft.setAttribute('x2', shaftEndX.toFixed(2));
        shaft.setAttribute('y2', shaftEndY.toFixed(2));
      }
      shaftHighlight.setAttribute('x1', (origin + perpendicularX * highlightOffset).toFixed(2));
      shaftHighlight.setAttribute('y1', (origin + perpendicularY * highlightOffset).toFixed(2));
      shaftHighlight.setAttribute('x2', (shaftEndX + perpendicularX * highlightOffset).toFixed(2));
      shaftHighlight.setAttribute('y2', (shaftEndY + perpendicularY * highlightOffset).toFixed(2));
      cone.setAttribute('points', `${coneSideAX.toFixed(2)},${coneSideAY.toFixed(2)} ${endpointX.toFixed(2)},${endpointY.toFixed(2)} ${coneSideBX.toFixed(2)},${coneSideBY.toFixed(2)}`);
      coneBase.setAttribute('cx', '0');
      coneBase.setAttribute('cy', '0');
      coneBase.setAttribute('rx', (viewAligned ? coneRadius + 3 : 1.55 + depth * 0.65).toFixed(2));
      coneBase.setAttribute('ry', (viewAligned ? coneRadius + 3 : coneRadius).toFixed(2));
      coneBase.setAttribute('transform', viewAligned
        ? `translate(${origin} ${origin})`
        : `translate(${shaftEndX.toFixed(2)} ${shaftEndY.toFixed(2)}) rotate(${(Math.atan2(unitY, unitX) * 180 / Math.PI).toFixed(2)})`);
      coneHighlight.setAttribute('x1', (shaftEndX + perpendicularX * coneRadius * 0.36).toFixed(2));
      coneHighlight.setAttribute('y1', (shaftEndY + perpendicularY * coneRadius * 0.36).toFixed(2));
      coneHighlight.setAttribute('x2', (endpointX - unitX * 1.35).toFixed(2));
      coneHighlight.setAttribute('y2', (endpointY - unitY * 1.35).toFixed(2));
      label.setAttribute('x', (viewAligned ? origin : endpointX + direction.x * labelDistance).toFixed(2));
      label.setAttribute('y', (viewAligned ? origin - 9 : endpointY + direction.y * labelDistance + 3).toFixed(2));
      line.style.strokeWidth = lineWidth.toFixed(2);
      shadow.style.strokeWidth = (lineWidth + 2.8).toFixed(2);
      group.style.opacity = String(0.5 + depth * 0.5);
      for (const item of [line, shadow, shaftHighlight, cone, coneHighlight]) {
        item.style.display = viewAligned ? 'none' : '';
      }
      group.classList.toggle('view-aligned', viewAligned);

      const shaftGradient = root.getElementById(`axis-${axis}-shaft-gradient`);
      const coneGradient = root.getElementById(`axis-${axis}-cone-gradient`);
      for (const gradient of [shaftGradient, coneGradient]) {
        gradient.setAttribute('x1', (origin + perpendicularX * lineWidth).toFixed(2));
        gradient.setAttribute('y1', (origin + perpendicularY * lineWidth).toFixed(2));
        gradient.setAttribute('x2', (origin - perpendicularX * lineWidth).toFixed(2));
        gradient.setAttribute('y2', (origin - perpendicularY * lineWidth).toFixed(2));
      }
      renderOrder.push({ depth: direction.depth, group });
    }
    renderOrder.sort((left, right) => left.depth - right.depth);
    for (const { group } of renderOrder) elements['axis-arrows'].append(group);
  }

  return { update };
}
