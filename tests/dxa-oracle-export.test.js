import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../scripts/research/ovito-dxa-oracle.py', import.meta.url));

test('complete DXA oracle help has no optional Python dependencies', () => {
  const help = execFileSync('python3', ['-B', '-S', script, '--help'], { cwd: root, encoding: 'utf8' });
  assert.match(help, /--require-ovito-version/);
  assert.match(help, /--interface-mesh/);
  assert.match(help, /--surface-radius/);
});

test('complete DXA oracle preserves all segments, native junction rings, cluster matrices and mesh topology', () => {
  const code = String.raw`
import importlib.util, json
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('oracle', 'scripts/research/ovito-dxa-oracle.py')
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

def ca_text():
    lines = ['CA_FILE_VERSION 6', 'CLUSTERS 2']
    for cluster_id in (1, 2):
        lines += ['CLUSTER '+str(cluster_id), 'CLUSTER_STRUCTURE 1', 'CLUSTER_ORIENTATION',
                  '1.0 0.0 0.0', '0.0 1.0 0.0', '0.0 0.0 1.0',
                  'CLUSTER_COLOR 1.0 1.0 1.0', 'CLUSTER_SIZE 2', 'END_CLUSTER']
    lines += ['CLUSTER_TRANSITIONS 1', 'TRANSITION 0 1', '1 0 0 0 1 0 0 0 1', 'DISLOCATIONS 16']
    for segment_id in range(16):
        lines += [str(segment_id), '0.5 0.5 0', '1', '2',
                  f'{segment_id} 0 0 3', f'{segment_id} 0 1 4']
    lines += ['DISLOCATION_JUNCTIONS']
    for segment_id in range(16):
        # CA forward node first = end1. The first four forward nodes form a ring.
        forward = (1, (segment_id + 1) % 4) if segment_id < 4 else (1, segment_id)
        backward = (0, segment_id)
        if segment_id == 4:
            forward, backward = (0, 4), (1, 4)
        lines += ['%d %d' % forward, '%d %d' % backward]
    return '\n'.join(lines)+'\n'

class Cell:
    pbc = [False, False, True]
    def __getitem__(self, key):
        return [[10.0, 1.0, 0.0, -1.0], [0.0, 11.0, 0.0, 2.0], [0.0, 0.0, 12.0, 3.0]]

class Properties(dict):
    count = 4

class ClusterGraphObject:
    clusters = [SimpleNamespace(id=1, atom_count=2,
        orientation=[[1.2345678901234567,0,0],[0,1,0],[0,0,1]]),
        SimpleNamespace(id=2, atom_count=2, orientation=[[1,0,0],[0,1,0],[0,0,1]])]

class Topology:
    vertex_count, face_count, edge_count, is_closed = 3, 1, 3, False
    def first_vertex_edge(self, i): return i
    def first_face_edge(self, i): return 0
    def first_edge_vertex(self, i): return i
    def second_edge_vertex(self, i): return (i+1)%3
    def adjacent_face(self, i): return 0
    def next_face_edge(self, i): return (i+1)%3
    def prev_face_edge(self, i): return (i+2)%3
    def opposite_edge(self, i): return -1
    def next_manifold_edge(self, i): return -1

class Mesh:
    identifier, domain, topology, space_filling_region = 'dxa-defect-mesh', Cell(), Topology(), -1
    vertices = {'Position': [[0,0,0],[1,0,0],[0,1,0]]}
    faces, regions = {'Region': [0]}, {'Volume': [0]}
    def get_face_vertices(self): return [[0,1,2]]

segments = [SimpleNamespace(id=i, cluster_id=1, length=1.0, is_loop=i==4,
    is_infinite_line=i==4, true_burgers_vector=[.5,.5,0], spatial_burgers_vector=[.5,.5,0],
    points=[[i,0,0],[i,0,1]]) for i in range(16)]
particles = Properties({'Position': [[0,0,0],[1,0,0],[0,1,0],[1,1,0]],
    'Particle Identifier': [10,20,30,40], 'Structure Type': [1,1,1,1], 'Cluster': [1,1,2,2]})
data = SimpleNamespace(dislocations=SimpleNamespace(segments=segments), particles=particles,
    cell=Cell(), objects=[ClusterGraphObject()], surfaces={'dxa-defect-mesh': Mesh()},
    attributes={'DislocationAnalysis.total_line_length': 16.0})
science = oracle.export_science(data, ca_text())
assert len(science['result']['segments']) == 16
assert science['result']['segments'][-1]['points'] == [[15,0,0],[15,0,1]]
assert science['result']['segments'][0]['junctions'] == [[],[
    {'segmentId':1,'end':1},{'segmentId':2,'end':1},{'segmentId':3,'end':1}]]
assert science['result']['segments'][4]['junctions'] == [[{'segmentId':4,'end':1}],[{'segmentId':4,'end':0}]]
assert science['result']['segments'][0]['coreSizes'] == [3,4]
assert science['clusters'][0]['orientation'][0] == 1.2345678901234567
assert science['clusters'][0]['orientationSource'] == 'Python API binary64'
assert science['transitions'][0]['source'] == 1 and science['transitions'][0]['target'] == 2
assert science['atomClusters'] == [1,1,2,2]
assert science['cell']['vectors'] == [10,0,0,1,11,0,0,0,12]
assert science['cell']['origin'] == [-1,2,3]
mesh = science['surfaceMeshes']['dxa-defect-mesh']
assert mesh['faces'] == [[0,1,2]] and mesh['vertices'] == [[0,0,0],[1,0,0],[0,1,0]]
assert mesh['topology']['opposite_edge'] == [-1,-1,-1]
assert mesh['topology']['next_face_edge'] == [1,2,0]
assert len(oracle.summarize(data, science)['segmentsSample']) == 15
assert 'clusters.parentTransition' in science['capabilities']['unavailable']
assert science['nativeCrystalAnalysis']['text'] == ca_text()
assert len(science['nativeCrystalAnalysis']['sha256']) == 64
for text in [ca_text().replace('CA_FILE_VERSION 6','CA_FILE_VERSION 7'),
             ca_text().replace('DISLOCATION_JUNCTIONS\n1 1','DISLOCATION_JUNCTIONS\n2 1'),
             ca_text().replace('DISLOCATION_JUNCTIONS\n1 1','DISLOCATION_JUNCTIONS\n1 99'),
             ca_text().replace('DISLOCATION_JUNCTIONS\n1 1','DISLOCATION_JUNCTIONS\n1 5')]:
    try:
        oracle.parse_ca_graph(text)
    except ValueError:
        pass
    else:
        raise AssertionError('Malformed native junction/version record was accepted')
try:
    oracle.json_value(float('nan'))
except ValueError:
    pass
else:
    raise AssertionError('Non-finite scientific value was accepted')
print(json.dumps({'segments':len(science['result']['segments']), 'junctionArms':3}))
`;
  const result = JSON.parse(execFileSync('python3', ['-B', '-S', '-c', code], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(result, { segments: 16, junctionArms: 3 });
});
