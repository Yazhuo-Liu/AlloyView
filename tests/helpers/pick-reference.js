/** Unoptimized picking oracle: original traversal without R4 shortcuts,
 * updated to rank hits by the clipped, rendered sphere's fragment depth. */
import { scalarPreviewAtomVisible } from '../../src/render/scalar-colormap.js';
import { SLICE_EPSILON } from '../../src/render/slicing.js';

export function baselinePick(clientX, clientY) {
    this.lastPick = null;
    if (!this.frame || this.graphicsUnavailable()) return -1;
    this.updateMatrices();
    const rectangle = this.canvas.getBoundingClientRect();
    const x = clientX - rectangle.left;
    const y = clientY - rectangle.top;
    let closest = -1;
    let closestDepth = Number.NEGATIVE_INFINITY, closestWindowDepth = Infinity;
    const positions = this.displayPositions, visibility = this.visibility, radii = this.atomRadii;
    const v = this.viewMatrix, p = this.projectionMatrix, width = rectangle.width, height = rectangle.height;
    const windowDepth = p[2] === 0 && p[6] === 0 && p[3] === 0 && p[7] === 0
      && (p[11] === -1 && p[15] === 0 && p[10] <= -1 && p[14] < 0
        || p[11] === 0 && p[15] === 1 && p[10] < 0);
    const planes = this.sliceMode === 'planes', vectors = this.frame.cell.vectors;
    const slices = planes ? this.slices.filter(slice => slice.enabled) : [];
    const fractional = this.displayFractional ?? this.frame.fractional, axis = this.sliceAxis;
    const repetition = this.repetitions?.[axis] ?? 1;
    for (const replica of this.replicas ?? [{ indices: [0, 0, 0], offset: [0, 0, 0] }]) {
      const [ia, ib, ic] = replica.indices, [ox, oy, oz] = replica.offset;
      for (let atom = 0; atom < this.atomCount; atom += 1) {
        if (visibility?.[atom] === 0) continue;
        if (!scalarPreviewAtomVisible(this.scalarColorPreview, atom)) continue;
        const index = atom * 3;
        if (planes) {
          const px = positions[index] + ia * vectors[0] + ib * vectors[3] + ic * vectors[6];
          const py = positions[index + 1] + ia * vectors[1] + ib * vectors[4] + ic * vectors[7];
          const pz = positions[index + 2] + ia * vectors[2] + ib * vectors[5] + ic * vectors[8];
          let shown = true;
          for (const slice of slices) {
            const distance = slice.normal[0] * px + slice.normal[1] * py + slice.normal[2] * pz - slice.position;
            if (slice.slab ? Math.abs(distance) > slice.thickness / 2 + SLICE_EPSILON
              : slice.side === 'positive' ? distance < -SLICE_EPSILON : distance > SLICE_EPSILON) { shown = false; break; }
          }
          if (!shown) continue;
        } else if (!((fractional[index + axis] + replica.indices[axis]) / repetition <= this.sliceMaximum)) continue;
        const wx = positions[index] + ox, wy = positions[index + 1] + oy, wz = positions[index + 2] + oz;
        const viewX = v[0] * wx + v[4] * wy + v[8] * wz + v[12];
        const viewY = v[1] * wx + v[5] * wy + v[9] * wz + v[13];
        const viewZ = v[2] * wx + v[6] * wy + v[10] * wz + v[14];
        if (viewZ >= 0) continue;
        const clipX = p[0] * viewX + p[4] * viewY + p[8] * viewZ + p[12];
        const clipY = p[1] * viewX + p[5] * viewY + p[9] * viewZ + p[13];
        const clipW = p[3] * viewX + p[7] * viewY + p[11] * viewZ + p[15];
        if (clipW <= 0) continue;
        const centerNdc = (p[10] * viewZ + p[14]) / clipW;
        if (windowDepth && (centerNdc < -1 || centerNdc > 1)) continue;
        const screenX = (clipX / clipW * 0.5 + 0.5) * width;
        const screenY = (0.5 - clipY / clipW * 0.5) * height;
        const radius = (radii?.[atom] ?? 0.7) * this.radiusScale;
        const edgeX = viewX + radius;
        const edgeClipX = p[0] * edgeX + p[4] * viewY + p[8] * viewZ + p[12];
        const edgeClipW = p[3] * edgeX + p[7] * viewY + p[11] * viewZ + p[15];
        const projectedRadius = Math.abs(edgeClipX / edgeClipW - clipX / clipW) * width * 0.5;
        const radiusPixels = Math.max(3, projectedRadius);
        const distanceSquared = (x - screenX) ** 2 + (y - screenY) ** 2;
        const discRadiusSquared = projectedRadius > 0 && Number.isFinite(projectedRadius)
          ? ((x - screenX) / projectedRadius) ** 2 + ((y - screenY) / projectedRadius) ** 2 : 1;
        const surfaceDepth = viewZ + (Number.isFinite(radius) ? radius : 0) * Math.sqrt(Math.max(0, 1 - discRadiusSquared));
        const fragmentDepth = windowDepth ? Math.max(0, Math.min(1,
          (p[10] * surfaceDepth + p[14]) / (p[11] * surfaceDepth + p[15]) * .5 + .5)) : 0;
        if (distanceSquared <= radiusPixels ** 2 && (windowDepth ? fragmentDepth < closestWindowDepth : surfaceDepth > closestDepth)) {
          closest = atom;
          closestDepth = surfaceDepth; closestWindowDepth = fragmentDepth;
          this.lastPick = { index: atom, replica: Array.from(replica.indices), position: [wx, wy, wz] };
        }
      }
    }
    return closest;
  }

