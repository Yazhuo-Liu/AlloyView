// AlloyView's headless entry point for OVITO 3.9.4 DXA (MIT option).
// Algorithm sources and their original notices are in third_party/dxa.
#include <ovito/crystalanalysis/modifier/dxa/StructureAnalysis.h>
#include <ovito/crystalanalysis/modifier/dxa/ElasticMapping.h>
#include <ovito/crystalanalysis/modifier/dxa/InterfaceMesh.h>
#include <ovito/crystalanalysis/modifier/dxa/DislocationTracer.h>
#include <geometry/DelaunayTessellation.h>
#include <cstdint>
#include <cstring>
#include <unordered_map>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(void, alloy_dxa_progress, (const char* phase, int completed, int total), {
  if (typeof Module.onDxaProgress === 'function') {
    Module.onDxaProgress(UTF8ToString(phase), completed, total);
  }
});
#else
static void alloy_dxa_progress(const char*, int, int) {}
#endif

using namespace Ovito;
using namespace Ovito::CrystalAnalysis;
using namespace Ovito::Delaunay;
namespace {
std::string resultJson;
std::string lastError;
// Callers that read per-atom labels from memory switch this on; the JSON then
// omits one number per atom. Headless callers keep the complete JSON.
bool binaryStructureLabels = false;
std::vector<uint8_t> resultStructureLabels;

void vectorJson(std::ostream& out, const Vector3& v) {
    out << '[' << v.x() << ',' << v.y() << ',' << v.z() << ']';
}
void pointJson(std::ostream& out, const Point3& p) {
    out << '[' << p.x() << ',' << p.y() << ',' << p.z() << ']';
}
void requireStage(bool success) {
    if (!success || Task::current()->isCanceled()) throw std::runtime_error("DXA analysis was canceled.");
}
}


namespace {
constexpr uint32_t reversedEdge = uint32_t(1) << 31;
constexpr uint32_t noTransition = std::numeric_limits<uint32_t>::max();
constexpr int edgeVertices[6][2] = {{0,1},{0,2},{0,3},{1,2},{1,3},{2,3}};

// Pack each tetrahedron's vertices, neighbors and oriented edge indices from
// the vertex-pair index. The loop runs in its own frame: inlined into the
// export, which owns destructible temporaries, the build without threads would
// route every tessellation call through its JS exception trampolines.
__attribute__((noinline)) bool packTetrahedra(const DelaunayTessellation& tessellation, uint32_t* tetData,
        size_t tets, size_t vertices, uint32_t atomCount, const uint32_t* starts, const uint64_t* pairs) {
    const auto orientedEdge = [&](uint32_t from, uint32_t to) -> uint32_t {
        for (size_t entry = starts[from], end = starts[from + 1]; entry < end; ++entry)
            if (uint32_t(pairs[entry] >> 32) == to) return uint32_t(pairs[entry]);
        return 0;
    };
    // Each worker writes only its own fixed tetrahedron row; exceptions and
    // cancellation join every worker before CPU stage snapshot cleanup/fallback.
    return parallelForWithProgress(tets, [&](size_t tet) {
        uint32_t* row = tetData + tet * 16;
        const bool finite = tessellation.isFiniteCell(tet);
        row[14] = finite ? 1 : 0;
        for (int vertex = 0; vertex < 4; ++vertex) {
            row[vertex] = finite ? tessellation.cellVertex(tet, vertex) : 0;
            row[4 + vertex] = tessellation.cellAdjacent(tet, vertex);
            if (row[4 + vertex] >= tets || (finite && row[vertex] >= vertices))
                throw std::runtime_error("DXA CPU stage snapshot contains an invalid tessellation index.");
        }
        if (!finite) return;
        uint32_t atoms[4];
        for (int vertex = 0; vertex < 4; ++vertex) {
            atoms[vertex] = static_cast<uint32_t>(tessellation.vertexIndex(row[vertex]));
            if (atoms[vertex] >= atomCount)
                throw std::runtime_error("DXA CPU stage snapshot contains an invalid tessellation index.");
        }
        for (int edge = 0; edge < 6; ++edge)
            row[8 + edge] = orientedEdge(atoms[edgeVertices[edge][0]], atoms[edgeVertices[edge][1]]);
    });
}

// One whole-frame CPU pipeline retained in the reusable Wasm heap between
// topology preparation and interface construction/tracing. Pthreads share it.
struct DxaSession {
    SimulationCellObject cell;
    PropertyPtr positions, structures;
    std::unique_ptr<StructureAnalysis> structure;
    DelaunayTessellation tessellation;
    std::unique_ptr<ElasticMapping> mapping;
    std::unique_ptr<InterfaceMesh> interfaceMesh;
    std::unique_ptr<DislocationTracer> tracer;
    ProgressingTask operation;
    int count, lattice, smoothing;
    double coarsening;
    bool mappingReady = false;
    bool workerSnapshotReady = false;
    bool meshConstructed = false;
    std::vector<double> vertexData, transitionData;
    std::vector<uint32_t> tetData, edgeData;
    std::vector<int32_t> workerRegions;
    std::vector<int32_t> diagnosticRegions;

    DxaSession(const AffineTransformation& matrix, int pbcBits, int atomCount,
            int latticeType, int trial, int stretch, int perfectOnly,
            int smooth, double interval) :
        cell(matrix, bool(pbcBits & 1), bool(pbcBits & 2), bool(pbcBits & 4)),
        positions(std::make_shared<PropertyStorage>(atomCount, sizeof(Point3))),
        structures(std::make_shared<PropertyStorage>(atomCount, sizeof(int32_t))),
        count(atomCount), lattice(latticeType), smoothing(smooth), coarsening(interval) {
        std::vector<Matrix3> preferredCrystalOrientations;
        if (lattice == StructureAnalysis::LATTICE_FCC ||
                lattice == StructureAnalysis::LATTICE_BCC ||
                lattice == StructureAnalysis::LATTICE_CUBIC_DIAMOND)
            preferredCrystalOrientations.push_back(Matrix3::Identity());
        structure = std::make_unique<StructureAnalysis>(positions, &cell,
            static_cast<StructureAnalysis::LatticeStructureType>(lattice), nullptr,
            structures, std::move(preferredCrystalOrientations), !perfectOnly);
        mapping = std::make_unique<ElasticMapping>(*structure, tessellation);
        interfaceMesh = std::make_unique<InterfaceMesh>(*mapping);
        tracer = std::make_unique<DislocationTracer>(*interfaceMesh, structure->clusterGraph(), trial, stretch);
    }
    size_t transitionCount() const {
        // All self-transitions have the same exact identity operation and share
        // slot zero. The graph lists one transition of each pair; edges can use
        // either direction, so each transition and its reverse get a slot.
        return 2 * structure->clusterGraph()->clusterTransitions().size() + 1;
    }
    size_t edgeCount() const { return mapping->workerEdgeCount() + 1; }
    uint64_t snapshotBytes() const {
        return uint64_t(tessellation.workerVertexCount()) * 24 +
            uint64_t(tessellation.numberOfTetrahedra()) * 64 +
            uint64_t(edgeCount()) * 32 + uint64_t(transitionCount()) * 160;
    }
    void clearSnapshot() {
        std::vector<double>().swap(vertexData);
        std::vector<double>().swap(transitionData);
        std::vector<uint32_t>().swap(tetData);
        std::vector<uint32_t>().swap(edgeData);
        workerSnapshotReady = false;
    }

    void exportSnapshot(uint32_t budgetBytes) {
        if (workerSnapshotReady) return;
        requireStage(true);
        if (!mappingReady) throw std::runtime_error("DXA crystal mapping has not been constructed.");
        const size_t vertices = tessellation.workerVertexCount();
        const size_t tets = tessellation.numberOfTetrahedra();
        const size_t edges = edgeCount(), transitions = transitionCount();
        // Includes the temporary vertex-pair index and transition map used
        // during packing. Reject before allocating any snapshot arrays; callers
        // can finish on CPU.
        const uint64_t workingBytes = snapshotBytes() + uint64_t(count + 1) * 4 + uint64_t(edges) * 24 +
            uint64_t(transitions) * 32;
        if (vertices > std::numeric_limits<int32_t>::max() ||
                tets > std::numeric_limits<int32_t>::max() || edges >= reversedEdge ||
                transitions >= noTransition || workingBytes > budgetBytes)
            throw std::runtime_error("DXA immutable CPU Worker workspace exceeds the export memory budget.");
        vertexData.resize(vertices * 3);
        tetData.resize(tets * 16);
        edgeData.resize(edges * 8);
        transitionData.resize(transitions * 20);
        // Pack independent rows with the already configured, reusable pthread
        // pool. No scientific topology or reference-frame indices are changed.
        requireStage(parallelForWithProgress(vertices, [&](size_t vertex) {
            const Point3& point = tessellation.vertexPosition(vertex);
            for (int axis = 0; axis < 3; ++axis) vertexData[vertex * 3 + axis] = point[axis];
        }));
        // Slot zero is the self-transition. Each graph transition is followed
        // by its reverse, whose row holds the same two matrices swapped.
        for (int axis = 0; axis < 3; ++axis) {
            transitionData[axis * 4] = 1;
            transitionData[9 + axis * 4] = 1;
        }
        transitionData[18] = 1;
        std::unordered_map<const ClusterTransition*, uint32_t> transitionIndices;
        transitionIndices.reserve(transitions);
        uint32_t transitionIndex = 1;
        for (const ClusterTransition* forward : structure->clusterGraph()->clusterTransitions()) {
            for (const ClusterTransition* transition : {forward, static_cast<const ClusterTransition*>(forward->reverse)}) {
                transitionIndices.emplace(transition, transitionIndex);
                double* row = transitionData.data() + size_t(transitionIndex) * 20;
                for (int component = 0; component < 9; ++component) {
                    row[component] = transition->tm.elements()[component];
                    row[9 + component] = transition->reverse->tm.elements()[component];
                }
                row[18] = transition->isSelfTransition() ? 1 : 0;
                ++transitionIndex;
            }
        }
        // Edge zero represents every missing/unmapped pair. Existing edge
        // vectors stay in their original reference frame and orientation.
        edgeData[6] = noTransition;
        std::vector<uint32_t> edgeVertices1(edges), edgeVertices2(edges), adjacencyStart(size_t(count) + 2);
        uint32_t edgeIndex = 1;
        mapping->visitWorkerEdges([&](const auto& edge) {
            if ((edgeIndex & 1023) == 0) requireStage(true);
            if (edge.vertex1 >= size_t(count) || edge.vertex2 >= size_t(count))
                throw std::runtime_error("DXA snapshot contains an invalid tessellation edge.");
            edgeVertices1[edgeIndex] = static_cast<uint32_t>(edge.vertex1);
            edgeVertices2[edgeIndex] = static_cast<uint32_t>(edge.vertex2);
            ++adjacencyStart[edge.vertex1 + 2];
            ++adjacencyStart[edge.vertex2 + 2];
            uint32_t* row = edgeData.data() + size_t(edgeIndex) * 8;
            row[6] = noTransition;
            if (edge.hasClusterVector()) {
                static_assert(sizeof(Vector3) == 3 * sizeof(double), "DXA vector snapshot requires packed doubles.");
                std::memcpy(row, edge.clusterVector.data(), 3 * sizeof(double));
                if (edge.clusterTransition->isSelfTransition()) row[6] = 0;
                else {
                    const auto found = transitionIndices.find(edge.clusterTransition);
                    if (found == transitionIndices.end())
                        throw std::runtime_error("DXA snapshot could not resolve a crystal transition.");
                    row[6] = found->second;
                }
            }
            ++edgeIndex;
        });
        if (edgeIndex != edges)
            throw std::runtime_error("DXA immutable edge count is inconsistent.");
        // A pair of vertices has at most one edge. List it under both of its
        // vertices with the other vertex and its index, flagged from the end
        // vertex, which traverses it against its stored direction.
        for (size_t vertex = 2; vertex < adjacencyStart.size(); ++vertex) adjacencyStart[vertex] += adjacencyStart[vertex - 1];
        std::vector<uint64_t> adjacency(2 * size_t(edges - 1));
        for (uint32_t edge = 1; edge < edges; ++edge) {
            const uint32_t first = edgeVertices1[edge], second = edgeVertices2[edge];
            adjacency[adjacencyStart[first + 1]++] = (uint64_t(second) << 32) | edge;
            adjacency[adjacencyStart[second + 1]++] = (uint64_t(first) << 32) | edge | reversedEdge;
        }
        std::vector<uint32_t>().swap(edgeVertices1);
        std::vector<uint32_t>().swap(edgeVertices2);
        // The index is complete and immutable before any worker reads it.
        requireStage(packTetrahedra(tessellation, tetData.data(), tets, vertices, uint32_t(count),
            adjacencyStart.data(), adjacency.data()));
        workerSnapshotReady = true;
    }

};
std::unique_ptr<DxaSession> activeSession;


void buildCpuMapping(DxaSession& session) {
    auto& structure = *session.structure;
    auto& mapping = *session.mapping;
    alloy_dxa_progress("Build crystal clusters", 1, 11);
    requireStage(structure.buildClusters());
    alloy_dxa_progress("Connect crystal reference frames", 2, 11);
    requireStage(structure.connectClusters());
    alloy_dxa_progress("Periodic Delaunay tessellation", 3, 11);
    requireStage(session.tessellation.generateTessellation(structure.cell(),
        BufferReadAccess<Point3>(session.positions).cbegin(), session.count,
        3.5 * structure.maximumNeighborDistance(), false, nullptr, session.operation));
    alloy_dxa_progress("Build tessellation edges", 4, 11);
    requireStage(mapping.generateTessellationEdges(session.operation));
    alloy_dxa_progress("Assign crystal clusters", 5, 11);
    requireStage(mapping.assignVerticesToClusters(session.operation));
    alloy_dxa_progress("Map edges to the ideal lattice", 6, 11);
    requireStage(mapping.assignIdealVectorsToEdges(4, session.operation));
    structure.freeNeighborLists();
    session.mappingReady = true;
}

void saveCurrentError(bool dispose) {
    try { throw; }
    catch (const std::bad_alloc&) {
        lastError = "Insufficient memory for periodic DXA tessellation. Reduce the analyzed structure.";
    } catch (const std::exception& error) {
        lastError = error.what();
    } catch (...) {
        lastError = "DXA failed while building the crystal topology.";
    }
    if (dispose) activeSession.reset();
}
}

extern "C" {
const char* alloy_dxa_last_error() { return lastError.c_str(); }
void alloy_dxa_set_threads(int count) { configureDxaThreads(count); }
int alloy_dxa_thread_count() { return dxaThreadCount(); }
int32_t* alloy_dxa_cancel_ptr() {
    static_assert(sizeof(std::atomic<int32_t>) == sizeof(int32_t), "DXA cancel flag requires a 32-bit atomic word.");
    return reinterpret_cast<int32_t*>(&dxaCancellationWord());
}
void alloy_dxa_reset_cancel() {
    dxaCancellationWord().store(0, std::memory_order_relaxed);
    Task::current()->resetCancellation();
}
void alloy_dxa_dispose() {
    activeSession.reset();
    std::string().swap(resultJson);
    std::vector<uint8_t>().swap(resultStructureLabels);
}
void alloy_dxa_binary_labels(int enabled) { binaryStructureLabels = enabled != 0; }
const uint8_t* alloy_dxa_result_labels_ptr() { return resultStructureLabels.data(); }
int alloy_dxa_result_labels_count() { return static_cast<int>(resultStructureLabels.size()); }

// Vectors are column vectors; cell[9..11] is the Cartesian origin. Periodicity
// is encoded in bits 0, 1 and 2, including for a tilted simulation cell.
int alloy_dxa_prepare(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    activeSession.reset();
    lastError.clear();
    std::string().swap(resultJson);
    std::vector<uint8_t>().swap(resultStructureLabels);
    try {
        requireStage(true);
        if (!coordinates || !cellData || count < 1)
            throw std::runtime_error("DXA requires a non-empty three-dimensional structure.");
        if (lattice < 1 || lattice > 5)
            throw std::runtime_error("Select an FCC, HCP, BCC, or diamond input lattice.");
        if (trial < 3 || trial > 100 || stretch < 0 || stretch > 100 ||
                smoothing < 0 || smoothing > 100 || !std::isfinite(coarsening) || coarsening < 0)
            throw std::runtime_error("Invalid DXA circuit or line-processing settings.");
        for (int k = 0; k < 12; ++k)
            if (!std::isfinite(cellData[k])) throw std::runtime_error("DXA cell contains non-finite coordinates.");
        AffineTransformation matrix;
        for (int k = 0; k < 4; ++k)
            matrix.column(k) = Vector3(cellData[k * 3], cellData[k * 3 + 1], cellData[k * 3 + 2]);
        if (std::abs(matrix.determinant()) <= std::numeric_limits<double>::epsilon())
            throw std::runtime_error("DXA requires a non-singular three-dimensional cell.");
        activeSession = std::make_unique<DxaSession>(matrix, pbcBits, count, lattice,
            trial, stretch, perfectOnly, smoothing, coarsening);
        auto& session = *activeSession;
        if (session.cell.isDegenerate()) throw std::runtime_error("Simulation cell is degenerate.");
        {
            BufferWriteAccess<Point3> positionAccess(session.positions);
            for (int i = 0; i < count; ++i) {
                if ((i & 1023) == 0) requireStage(true);
                const double* p = coordinates + static_cast<size_t>(i) * 3;
                if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || !std::isfinite(p[2]))
                    throw std::runtime_error("DXA atom coordinates must be finite.");
                positionAccess[i] = Point3(p[0], p[1], p[2]);
            }
        }
        return 1;
    } catch (...) { saveCurrentError(true); }
    return 0;
}

int alloy_dxa_begin(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    if(!alloy_dxa_prepare(coordinates, count, cellData, pbcBits, lattice, trial,
            stretch, perfectOnly, smoothing, coarsening)) return 0;
    try {
        alloy_dxa_progress("Identify local crystal structures", 0, 11);
        requireStage(activeSession->structure->identifyStructures());
        buildCpuMapping(*activeSession);
        return 1;
    } catch (...) { saveCurrentError(true); }
    return 0;
}

int alloy_dxa_import_local(const int32_t* types, const int32_t* neighbors,
        int count, int width, double maximumDistance) {
    lastError.clear();
    try {
        requireStage(true);
        if(!activeSession || activeSession->mappingReady || count < 1 || width < 1)
            throw std::runtime_error("CPU DXA has no prepared local-analysis workspace.");
        requireStage(activeSession->structure->importLocalStructures(types, neighbors,
            count, width, maximumDistance));
        buildCpuMapping(*activeSession);
        return 1;
    } catch (...) { saveCurrentError(true); }
    return 0;
}

int alloy_dxa_worker_snapshot(uint32_t budgetBytes) {
    lastError.clear();
    try {
        if(!activeSession) throw std::runtime_error("CPU DXA has no prepared topology.");
        activeSession->exportSnapshot(budgetBytes);
        return 1;
    } catch (...) {
        saveCurrentError(false);
        if(activeSession) activeSession->clearSnapshot();
    }
    return 0;
}
void alloy_dxa_release_worker_snapshot() { if(activeSession) activeSession->clearSnapshot(); }
int alloy_dxa_worker_vertex_count() { return activeSession ? activeSession->tessellation.workerVertexCount() : 0; }
int alloy_dxa_worker_tet_count() { return activeSession ? activeSession->tessellation.numberOfTetrahedra() : 0; }
int alloy_dxa_worker_edge_count() { return activeSession ? activeSession->edgeCount() : 0; }
int alloy_dxa_worker_transition_count() { return activeSession ? activeSession->transitionCount() : 0; }
double alloy_dxa_worker_snapshot_bytes() { return activeSession ? activeSession->snapshotBytes() : 0; }
double alloy_dxa_worker_alpha() { return activeSession ? 5.0 * activeSession->structure->maximumNeighborDistance() : 0; }
const double* alloy_dxa_worker_vertex_ptr() { return activeSession && activeSession->workerSnapshotReady ? activeSession->vertexData.data() : nullptr; }
const uint32_t* alloy_dxa_worker_tet_ptr() { return activeSession && activeSession->workerSnapshotReady ? activeSession->tetData.data() : nullptr; }
const uint32_t* alloy_dxa_worker_edge_ptr() { return activeSession && activeSession->workerSnapshotReady ? activeSession->edgeData.data() : nullptr; }
const double* alloy_dxa_worker_transition_ptr() { return activeSession && activeSession->workerSnapshotReady ? activeSession->transitionData.data() : nullptr; }
int alloy_dxa_import_regions(const int32_t* regions, int count) {
    lastError.clear();
    try {
        requireStage(true);
        if(!activeSession || !activeSession->mappingReady || !regions || count < 1 ||
                size_t(count) != activeSession->tessellation.numberOfTetrahedra())
            throw std::runtime_error("CPU DXA classification has invalid dimensions.");
        for(int index = 0; index < count; ++index) {
            if((index & 1023) == 0) requireStage(true);
            if(regions[index] != -1 && regions[index] != 0)
                throw std::runtime_error("CPU DXA classification contains invalid region labels.");
        }
        activeSession->workerRegions.assign(regions, regions + count);
        return 1;
    } catch (...) { saveCurrentError(false); }
    return 0;
}

// Read back the actual manifold classifier's labels for scientific parity
// diagnostics. This is allocated on demand and is unused by normal extraction.
const int32_t* alloy_dxa_worker_regions_ptr() {
    lastError.clear();
    try {
        if(!activeSession || !activeSession->meshConstructed)
            throw std::runtime_error("CPU DXA interface classification has not finished.");
        auto& session = *activeSession;
        session.diagnosticRegions.resize(session.tessellation.numberOfTetrahedra());
        for(size_t cell = 0; cell < session.diagnosticRegions.size(); ++cell)
            session.diagnosticRegions[cell] = session.tessellation.getUserField(cell);
        return session.diagnosticRegions.data();
    } catch (...) { saveCurrentError(false); }
    return nullptr;
}

// Continue the retained CPU topology through classification and tracing.
const char* alloy_dxa_finish() {
    lastError.clear();
    std::string().swap(resultJson);
    std::vector<uint8_t>().swap(resultStructureLabels);
    try {
        requireStage(true);
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        auto& session = *activeSession;
        if (!session.mappingReady) throw std::runtime_error("DXA crystal mapping has not been constructed.");
        auto& cell = session.cell;
        auto& structure = *session.structure;
        auto& interfaceMesh = *session.interfaceMesh;
        auto& tracer = *session.tracer;
        auto& operation = session.operation;
        const int count = session.count, lattice = session.lattice, smoothing = session.smoothing;
        const double coarsening = session.coarsening;
        const auto& structures = session.structures;
        alloy_dxa_progress("Construct crystal interface mesh", 7, 11);
        if(!session.workerRegions.empty())
            session.tessellation.setWorkerRegions(session.workerRegions.data(), session.workerRegions.size());
        requireStage(interfaceMesh.createMesh(structure.maximumNeighborDistance(), {}, operation));
        session.meshConstructed = true;
        alloy_dxa_progress("Trace Burgers circuits and dislocation lines", 8, 11);
        requireStage(tracer.traceDislocationSegments(operation));
        alloy_dxa_progress("Connect dislocation junctions", 9, 11);
        tracer.finishDislocationSegments(lattice);
        requireStage(true);
        alloy_dxa_progress("Smooth and coarsen dislocation lines", 10, 11);
        if (smoothing > 0 || coarsening > 0)
            requireStage(tracer.network()->smoothDislocationLines(smoothing, coarsening, operation));
        alloy_dxa_progress("Serialize dislocation network", 10, 11);
        std::ostringstream out;
        out << std::setprecision(17);
        double totalLength = 0;
        out << "{\"backend\":\"cpu-wasm\",\"algorithm\":\"OVITO DXA 3.9.4\",\"lattice\":" << lattice
            << ",\"volume\":" << cell.volume3D() << ",\"segments\":[";
        bool firstSegment = true;
        for (const DislocationSegment* segment : tracer.network()->segments()) {
            requireStage(true);
            if (segment->isDegenerate()) continue;
            if (!firstSegment) out << ',';
            firstSegment = false;
            const Cluster* cluster = segment->burgersVector.cluster();
            const double length = segment->calculateLength();
            totalLength += length;
            out << "{\"id\":" << segment->id << ",\"clusterId\":" << cluster->id
                << ",\"structureType\":" << cluster->structure << ",\"length\":" << length
                << ",\"closed\":" << (segment->isClosedLoop() ? "true" : "false")
                << ",\"isInfinite\":" << (segment->isInfiniteLine() ? "true" : "false")
                << ",\"burgersVector\":";
            vectorJson(out, segment->burgersVector.localVec());
            out << ",\"spatialBurgersVector\":";
            vectorJson(out, segment->burgersVector.toSpatialVector());
            out << ",\"points\":[";
            bool firstPoint = true;
            for (const Point3& p : segment->line) {
                if (!firstPoint) out << ',';
                firstPoint = false;
                pointJson(out, p);
            }
            out << "],\"junctions\":[";
            // JSON end 0 means line.front() (backward node), end 1 line.back().
            for (int end = 0; end < 2; ++end) {
                if (end) out << ',';
                out << '[';
                const DislocationNode* node = segment->nodes[1 - end];
                bool firstArm = true;
                for (const DislocationNode* arm = node->junctionRing; arm != node; arm = arm->junctionRing) {
                    if (!firstArm) out << ',';
                    firstArm = false;
                    out << "{\"segmentId\":" << arm->segment->id
                        << ",\"end\":" << (arm->isForwardNode() ? 1 : 0) << '}';
                }
                out << ']';
            }
            out << "]}";
        }
        out << "],\"totalLength\":" << totalLength;
        const auto& mapping = *session.mapping;
        out << ",\"parallelEdgePasses\":{\"candidateCells\":" << mapping.parallelCandidateCells()
            << ",\"pathSearchEdges\":" << mapping.parallelPathEdges()
            << ",\"pathSearchBatches\":" << mapping.parallelPathBatches()
            << ",\"deferredPathEdges\":" << mapping.deferredPathEdges()
            << ",\"directPathEdges\":" << mapping.directPathEdges() << '}';
        BufferReadAccess<int32_t> structureAccess(structures);
        if (binaryStructureLabels) {
            resultStructureLabels.resize(static_cast<size_t>(count));
            for (int i = 0; i < count; ++i) {
                if ((i & 1023) == 0) requireStage(true);
                const int32_t type = structureAccess[i];
                if (type < 0 || type > 255) throw std::runtime_error("DXA produced an out-of-range structure label.");
                resultStructureLabels[i] = static_cast<uint8_t>(type);
            }
            out << ",\"atomStructureTypesBinary\":true}";
        } else {
            out << ",\"atomStructureTypes\":[";
            for (int i = 0; i < count; ++i) {
                if ((i & 1023) == 0) requireStage(true);
                if (i) out << ',';
                out << structureAccess[i];
            }
            out << "]}";
        }
        resultJson = out.str();
        alloy_dxa_progress("DXA complete", 11, 11);
        return resultJson.c_str();

    } catch (...) { saveCurrentError(true); }
    return nullptr;
}

// Complete CPU entry point for headless callers.
const char* alloy_dxa_analyze(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    if (!alloy_dxa_begin(coordinates, count, cellData, pbcBits, lattice, trial,
            stretch, perfectOnly, smoothing, coarsening)) return nullptr;
    const char* result = alloy_dxa_finish();
    // The returned JSON belongs to this module and remains valid until the
    // caller disposes it or starts the next calculation. Release the native
    // graph here, but keep that output storage alive for the caller to read.
    activeSession.reset();
    return result;
}
}

#ifdef DXA_NATIVE_MAIN
#include <fstream>
int main(int argc, char** argv) {
    if (argc != 2) { std::cerr << "Usage: dxa-native input.txt\n"; return 2; }
    std::ifstream input(argv[1]);
    int count, pbc, lattice;
    double cell[12];
    input >> count >> pbc >> lattice;
    for (double& value : cell) input >> value;
    std::vector<double> positions(static_cast<size_t>(count) * 3);
    for (double& value : positions) input >> value;
    if (!input) { std::cerr << "Invalid DXA native fixture.\n"; return 2; }
    auto json = alloy_dxa_analyze(positions.data(), count, cell, pbc, lattice, 14, 9, 0, 1, 2.5);
    if (!json) { std::cerr << alloy_dxa_last_error() << '\n'; return 1; }
    std::cout << json << '\n';
}
#endif
