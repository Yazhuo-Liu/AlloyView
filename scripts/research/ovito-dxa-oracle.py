"""Export a complete, versioned OVITO DXA reference (optional research dependency).

Validated with Python 3.11, ovito==3.9.4, numpy==1.26.4 and PySide6==6.6.3.1.
The browser application and ordinary tests do not require these packages.
--help and the CA parser work with the Python standard library alone.

CA v6 graph decoding follows the pinned upstream CAExporter.cpp at
https://gitlab.com/stuko/ovito/-/blob/939f5d909ea3b0fd0dd6695494da8f8d03821c2e/src/ovito/crystalanalysis/exporter/CAExporter.cpp
The native CA archive retains all fields, but its floating-point formatting is
less precise than the Python API arrays. API coordinates and cluster matrices
are therefore exported separately at full JSON binary64 round-trip precision.
"""

import argparse
from collections import Counter
import hashlib
import importlib.metadata
import json
import math
import numbers
import os
from pathlib import Path
import platform
import resource
import tempfile
import time


SCHEMA_VERSION = 2
CA_SOURCE = ('https://gitlab.com/stuko/ovito/-/blob/'
             '939f5d909ea3b0fd0dd6695494da8f8d03821c2e/'
             'src/ovito/crystalanalysis/exporter/CAExporter.cpp')


def json_value(value):
    """Convert arrays/scalars without importing NumPy or rounding values."""
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Real):
        value = float(value)
        if not math.isfinite(value):
            raise ValueError('Reference scientific data contains a non-finite value')
        return value
    if hasattr(value, 'tolist'):
        return json_value(value.tolist())
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    return [json_value(item) for item in value]


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def rss_mib():
    try:
        with open('/proc/self/status', encoding='utf-8') as source:
            for line in source:
                if line.startswith('VmRSS:'):
                    return int(line.split()[1]) / 1024
    except OSError:
        pass
    return None


def parse_ca_graph(text):
    """Read complete CA v6 clusters/transitions and exact junction-ring links.

    CA writes nodes[0] (forward, last polyline point) before nodes[1]
    (backward, first point). Each row contains nextIsForward, nextSegmentId.
    Output end 0 denotes the first point; end 1 denotes the last point, matching
    AlloyView's public network. No connectivity is inferred from coordinates.
    """
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines or lines[0] != 'CA_FILE_VERSION 6':
        raise ValueError('Only the pinned native CA format version 6 is supported')

    def section(name):
        matches = [i for i, line in enumerate(lines)
                   if line == name or line.startswith(name + ' ')]
        if len(matches) != 1:
            raise ValueError(f'Expected exactly one CA {name} section')
        return matches[0]

    def numeric(line, count, integer=False):
        words = line.split()
        if len(words) != count:
            raise ValueError(f'Expected {count} CA values: {line!r}')
        result = [(int if integer else float)(word) for word in words]
        if not all(math.isfinite(value) for value in result):
            raise ValueError('Non-finite native CA field')
        return result

    index = section('CLUSTERS')
    count = int(lines[index].split()[1])
    if count < 0:
        raise ValueError('Negative native cluster count')
    clusters = []
    index += 1
    for _ in range(count):
        if not lines[index].startswith('CLUSTER '):
            raise ValueError('Missing CA CLUSTER record')
        cluster = {'id': int(lines[index].split()[1])}
        index += 1
        while lines[index] != 'END_CLUSTER':
            key, *values = lines[index].split()
            if key == 'CLUSTER_STRUCTURE':
                cluster['structureType'] = int(values[0])
            elif key == 'CLUSTER_SIZE':
                cluster['atomCount'] = int(values[0])
            elif key == 'CLUSTER_COLOR':
                cluster['color'] = numeric(' '.join(values), 3)
            elif key == 'CLUSTER_ORIENTATION':
                cluster['orientationRows'] = [numeric(lines[index + row], 3)
                                               for row in (1, 2, 3)]
                index += 3
            else:
                raise ValueError(f'Unsupported CA cluster field {key}')
            index += 1
        if not all(key in cluster for key in ('structureType', 'atomCount', 'orientationRows')):
            raise ValueError('Incomplete native cluster record')
        clusters.append(cluster)
        index += 1
    if len({cluster['id'] for cluster in clusters}) != len(clusters):
        raise ValueError('Duplicate CA cluster identifier')
    cluster_ids = {cluster['id'] for cluster in clusters}
    if any(identifier <= 0 for identifier in cluster_ids):
        raise ValueError('Native CA must omit the null cluster')

    index = section('CLUSTER_TRANSITIONS')
    transitions = []
    transition_count = int(lines[index].split()[1])
    if transition_count < 0:
        raise ValueError('Negative native transition count')
    for _ in range(transition_count):
        index += 1
        parts = lines[index].split()
        if len(parts) != 3 or parts[0] != 'TRANSITION':
            raise ValueError('Invalid native transition record')
        # Unlike CLUSTER ids, the exporter writes transition endpoints minus 1.
        source, target = int(parts[1]) + 1, int(parts[2]) + 1
        if source not in cluster_ids or target not in cluster_ids:
            raise ValueError('Native transition references a missing cluster')
        index += 1
        matrix = numeric(lines[index], 9)
        transitions.append({'source': source, 'target': target,
                            'matrixRows': [matrix[start:start + 3] for start in (0, 3, 6)]})

    index = section('DISLOCATIONS')
    segment_count = int(lines[index].split()[1])
    if segment_count < 0:
        raise ValueError('Negative native segment count')
    segments = []
    index += 1
    for _ in range(segment_count):
        segment_id = int(lines[index])
        burgers = numeric(lines[index + 1], 3)
        cluster_id = int(lines[index + 2])
        point_count = int(lines[index + 3])
        if point_count < 2 or cluster_id not in cluster_ids:
            raise ValueError('Invalid native segment points or cluster')
        index += 4
        points, core_sizes = [], []
        for _ in range(point_count):
            values = lines[index].split()
            if len(values) not in (3, 4):
                raise ValueError('Invalid native dislocation point')
            points.append(numeric(' '.join(values[:3]), 3))
            core_sizes.append(int(values[3]) if len(values) == 4 else None)
            index += 1
        if any(value is None for value in core_sizes) and any(value is not None for value in core_sizes):
            raise ValueError('Native segment has incomplete core sizes')
        segments.append({'id': segment_id, 'clusterId': cluster_id,
                         'burgersVector': burgers, 'points': points,
                         'coreSizes': core_sizes if any(v is not None for v in core_sizes) else None})
    if {segment['id'] for segment in segments} != set(range(segment_count)):
        raise ValueError('Native segment identifiers are not consecutive')
    if lines[index] != 'DISLOCATION_JUNCTIONS':
        raise ValueError('Native CA dislocations are not followed by junctions')
    next_nodes = {}
    for segment in segments:
        for source_end in (1, 0):
            index += 1
            target_end, target_id = numeric(lines[index], 2, integer=True)
            if target_end not in (0, 1):
                raise ValueError('Invalid native junction endpoint flag')
            next_nodes[(segment['id'], source_end)] = (target_id, target_end)
    valid_nodes = set(next_nodes)
    if any(target not in valid_nodes for target in next_nodes.values()):
        raise ValueError('Native junction references a missing segment')
    # A junction is a circular linked list. Reject chains joining another ring:
    # silently walking them would produce an incomplete or invented network.
    for segment in segments:
        rings = []
        for end in (0, 1):
            start = (segment['id'], end)
            seen, ring = {start}, []
            current = next_nodes[start]
            while current != start:
                if current in seen:
                    raise ValueError('Native junction ring does not close on its source')
                seen.add(current)
                ring.append({'segmentId': current[0], 'end': current[1]})
                current = next_nodes[current]
            rings.append(ring)
        segment['junctions'] = rings
    return {'clusters': clusters, 'transitions': transitions, 'segments': segments}


def cell_record(cell):
    matrix = json_value(cell[...])
    if len(matrix) != 3 or any(len(row) != 4 for row in matrix):
        raise ValueError('Expected an OVITO 3x4 cell matrix')
    return {'vectors': [matrix[row][column] for column in range(3) for row in range(3)],
            'vectorsRows': [[matrix[row][column] for row in range(3)] for column in range(3)],
            'origin': [row[3] for row in matrix], 'pbc': [bool(v) for v in cell.pbc]}


def property_record(container):
    return {str(name): json_value(container[name]) for name in container.keys()}


def surface_record(mesh):
    topology = mesh.topology
    vertices, faces, edges = (int(topology.vertex_count), int(topology.face_count),
                              int(topology.edge_count))
    face_vertices = json_value(mesh.get_face_vertices())
    if len(face_vertices) != faces or any(len(face) < 3 for face in face_vertices):
        raise ValueError('Surface face array does not match its topology')
    edge_fields = ('first_edge_vertex', 'second_edge_vertex', 'adjacent_face',
                   'next_face_edge', 'prev_face_edge', 'opposite_edge', 'next_manifold_edge')
    return {
        'identifier': str(mesh.identifier),
        'domain': cell_record(mesh.domain) if mesh.domain is not None else None,
        'vertices': json_value(mesh.vertices['Position']),
        'faces': face_vertices,
        'vertexProperties': property_record(mesh.vertices),
        'faceProperties': property_record(mesh.faces),
        'regionProperties': property_record(mesh.regions),
        'spaceFillingRegion': int(mesh.space_filling_region),
        'topology': {
            'vertexCount': vertices, 'faceCount': faces, 'edgeCount': edges,
            'closed': bool(topology.is_closed),
            'firstVertexEdge': [int(topology.first_vertex_edge(v)) for v in range(vertices)],
            'firstFaceEdge': [int(topology.first_face_edge(f)) for f in range(faces)],
            **{name: [int(getattr(topology, name)(edge)) for edge in range(edges)]
               for name in edge_fields},
        },
    }


def capture_native_ca(data):
    from ovito.io import export_file
    with tempfile.TemporaryDirectory(prefix='alloyview-ovito-ca-') as directory:
        path = Path(directory) / 'reference.ca'
        export_file(data, str(path), 'ca')
        return path.read_text(encoding='utf-8')


def export_science(data, ca_text):
    native = parse_ca_graph(ca_text)
    native_segments = {segment['id']: segment for segment in native['segments']}
    segments = []
    for segment in data.dislocations.segments:
        identifier = int(segment.id)
        archived = native_segments.pop(identifier)
        if int(segment.cluster_id) != archived['clusterId'] or len(segment.points) != len(archived['points']):
            raise ValueError('Native CA and Python segment views disagree')
        segments.append({
            'id': identifier, 'clusterId': int(segment.cluster_id),
            'length': float(segment.length), 'closed': bool(segment.is_loop),
            'isInfinite': bool(segment.is_infinite_line),
            'burgersVector': json_value(segment.true_burgers_vector),
            'spatialBurgersVector': json_value(segment.spatial_burgers_vector),
            'points': json_value(segment.points), 'junctions': archived['junctions'],
            'coreSizes': archived['coreSizes'],
        })
    if native_segments:
        raise ValueError('Native CA contains segments absent from the Python view')

    clusters = {cluster['id']: {**cluster, 'orientationSource': 'CA decimal text'}
                for cluster in native['clusters']}
    unavailable = ['clusters.symmetryTransformation', 'clusters.centerOfMass',
                   'clusters.parentTransition', 'transitions.distance', 'transitions.area',
                   'transitions.selfTransitions']
    for obj in data.objects:
        if type(obj).__name__ == 'ClusterGraphObject' and hasattr(obj, 'clusters'):
            for cluster in obj.clusters:
                record = clusters.setdefault(int(cluster.id), {'id': int(cluster.id),
                    'structureType': None, 'color': None})
                record.update(atomCount=int(cluster.atom_count),
                              orientationRows=json_value(cluster.orientation),
                              orientationSource='Python API binary64')
    for cluster in clusters.values():
        cluster['orientation'] = [value for row in cluster['orientationRows'] for value in row]
        if cluster['structureType'] is None:
            unavailable.append(f"clusters[{cluster['id']}].structureType")
    structure_by_cluster = {cluster['id']: cluster['structureType'] for cluster in clusters.values()}
    for segment in segments:
        segment['structureType'] = structure_by_cluster.get(segment['clusterId'])
    properties = data.particles
    ids = json_value(properties['Particle Identifier']) if 'Particle Identifier' in properties else None
    if ids is None:
        unavailable.append('particles.ids')
    atom_clusters = json_value(properties['Cluster']) if 'Cluster' in properties else None
    if atom_clusters is None:
        unavailable.append('particles.clusterIds')
    surfaces = {str(name): surface_record(mesh) for name, mesh in data.surfaces.items()}
    return {
        'result': {'segments': segments,
                   'atomStructureTypes': json_value(properties['Structure Type']),
                   'totalLength': sum(segment['length'] for segment in segments)},
        'cell': cell_record(data.cell),
        'particles': {'count': int(properties.count), 'ids': ids,
                      'positions': json_value(properties['Position'])},
        'atomClusters': atom_clusters, 'clusters': list(clusters.values()),
        'transitions': native['transitions'], 'surfaceMeshes': surfaces,
        'capabilities': {
            'allSegments': True, 'allPolylinePoints': True, 'junctionRings': True,
            'allParticleLabels': True, 'allProducedSurfaceMeshes': True,
            'junctionSource': 'CA v6 exact integer links',
            'matrixLayout': 'row-major',
            'transitionScope': 'All native exported nonself transitions; no synthesized self transitions',
            'transitionPrecision': 'Native CA decimal formatting, not full binary64',
            'unavailable': unavailable,
        },
        'nativeCrystalAnalysis': {'format': 'CA', 'version': 6,
            'source': CA_SOURCE, 'sha256': hashlib.sha256(ca_text.encode()).hexdigest(),
            'floatingPointPrecision': 'Native CA decimal formatting; use Python API arrays where available',
            'text': ca_text},
    }


def summarize(data, science):
    segments = science['result']['segments']
    attributes = {}
    for key, value in data.attributes.items():
        if str(key).startswith('DislocationAnalysis'):
            try:
                attributes[str(key)] = float(value)
            except (ValueError, TypeError):
                attributes[str(key)] = str(value)
    burgers = Counter(tuple(round(float(x), 10) for x in segment['burgersVector'])
                      for segment in segments)
    return {
        'atoms': int(data.particles.count), 'segments': len(segments),
        'totalLengthAngstrom': science['result']['totalLength'],
        'familiesAndAttributes': attributes,
        'structureHistogramById': dict(Counter(science['result']['atomStructureTypes'])),
        'burgersVectorHistogramLocalCrystal': [
            {'burgers': vector, 'segments': count} for vector, count in burgers.items()],
        # Kept for existing report consumers. Complete records are in science.
        'segmentsSample': [{'id': s['id'], 'lengthAngstrom': s['length'],
            'trueBurgers': s['burgersVector'], 'spatialBurgers': s['spatialBurgersVector'],
            'points': len(s['points'])} for s in segments[:15]],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', nargs='?', type=Path,
                        default=Path(__file__).resolve().parents[2] / 'examples/NiGB_minimized.cfg')
    parser.add_argument('--output', type=Path, help='Write a complete JSON record after each case.')
    parser.add_argument('--require-ovito-version', default='3.9.4')
    parser.add_argument('--repeat-z', nargs='+', type=int, default=[1, 2])
    parser.add_argument('--frame', type=int, default=0)
    parser.add_argument('--lattice', choices=['fcc', 'hcp', 'bcc', 'cubicDiamond', 'hexDiamond'], default='fcc')
    parser.add_argument('--circuit', type=int, default=14)
    parser.add_argument('--stretch', type=int, default=9)
    parser.add_argument('--smoothing', type=int, default=1)
    parser.add_argument('--no-line-coarsening', action='store_true')
    parser.add_argument('--point-separation', type=float, default=2.5)
    parser.add_argument('--defect-smoothing', type=int, default=8)
    parser.add_argument('--interface-mesh', action='store_true')
    parser.add_argument('--only-selected', action='store_true')
    parser.add_argument('--only-perfect-dislocations', action='store_true')
    parser.add_argument('--surface-radius', type=float,
                        help='Also produce a ConstructSurfaceModifier alpha-shape reference.')
    args = parser.parse_args()
    if (any(value < 1 for value in args.repeat_z) or args.frame < 0 or args.circuit < 3
            or min(args.stretch, args.smoothing, args.defect_smoothing) < 0
            or not math.isfinite(args.point_separation) or args.point_separation <= 0
            or (args.surface_radius is not None and
                (not math.isfinite(args.surface_radius) or args.surface_radius <= 0))):
        parser.error('Invalid replication, frame or DXA/Surface parameter')

    # Optional dependencies are deliberately imported only after argument parsing.
    import numpy as np
    import ovito
    from ovito.io import import_file
    from ovito.modifiers import DislocationAnalysisModifier, ReplicateModifier
    if ovito.version_string != args.require_ovito_version:
        parser.error(f'Expected OVITO {args.require_ovito_version}, found {ovito.version_string}')
    lattice = {'fcc': 'FCC', 'hcp': 'HCP', 'bcc': 'BCC',
               'cubicDiamond': 'CubicDiamond', 'hexDiamond': 'HexagonalDiamond'}[args.lattice]
    settings = {'input_crystal_structure': getattr(DislocationAnalysisModifier.Lattice, lattice),
        'trial_circuit_length': args.circuit, 'circuit_stretchability': args.stretch,
        'line_smoothing_level': args.smoothing, 'line_smoothing_enabled': args.smoothing > 0,
        'line_coarsening_enabled': not args.no_line_coarsening, 'line_point_separation': args.point_separation,
        'only_perfect_dislocations': args.only_perfect_dislocations, 'only_selected': args.only_selected,
        'defect_mesh_smoothing_level': args.defect_smoothing,
        'output_interface_mesh': args.interface_mesh}
    report = {'schemaVersion': SCHEMA_VERSION, 'complete': False,
        'ovitoVersion': ovito.version_string,
        'ovitoDistributionVersion': importlib.metadata.version('ovito'),
        'pysideVersion': importlib.metadata.version('PySide6'),
        'pythonVersion': platform.python_version(), 'numpyVersion': np.__version__,
        'machine': platform.machine(), 'cpus': os.cpu_count(),
        'threadEnvironment': {name: os.environ.get(name) for name in
                              ('OVITO_THREAD_COUNT', 'OMP_NUM_THREADS')},
        'file': str(args.source), 'frame': args.frame, 'units': 'angstrom', 'cases': [],
        'sourceSha256': file_hash(args.source),
        'memoryDefinition': 'Linux process RSS includes Python/Qt, inputs, native results and exported arrays. '
                            'Peak RSS is cumulative across cases, not DXA scratch alone.',
        'timingDefinition': 'Input loading is separate. dxaSeconds includes requested replication and '
                            'optional Surface computation. referenceExportSeconds includes complete array '
                            'and CA extraction; neither is a browser performance benchmark.'}
    try:
        report['cpuModel'] = next((line.split(':', 1)[1].strip()
            for line in Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')),
            platform.machine())
    except OSError:
        report['cpuModel'] = platform.machine()

    def persist():
        text = json.dumps(report, indent=2, allow_nan=False) + '\n'
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_name(args.output.name + '.tmp')
            temporary.write_text(text, encoding='utf-8')
            temporary.replace(args.output)
        return text

    for repeat in args.repeat_z:
        row = {'repeat': [1, 1, repeat], 'rssBeforeMiB': rss_mib(),
               'settings': {key: str(value) if key == 'input_crystal_structure' else value
                            for key, value in settings.items()}, 'surfaceRadius': args.surface_radius}
        phase, started = 'input', time.perf_counter()
        try:
            pipeline = import_file(str(args.source))
            raw = pipeline.compute(args.frame)
            source_cell = cell_record(raw.cell)
            row.update(sourceAtoms=int(raw.particles.count), cellVectorsRows=source_cell['vectorsRows'],
                       pbc=source_cell['pbc'], inputPreparationSeconds=time.perf_counter() - started)
            if repeat > 1:
                pipeline.modifiers.append(ReplicateModifier(
                    num_x=1, num_y=1, num_z=repeat, adjust_box=True, unique_ids=True))
            pipeline.modifiers.append(DislocationAnalysisModifier(**settings))
            if args.surface_radius is not None:
                from ovito.modifiers import ConstructSurfaceModifier
                surface = ConstructSurfaceModifier(radius=args.surface_radius)
                row['surfaceSettings'] = {name: json_value(getattr(surface, name)) for name in
                    ('radius', 'smoothing_level', 'select_surface_particles', 'identify_regions')}
                pipeline.modifiers.append(surface)
            row['rssBeforeAnalysisMiB'] = rss_mib()
            phase, started = 'analysis', time.perf_counter()
            result = pipeline.compute(args.frame)
            row['dxaSeconds'] = time.perf_counter() - started
            phase, started = 'reference-export', time.perf_counter()
            science = export_science(result, capture_native_ca(result))
            row.update(status='success', science=science, **summarize(result, science),
                       expandedCellVectorsRows=science['cell']['vectorsRows'],
                       referenceExportSeconds=time.perf_counter() - started)
        except Exception as error:
            row.update(status='error', error=str(error), errorPhase=phase,
                       failedPhaseSeconds=time.perf_counter() - started)
        row['rssAfterMiB'] = rss_mib()
        row['processPeakRssMiB'] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
        report['cases'].append(row)
        persist()
    report['complete'] = all(row['status'] == 'success' for row in report['cases'])
    print(persist(), end='')
    return 0 if report['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
