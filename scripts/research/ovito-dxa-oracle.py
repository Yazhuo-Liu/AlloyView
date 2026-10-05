"""Optional Linux CPU DXA oracle; not a dependency of the browser application."""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import resource
import time
from collections import Counter

import numpy as np
import ovito
from ovito.io import import_file
from ovito.modifiers import DislocationAnalysisModifier, ReplicateModifier


def rss_mib():
    with open('/proc/self/status', encoding='utf-8') as source:
        for line in source:
            if line.startswith('VmRSS:'):
                return int(line.split()[1]) / 1024
    return None


def summarize(data):
    segments = data.dislocations.segments
    attributes = {}
    for key, value in data.attributes.items():
        if str(key).startswith('DislocationAnalysis'):
            try:
                attributes[str(key)] = float(value)
            except (ValueError, TypeError):
                attributes[str(key)] = str(value)
    histogram = dict(Counter(map(int, np.asarray(data.particles['Structure Type']))))
    burgers = Counter(tuple(round(float(x), 10) for x in segment.true_burgers_vector)
                      for segment in segments)
    return {
        'atoms': data.particles.count,
        'segments': len(segments),
        'totalLengthAngstrom': sum(segment.length for segment in segments),
        'familiesAndAttributes': attributes,
        'structureHistogramById': histogram,
        'burgersVectorHistogramLocalCrystal': [
            {'burgers': vector, 'segments': count} for vector, count in burgers.items()
        ],
        'segmentsSample': [
            {'id': segment.id, 'lengthAngstrom': segment.length,
             'trueBurgers': list(map(float, segment.true_burgers_vector)),
             'spatialBurgers': list(map(float, segment.spatial_burgers_vector)),
             'points': len(segment.points)} for segment in list(segments)[:15]
        ],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path,
                        default=Path(__file__).resolve().parents[2] / 'examples/NiGB_minimized.cfg')
    parser.add_argument('--output', type=Path, help='Write a JSON record after each case.')
    args = parser.parse_args()
    report = {
        'ovitoVersion': ovito.version_string,
        'ovitoDistributionVersion': importlib.metadata.version('ovito'),
        'pysideVersion': importlib.metadata.version('PySide6'),
        'pythonVersion': platform.python_version(), 'numpyVersion': np.__version__,
        'machine': platform.machine(), 'cpus': os.cpu_count(),
        'file': str(args.source), 'units': 'angstrom', 'cases': [],
        'sourceSha256': hashlib.sha256(args.source.read_bytes()).hexdigest(),
        'memoryDefinition': 'Linux process RSS, including Python/Qt, source and output. '
                            'Peak RSS is cumulative across cases, not DXA scratch alone.',
        'timingDefinition': 'Source loading is separately timed. Analysis time includes '
                            'physical replication in the second case and result assembly; '
                            'one uncached modifier computation per case.',
    }
    with open('/proc/cpuinfo', encoding='utf-8') as source:
        report['cpuModel'] = next((line.split(':', 1)[1].strip() for line in source
                                   if line.startswith('model name')), platform.machine())
    for repeat in [1, 2]:
        row = {'repeat': [1, 1, repeat], 'rssBeforeMiB': rss_mib()}
        started = time.perf_counter()
        try:
            pipeline = import_file(str(args.source))
            raw = pipeline.compute()
            row.update(sourceAtoms=raw.particles.count,
                       cellVectorsRows=np.asarray(raw.cell)[:, :3].T.tolist(),
                       pbc=list(map(bool, raw.cell.pbc)),
                       inputPreparationSeconds=time.perf_counter() - started)
            if repeat > 1:
                pipeline.modifiers.append(ReplicateModifier(
                    num_x=1, num_y=1, num_z=repeat, adjust_box=True, unique_ids=True))
            dxa = DislocationAnalysisModifier(
                input_crystal_structure=DislocationAnalysisModifier.Lattice.FCC)
            row['settings'] = {
                name: str(getattr(dxa, name)) if name == 'input_crystal_structure'
                else getattr(dxa, name) for name in [
                    'input_crystal_structure', 'trial_circuit_length',
                    'circuit_stretchability', 'line_smoothing_level',
                    'line_point_separation', 'only_perfect_dislocations',
                    'defect_mesh_smoothing_level',
                ]
            }
            pipeline.modifiers.append(dxa)
            row['rssBeforeAnalysisMiB'] = rss_mib()
            started = time.perf_counter()
            result = pipeline.compute()
            row.update(status='success', dxaSeconds=time.perf_counter() - started,
                       **summarize(result),
                       expandedCellVectorsRows=np.asarray(result.cell)[:, :3].T.tolist())
        except Exception as error:
            row.update(status='error', error=str(error), dxaSeconds=time.perf_counter() - started)
        row['rssAfterMiB'] = rss_mib()
        # Linux ru_maxrss is KiB and cumulative across both cases; this includes
        # Python/Qt, parsing and replication, not just the numerical kernel.
        row['processPeakRssMiB'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        report['cases'].append(row)
        if args.output:
            args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
