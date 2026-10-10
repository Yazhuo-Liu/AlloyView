"""Optional grain segmentation oracle; not a dependency of the browser application.

Runs OVITO's PolyhedralTemplateMatchingModifier and GrainSegmentationModifier
on a structure file and writes the PTM output (structure types, single
precision orientations and template neighbor lists) and the grains found for
several settings as raw little-endian arrays with a meta.json.
scripts/research/ovito-grains-compare.mjs reads that directory.

Validated with the PyPI package ovito==3.9.4 and numpy<2:

  python3 -m venv /tmp/ovito-grains-venv
  /tmp/ovito-grains-venv/bin/pip install "ovito==3.9.4" "numpy<2"
  QT_QPA_PLATFORM=offscreen /tmp/ovito-grains-venv/bin/python -I \\
      scripts/research/ovito-grains-oracle.py structure.dump reference/ \\
      --variants "default:;manual:algorithm=manual,threshold=12;mst:algorithm=mst,threshold=2"

A variant is name:key=value,... with keys algorithm (automatic, manual, mst),
threshold, minsize, orphans (0/1) and interfaces (0/1).
"""

import argparse
import json
import os
import time

import numpy as np
import ovito
from ovito.data import PTMNeighborFinder
from ovito.io import import_file
from ovito.modifiers import GrainSegmentationModifier, PolyhedralTemplateMatchingModifier

PTM_TYPES = {
    'FCC': PolyhedralTemplateMatchingModifier.Type.FCC, 'HCP': PolyhedralTemplateMatchingModifier.Type.HCP,
    'BCC': PolyhedralTemplateMatchingModifier.Type.BCC, 'ICO': PolyhedralTemplateMatchingModifier.Type.ICO,
    'SC': PolyhedralTemplateMatchingModifier.Type.SC, 'CUBIC_DIAMOND': PolyhedralTemplateMatchingModifier.Type.CUBIC_DIAMOND,
    'HEX_DIAMOND': PolyhedralTemplateMatchingModifier.Type.HEX_DIAMOND, 'GRAPHENE': PolyhedralTemplateMatchingModifier.Type.GRAPHENE,
}
ALGORITHMS = {
    'automatic': GrainSegmentationModifier.Algorithm.GraphClusteringAuto,
    'manual': GrainSegmentationModifier.Algorithm.GraphClusteringManual,
    'mst': GrainSegmentationModifier.Algorithm.MinimumSpanningTree,
}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('structure')
    parser.add_argument('output')
    parser.add_argument('--ptm-types', default='FCC,HCP,BCC', help='OVITO enables these three by default')
    parser.add_argument('--rmsd', type=float, default=0.1)
    parser.add_argument('--variants', default='default:')
    parser.add_argument('--no-neighbors', action='store_true', help='skip the per-atom neighbor lists (slow in Python)')
    args = parser.parse_args()
    os.makedirs(args.output, exist_ok=True)

    def save(name, array, dtype):
        np.array(array).astype(dtype).tofile(os.path.join(args.output, name))

    pipeline = import_file(args.structure)
    ptm = PolyhedralTemplateMatchingModifier(output_orientation=True, rmsd_cutoff=args.rmsd)
    enabled = set(args.ptm_types.split(','))
    for name, kind in PTM_TYPES.items():
        ptm.structures[kind].enabled = name in enabled
    pipeline.modifiers.append(ptm)
    started = time.time()
    data = pipeline.compute()
    count = data.particles.count
    meta = {'ovito': list(ovito.version), 'atoms': int(count), 'cell': np.asarray(data.cell[...]).tolist(),
            'pbc': [bool(value) for value in data.cell.pbc], 'ptmTypes': sorted(enabled), 'rmsd': args.rmsd,
            'ptmSeconds': time.time() - started, 'variants': {}}
    save('positions.f64', data.particles.positions, '<f8')
    save('structure.i32', data.particles['Structure Type'], '<i4')
    save('orientation.f32', data.particles['Orientation'], '<f4')  # x, y, z, w
    if not args.no_neighbors:
        # The lists GrainSegmentationEngine1::createNeighborBonds reads: the
        # template neighbors of a matched atom, the nearest eight of any other.
        finder = PTMNeighborFinder(data)
        counts = np.zeros(count, dtype=np.uint8)
        indices = np.zeros((count, 16), dtype=np.uint32)
        structure = np.asarray(data.particles['Structure Type'])
        for atom in range(count):
            limit = 8 if structure[atom] == 0 else 16
            length = 0
            for neighbor in finder.find(atom):
                if length >= limit:
                    break
                indices[atom, length] = neighbor.index
                length += 1
            counts[atom] = length
        save('neighbor_counts.u8', counts, 'u1')
        save('neighbor_indices.u32', indices, '<u4')

    for spec in args.variants.split(';'):
        name, _, settings = spec.partition(':')
        options = dict(item.split('=') for item in settings.split(',') if item)
        pipeline.modifiers.append(GrainSegmentationModifier(
            algorithm=ALGORITHMS[options.get('algorithm', 'automatic')],
            merging_threshold=float(options.get('threshold', 0)),
            min_grain_size=int(options.get('minsize', 100)),
            orphan_adoption=options.get('orphans', '1') == '1',
            handle_stacking_faults=options.get('interfaces', '1') == '1'))
        started = time.time()
        try:
            result = pipeline.compute()
        except RuntimeError as error:
            meta['variants'][name] = {'options': options, 'error': str(error)}
            pipeline.modifiers.pop()
            continue
        grains = result.tables['grains']
        entry = {'options': options, 'seconds': time.time() - started,
                 'grainCount': int(result.attributes['GrainSegmentation.grain_count']),
                 'autoThreshold': result.attributes.get('GrainSegmentation.auto_merge_threshold'), 'tables': {}}
        save(f'{name}.grain.i32', result.particles['Grain'], '<i4')
        save(f'{name}.grain_sizes.i32', grains['Grain Size'], '<i4')
        save(f'{name}.grain_types.i32', grains['Structure Type'], '<i4')
        save(f'{name}.grain_orientations.f64', grains['Orientation'], '<f8')  # x, y, z, w
        for table in ('grains-merge', 'grains-log'):
            if table not in result.tables:
                continue
            columns = list(result.tables[table].keys())
            entry['tables'][table] = {'columns': columns, 'points': int(len(result.tables[table][columns[0]]))}
            for column in columns:
                save(f"{name}.{table}.{column.replace(' ', '_')}.f64", result.tables[table][column], '<f8')
        meta['variants'][name] = entry
        pipeline.modifiers.pop()
    with open(os.path.join(args.output, 'meta.json'), 'w', encoding='utf-8') as stream:
        json.dump(meta, stream, indent=1)
    print(json.dumps({name: {key: value for key, value in entry.items() if key != 'tables'}
                      for name, entry in meta['variants'].items()}))


if __name__ == '__main__':
    main()
