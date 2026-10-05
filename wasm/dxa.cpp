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
    if (!success) throw std::runtime_error("DXA analysis was canceled.");
}
}

extern "C" {
const char* alloy_dxa_last_error() { return lastError.c_str(); }

// Vectors are column vectors; cell[9..11] is the Cartesian origin. Periodicity
// is encoded in bits 0, 1 and 2, including for a tilted simulation cell.
// The returned UTF-8 JSON pointer is kernel-owned until the next analysis.
const char* alloy_dxa_analyze(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int trial, int stretch,
        int perfectOnly, int smoothing, double coarsening) {
    lastError.clear();
    resultJson.clear();
    try {
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
        SimulationCellObject cell(matrix, bool(pbcBits & 1), bool(pbcBits & 2), bool(pbcBits & 4));
        auto positions = std::make_shared<PropertyStorage>(count, sizeof(Point3));
        BufferWriteAccess<Point3> positionAccess(positions);
        for (int i = 0; i < count; ++i) {
            const double* p = coordinates + static_cast<size_t>(i) * 3;
            if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || !std::isfinite(p[2]))
                throw std::runtime_error("DXA atom coordinates must be finite.");
            positionAccess[i] = Point3(p[0], p[1], p[2]);
        }
        auto structures = std::make_shared<PropertyStorage>(count, sizeof(int32_t));
        ProgressingTask operation;
        // Match the official modifier's preferred crystal-frame convention.
        // Hexagonal lattices retain their native ideal-template reference frame.
        std::vector<Matrix3> preferredCrystalOrientations;
        if (lattice == StructureAnalysis::LATTICE_FCC ||
                lattice == StructureAnalysis::LATTICE_BCC ||
                lattice == StructureAnalysis::LATTICE_CUBIC_DIAMOND)
            preferredCrystalOrientations.push_back(Matrix3::Identity());
        StructureAnalysis structure(positions, &cell,
            static_cast<StructureAnalysis::LatticeStructureType>(lattice), nullptr,
            structures, std::move(preferredCrystalOrientations), !perfectOnly);
        DelaunayTessellation tessellation;
        ElasticMapping mapping(structure, tessellation);
        InterfaceMesh interfaceMesh(mapping);
        DislocationTracer tracer(interfaceMesh, structure.clusterGraph(), trial, stretch);

        alloy_dxa_progress("Identify local crystal structures", 0, 11);
        requireStage(structure.identifyStructures());
        alloy_dxa_progress("Build crystal clusters", 1, 11);
        requireStage(structure.buildClusters());
        alloy_dxa_progress("Connect crystal reference frames", 2, 11);
        requireStage(structure.connectClusters());
        alloy_dxa_progress("Periodic Delaunay tessellation", 3, 11);
        requireStage(tessellation.generateTessellation(structure.cell(),
            BufferReadAccess<Point3>(positions).cbegin(), count,
            3.5 * structure.maximumNeighborDistance(), false, nullptr, operation));
        alloy_dxa_progress("Build tessellation edges", 4, 11);
        requireStage(mapping.generateTessellationEdges(operation));
        alloy_dxa_progress("Assign crystal clusters", 5, 11);
        requireStage(mapping.assignVerticesToClusters(operation));
        alloy_dxa_progress("Map edges to the ideal lattice", 6, 11);
        requireStage(mapping.assignIdealVectorsToEdges(4, operation));
        structure.freeNeighborLists();
        alloy_dxa_progress("Construct crystal interface mesh", 7, 11);
        requireStage(interfaceMesh.createMesh(structure.maximumNeighborDistance(), {}, operation));
        alloy_dxa_progress("Trace Burgers circuits and dislocation lines", 8, 11);
        requireStage(tracer.traceDislocationSegments(operation));
        alloy_dxa_progress("Connect dislocation junctions", 9, 11);
        tracer.finishDislocationSegments(lattice);
        alloy_dxa_progress("Smooth and coarsen dislocation lines", 10, 11);
        if (smoothing > 0 || coarsening > 0)
            requireStage(tracer.network()->smoothDislocationLines(smoothing, coarsening, operation));

        std::ostringstream out;
        out << std::setprecision(17);
        double totalLength = 0;
        out << "{\"backend\":\"cpu-wasm\",\"algorithm\":\"OVITO DXA 3.9.4\",\"lattice\":" << lattice
            << ",\"volume\":" << cell.volume3D() << ",\"segments\":[";
        bool firstSegment = true;
        for (const DislocationSegment* segment : tracer.network()->segments()) {
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
            if (i) out << ',';
            out << structureAccess[i];
        }
        out << "]}";
        resultJson = out.str();
        alloy_dxa_progress("DXA complete", 11, 11);
        return resultJson.c_str();
    } catch (const std::bad_alloc&) {
        lastError = "Insufficient memory for periodic DXA tessellation. Reduce the analyzed structure.";
    } catch (const std::exception& error) {
        lastError = error.what();
    } catch (...) {
        lastError = "DXA failed while building the crystal topology.";
    }
    return nullptr;
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
