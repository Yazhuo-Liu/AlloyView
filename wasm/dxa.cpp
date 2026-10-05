// AlloyView's headless entry point for OVITO 3.9.4 DXA (MIT option).
// Algorithm sources and their original notices are in third_party/dxa.
#include <ovito/crystalanalysis/modifier/dxa/StructureAnalysis.h>
#include <ovito/crystalanalysis/modifier/dxa/ElasticMapping.h>
#include <ovito/crystalanalysis/modifier/dxa/InterfaceMesh.h>
#include <ovito/crystalanalysis/modifier/dxa/DislocationTracer.h>
#include <geometry/DelaunayTessellation.h>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <cstring>
#include <unordered_map>
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

// One whole-frame scientific pipeline. It lives in the existing reusable Wasm
// heap while JavaScript dispatches the immutable GPU classification stage.
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
    std::vector<double> vertexData, transitionData;
    std::vector<Point3> localInputPositions;
    std::array<double, 9> localInverse;
    std::vector<uint32_t> tetData, edgeData;
    std::vector<int32_t> cpuRegions;
    bool exported = false;
    bool cpuRegionsComplete = false;
    bool localIdentified = false;
    bool mappingReady = false;

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
        for (int component = 0; component < 9; ++component)
            localInverse[component] = cell.inverseMatrix()(component % 3, component / 3);
    }

    const double* exportLocalPositions() {
        if (localInputPositions.empty()) {
            localInputPositions.resize(count);
            BufferReadAccess<Point3> source(positions);
            // Mirror NearestNeighborFinder::prepare, including its Cartesian
            // subtraction order and the occasional second boundary wrap.
            for (int atom = 0; atom < count; ++atom) {
                if ((atom & 1023) == 0) requireStage(true);
                Point3 point = source[atom];
                Point3 reduced = cell.reciprocalCellMatrix() * point;
                for (int axis = 0; axis < 3; ++axis) {
                    if (cell.hasPbc(axis)) {
                        if (const double shift = std::floor(reduced[axis])) {
                            reduced[axis] -= shift;
                            point -= shift * cell.matrix().column(axis);
                        }
                    }
                }
                localInputPositions[atom] = point;
            }
        }
        static_assert(sizeof(Point3) == 3 * sizeof(double), "DXA local positions require packed doubles.");
        return localInputPositions.front().data();
    }
    void releaseLocalInput() { std::vector<Point3>().swap(localInputPositions); }

    size_t transitionCount() const {
        // All self-transitions have the same exact identity operation and share
        // slot zero. Other directed transitions retain their own exact matrix.
        return structure->clusterGraph()->clusterTransitions().size() + 1;
    }
    size_t edgeCount() const { return mapping->tessellationEdgeCount() + 1; }
    uint64_t snapshotBytes() const {
        return uint64_t(tessellation.numberOfVertices()) * 24 +
            uint64_t(tessellation.numberOfTetrahedra()) * 64 +
            uint64_t(edgeCount()) * 32 + uint64_t(transitionCount()) * 160;
    }
    void clearSnapshot() {
        std::vector<double>().swap(vertexData);
        std::vector<double>().swap(transitionData);
        std::vector<uint32_t>().swap(tetData);
        std::vector<uint32_t>().swap(edgeData);
        exported = false;
    }

    void exportSnapshot(uint32_t budgetBytes) {
        if (exported) return;
        requireStage(true);
        if (!mappingReady) throw std::runtime_error("DXA crystal mapping has not been constructed.");
        const size_t vertices = tessellation.numberOfVertices();
        const size_t tets = tessellation.numberOfTetrahedra();
        const size_t edges = edgeCount(), transitions = transitionCount();
        // Includes the bounded host-side key map used during packing. Reject
        // before allocating any snapshot arrays; callers can finish on CPU.
        const uint64_t workingBytes = snapshotBytes() + uint64_t(edges) * 48 +
            uint64_t(transitions) * 32;
        if (vertices > std::numeric_limits<int32_t>::max() ||
                tets > std::numeric_limits<int32_t>::max() || edges >= reversedEdge ||
                transitions >= noTransition || workingBytes > budgetBytes)
            throw std::runtime_error("DXA immutable GPU workspace exceeds the export memory budget.");
        vertexData.resize(vertices * 3);
        tetData.resize(tets * 16);
        edgeData.resize(edges * 8);
        transitionData.resize(transitions * 20);
        for (size_t vertex = 0; vertex < vertices; ++vertex) {
            if ((vertex & 1023) == 0) requireStage(true);
            const Point3& point = tessellation.vertexPosition(vertex);
            for (int axis = 0; axis < 3; ++axis) vertexData[vertex * 3 + axis] = point[axis];
        }
        // Slot zero is the self-transition. Other slots are graph transitions
        // in their original order, including separately represented reverses.
        for (int axis = 0; axis < 3; ++axis) {
            transitionData[axis * 4] = 1;
            transitionData[9 + axis * 4] = 1;
        }
        transitionData[18] = 1;
        std::unordered_map<const ClusterTransition*, uint32_t> transitionIndices;
        transitionIndices.reserve(transitions);
        const auto& graphTransitions = structure->clusterGraph()->clusterTransitions();
        for (size_t index = 0; index < graphTransitions.size(); ++index) {
            const ClusterTransition* transition = graphTransitions[index];
            transitionIndices.emplace(transition, static_cast<uint32_t>(index + 1));
            for (int component = 0; component < 9; ++component) {
                transitionData[(index + 1) * 20 + component] = transition->tm.elements()[component];
                transitionData[(index + 1) * 20 + 9 + component] = transition->reverse->tm.elements()[component];
            }
            transitionData[(index + 1) * 20 + 18] = transition->isSelfTransition() ? 1 : 0;
        }
        // Edge zero represents every missing/unmapped pair. Existing edge
        // vectors stay in their original reference frame and orientation.
        edgeData[6] = noTransition;
        std::unordered_map<uint64_t, uint32_t> edgeIndices;
        edgeIndices.reserve(edges);
        uint32_t edgeIndex = 1;
        mapping->visitTessellationEdges([&](const auto& edge) {
            if ((edgeIndex & 1023) == 0) requireStage(true);
            const uint32_t first = static_cast<uint32_t>(edge.vertex1);
            const uint32_t second = static_cast<uint32_t>(edge.vertex2);
            const uint64_t key = (uint64_t(std::min(first, second)) << 32) | std::max(first, second);
            edgeIndices.emplace(key, edgeIndex | (first > second ? reversedEdge : 0));
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
        for (size_t tet = 0; tet < tets; ++tet) {
            if ((tet & 1023) == 0) requireStage(true);
            uint32_t* row = tetData.data() + tet * 16;
            const bool finite = tessellation.isFiniteCell(tet);
            row[14] = finite ? 1 : 0;
            for (int vertex = 0; vertex < 4; ++vertex) {
                row[vertex] = finite ? tessellation.cellVertex(tet, vertex) : 0;
                row[4 + vertex] = tessellation.cellAdjacent(tet, vertex);
                if (row[4 + vertex] >= tets || (finite && row[vertex] >= vertices))
                    throw std::runtime_error("DXA snapshot contains an invalid tessellation index.");
            }
            if (!finite) continue;
            for (int edge = 0; edge < 6; ++edge) {
                const uint32_t first = static_cast<uint32_t>(tessellation.vertexIndex(row[edgeVertices[edge][0]]));
                const uint32_t second = static_cast<uint32_t>(tessellation.vertexIndex(row[edgeVertices[edge][1]]));
                const uint64_t key = (uint64_t(std::min(first, second)) << 32) | std::max(first, second);
                const auto found = edgeIndices.find(key);
                if (found != edgeIndices.end())
                    row[8 + edge] = found->second ^ (first > second ? reversedEdge : 0);
            }
        }
        exported = true;
    }

    const int32_t* expectedRegions() {
        if (!mappingReady) throw std::runtime_error("DXA crystal mapping has not been constructed.");
        if (cpuRegionsComplete) return cpuRegions.data();
        cpuRegions.assign(tessellation.numberOfTetrahedra(), -1);
        const double alpha = 5.0 * structure->maximumNeighborDistance();
        requireStage(parallelForWithProgress(cpuRegions.size(), [&](size_t tet) {
            if (!tessellation.isFiniteCell(tet)) return;
            bool filled = false;
            if (const auto result = tessellation.alphaTest(tet, alpha)) filled = *result;
            else {
                int face = 0;
                for (; face < 4; ++face) {
                    const auto adjacent = tessellation.cellAdjacent(tet, face);
                    if (!tessellation.isFiniteCell(adjacent)) break;
                    const auto adjacentResult = tessellation.alphaTest(adjacent, alpha);
                    if (adjacentResult && !*adjacentResult) break;
                }
                filled = face == 4;
            }
            if (filled && mapping->isElasticMappingCompatible(tet)) cpuRegions[tet] = 0;
        }));
        cpuRegionsComplete = true;
        return cpuRegions.data();
    }
};
std::unique_ptr<DxaSession> activeSession;

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
void alloy_dxa_dispose() { activeSession.reset(); }
void alloy_dxa_release_snapshot() { if (activeSession) activeSession->clearSnapshot(); }
void alloy_dxa_release_local_input() { if (activeSession) activeSession->releaseLocalInput(); }

// Vectors are column vectors; cell[9..11] is the Cartesian origin. Periodicity
// is encoded in bits 0, 1 and 2, including for a tilted simulation cell.
int alloy_dxa_prepare(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    activeSession.reset();
    lastError.clear();
    resultJson.clear();
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
        BufferWriteAccess<Point3> positionAccess(session.positions);
        for (int i = 0; i < count; ++i) {
            if ((i & 1023) == 0) requireStage(true);
            const double* p = coordinates + static_cast<size_t>(i) * 3;
            if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || !std::isfinite(p[2]))
                throw std::runtime_error("DXA atom coordinates must be finite.");
            positionAccess[i] = Point3(p[0], p[1], p[2]);
        }
        return 1;
    } catch (...) { saveCurrentError(true); }
    return 0;
}

int alloy_dxa_local_neighbor_width() {
    return activeSession ? int(activeSession->structure->neighborListWidth()) : 0;
}
const uint32_t* alloy_dxa_local_templates_ptr() {
    if (!activeSession) return nullptr;
    static std::array<uint32_t, 5 * 33> templates;
    for (int type = 1; type <= 5; ++type) {
        const auto& coordination = *StructureAnalysis::latticeStructure(type).coordStructure;
        uint32_t* row = templates.data() + size_t(type - 1) * 33;
        row[0] = coordination.numNeighbors;
        for (int neighbor = 0; neighbor < 16; ++neighbor) {
            row[1 + neighbor] = neighbor < coordination.numNeighbors ? coordination.cnaSignatures[neighbor] : 0;
            row[17 + neighbor] = neighbor < coordination.numNeighbors ? coordination.neighborArray.neighborArray[neighbor] : 0;
        }
    }
    return templates.data();
}
const double* alloy_dxa_local_positions_ptr() {
    lastError.clear();
    try {
        requireStage(true);
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        return activeSession->exportLocalPositions();
    } catch (...) {
        saveCurrentError(false);
        if (activeSession) activeSession->releaseLocalInput();
    }
    return nullptr;
}
const double* alloy_dxa_local_inverse_ptr() {
    return activeSession ? activeSession->localInverse.data() : nullptr;
}
const int32_t* alloy_dxa_local_types_ptr() {
    return activeSession && activeSession->localIdentified
        ? static_cast<const int32_t*>(activeSession->structures->data()) : nullptr;
}
const int32_t* alloy_dxa_local_neighbors_ptr() {
    return activeSession && activeSession->localIdentified
        ? activeSession->structure->neighborListData() : nullptr;
}
double alloy_dxa_local_max_distance() {
    return activeSession && activeSession->localIdentified
        ? activeSession->structure->maximumNeighborDistance() : 0;
}
int alloy_dxa_identify_local_cpu() {
    lastError.clear();
    try {
        requireStage(true);
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        auto& session = *activeSession;
        if (session.mappingReady) throw std::runtime_error("DXA crystal mapping has already been constructed.");
        if (!session.localIdentified) {
            alloy_dxa_progress("Identify local crystal structures", 0, 11);
            requireStage(session.structure->identifyStructures());
            session.localIdentified = true;
        }
        return 1;
    } catch (...) { saveCurrentError(true); }
    return 0;
}

// A GPU local stage supplies only its identified types and ideal-ordered atom
// indices. Failed or unsupported dispatch uses null input in this same session.
int alloy_dxa_build_mapping(const int32_t* types, const int32_t* neighbors,
        int width, double maximumDistance) {
    lastError.clear();
    bool validatingImport = false;
    try {
        requireStage(true);
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        auto& session = *activeSession;
        if (session.mappingReady) throw std::runtime_error("DXA crystal mapping has already been constructed.");
        auto& structure = *session.structure;
        auto& mapping = *session.mapping;
        if (types) {
            alloy_dxa_progress("Import GPU local crystal structures", 0, 11);
            validatingImport = true;
            requireStage(structure.importLocalStructures(types, neighbors, session.count,
                width, maximumDistance));
            validatingImport = false;
            session.localIdentified = true;
        } else {
            if (neighbors || width || maximumDistance)
                throw std::runtime_error("DXA CPU local fallback requires empty imported arrays.");
            if (!session.localIdentified) {
                alloy_dxa_progress("Identify local crystal structures", 0, 11);
                requireStage(structure.identifyStructures());
                session.localIdentified = true;
            }
        }
        session.releaseLocalInput();
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
        return 1;
    } catch (...) {
        // Invalid immutable GPU rows have not modified native arrays, so a
        // fallback can identify the same retained input on CPU. Cancellation
        // and failures after graph construction dispose the scientific frame.
        saveCurrentError(!validatingImport || Task::current()->isCanceled());
    }
    return 0;
}

// Backward-compatible staged CPU preparation remains a composition of the new
// input stage and the original complete mapping/geometry implementation.
int alloy_dxa_begin(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    if (!alloy_dxa_prepare(coordinates, count, cellData, pbcBits, lattice, trial,
            stretch, perfectOnly, smoothing, coarsening)) return 0;
    return alloy_dxa_build_mapping(nullptr, nullptr, 0, 0);
}

int alloy_dxa_vertex_count() {
    return activeSession && activeSession->mappingReady ? activeSession->tessellation.numberOfVertices() : 0;
}
int alloy_dxa_tet_count() {
    return activeSession && activeSession->mappingReady ? activeSession->tessellation.numberOfTetrahedra() : 0;
}
int alloy_dxa_edge_count() { return activeSession && activeSession->mappingReady ? activeSession->edgeCount() : 0; }
int alloy_dxa_transition_count() { return activeSession && activeSession->mappingReady ? activeSession->transitionCount() : 0; }
double alloy_dxa_snapshot_bytes() {
    return activeSession && activeSession->mappingReady ? double(activeSession->snapshotBytes()) : 0;
}
double alloy_dxa_alpha() {
    return activeSession && activeSession->localIdentified
        ? 5.0 * activeSession->structure->maximumNeighborDistance() : 0;
}
const double* alloy_dxa_vertex_ptr() { return activeSession && activeSession->exported ? activeSession->vertexData.data() : nullptr; }
const uint32_t* alloy_dxa_tet_ptr() { return activeSession && activeSession->exported ? activeSession->tetData.data() : nullptr; }
const uint32_t* alloy_dxa_edge_ptr() { return activeSession && activeSession->exported ? activeSession->edgeData.data() : nullptr; }
const double* alloy_dxa_transition_ptr() { return activeSession && activeSession->exported ? activeSession->transitionData.data() : nullptr; }
int alloy_dxa_export(uint32_t budgetBytes) {
    lastError.clear();
    try {
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        activeSession->exportSnapshot(budgetBytes);
        return 1;
    } catch (...) {
        saveCurrentError(false);
        if (activeSession) activeSession->clearSnapshot();
    }
    return 0;
}
const int32_t* alloy_dxa_cpu_regions_ptr() {
    lastError.clear();
    try {
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        return activeSession->expectedRegions();
    } catch (...) { saveCurrentError(false); }
    return nullptr;
}

// GPU labels are borrowed until this synchronous call returns. nullptr,0 uses
// the original CPU classification, allowing a failed GPU stage to recover in
// the same retained topology/heap without rerunning previous DXA stages.
const char* alloy_dxa_finish(const int32_t* regions, int regionCount) {
    lastError.clear();
    resultJson.clear();
    try {
        requireStage(true);
        if (!activeSession) throw std::runtime_error("DXA has no active staged analysis.");
        auto& session = *activeSession;
        if (!session.mappingReady) throw std::runtime_error("DXA crystal mapping has not been constructed.");
        if ((!regions && regionCount != 0) ||
                (regions && (regionCount < 0 || size_t(regionCount) != session.tessellation.numberOfTetrahedra())))
            throw std::runtime_error("DXA GPU classification has an inconsistent tetrahedron count.");
        if (regions) {
            for (int tet = 0; tet < regionCount; ++tet) {
                if ((tet & 1023) == 0) requireStage(true);
                if ((regions[tet] != -1 && regions[tet] != 0) ||
                        (regions[tet] == 0 && !session.tessellation.isFiniteCell(tet)))
                    throw std::runtime_error("DXA GPU classification contains invalid region labels.");
            }
        }
        // The host has copied immutable snapshots before dispatching GPU work.
        // Release those duplicates before the manifold/tracer allocate their
        // topology; the original scientific session and imported labels stay.
        session.clearSnapshot();
        session.tessellation.setPreclassifiedRegions(regions, regionCount);
        auto& cell = session.cell;
        auto& structure = *session.structure;
        auto& interfaceMesh = *session.interfaceMesh;
        auto& tracer = *session.tracer;
        auto& operation = session.operation;
        const int count = session.count, lattice = session.lattice, smoothing = session.smoothing;
        const double coarsening = session.coarsening;
        const auto& structures = session.structures;
        alloy_dxa_progress("Construct crystal interface mesh", 7, 11);
        requireStage(interfaceMesh.createMesh(structure.maximumNeighborDistance(), {}, operation));
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
        out << "],\"totalLength\":" << totalLength << ",\"atomStructureTypes\":[";
        BufferReadAccess<int32_t> structureAccess(structures);
        for (int i = 0; i < count; ++i) {
            if ((i & 1023) == 0) requireStage(true);
            if (i) out << ',';
            out << structureAccess[i];
        }
        out << "]}";
        resultJson = out.str();
        alloy_dxa_progress("DXA complete", 11, 11);
        return resultJson.c_str();

    } catch (...) { saveCurrentError(true); }
    return nullptr;
}

// Backward-compatible CPU entry point. No GPU snapshots are created here.
const char* alloy_dxa_analyze(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    if (!alloy_dxa_begin(coordinates, count, cellData, pbcBits, lattice, trial,
            stretch, perfectOnly, smoothing, coarsening)) return nullptr;
    const char* result = alloy_dxa_finish(nullptr, 0);
    alloy_dxa_dispose();
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
