// CPU worker adapter for the original OVITO 3.9.4 DXA local recognition stage.
// Each worker keeps the whole frame's geometry and returns only its assigned rows.
#include <ovito/crystalanalysis/modifier/dxa/StructureAnalysis.h>
#include <stdexcept>

using namespace Ovito;
using namespace Ovito::CrystalAnalysis;

namespace {
struct DxaLocalSession {
    SimulationCellObject cell;
    PropertyPtr positions, structures;
    std::unique_ptr<StructureAnalysis> structure;
    bool hasResults = false;

    DxaLocalSession(const AffineTransformation& matrix, int pbcBits, int count,
            int lattice, int perfectOnly) :
        cell(matrix, bool(pbcBits & 1), bool(pbcBits & 2), bool(pbcBits & 4)),
        positions(std::make_shared<PropertyStorage>(count, sizeof(Point3))),
        structures(std::make_shared<PropertyStorage>(count, sizeof(int32_t))) {
        std::vector<Matrix3> preferredCrystalOrientations;
        if(lattice == StructureAnalysis::LATTICE_FCC ||
                lattice == StructureAnalysis::LATTICE_BCC ||
                lattice == StructureAnalysis::LATTICE_CUBIC_DIAMOND)
            preferredCrystalOrientations.push_back(Matrix3::Identity());
        structure = std::make_unique<StructureAnalysis>(positions, &cell,
                static_cast<StructureAnalysis::LatticeStructureType>(lattice), nullptr,
                structures, std::move(preferredCrystalOrientations), !perfectOnly);
    }
};

std::unique_ptr<DxaLocalSession> localSession;
std::string localError;

void requireLocalStage(bool success) {
    if(!success || Task::current()->isCanceled())
        throw std::runtime_error("CPU DXA local recognition was canceled.");
}

void saveLocalError() {
    try { throw; }
    catch(const std::bad_alloc&) {
        localError = "Insufficient memory for CPU DXA local recognition.";
    }
    catch(const std::exception& error) { localError = error.what(); }
    catch(...) { localError = "CPU DXA local recognition failed."; }
}
}

extern "C" {

const char* alloy_dxa_local_error() { return localError.c_str(); }
void alloy_dxa_local_dispose() { localSession.reset(); }

// The cell layout and double-precision coordinate operations match alloy_dxa_begin.
int alloy_dxa_local_prepare(const double* coordinates, int count,
        const double* cellData, int pbcBits, int lattice, int perfectOnly) {
    localSession.reset();
    localError.clear();
    try {
        requireLocalStage(true);
        if(!coordinates || !cellData || count < 1)
            throw std::runtime_error("CPU DXA local recognition requires a non-empty three-dimensional structure.");
        if(lattice < 1 || lattice > 5)
            throw std::runtime_error("Select an FCC, HCP, BCC, or diamond input lattice.");
        for(int component = 0; component < 12; component++)
            if(!std::isfinite(cellData[component]))
                throw std::runtime_error("DXA cell contains non-finite coordinates.");
        AffineTransformation matrix;
        for(int column = 0; column < 4; column++)
            matrix.column(column) = Vector3(cellData[column * 3], cellData[column * 3 + 1], cellData[column * 3 + 2]);
        if(std::abs(matrix.determinant()) <= std::numeric_limits<double>::epsilon())
            throw std::runtime_error("DXA requires a non-singular three-dimensional cell.");
        localSession = std::make_unique<DxaLocalSession>(matrix, pbcBits, count, lattice, perfectOnly);
        if(localSession->cell.isDegenerate())
            throw std::runtime_error("Simulation cell is degenerate.");
        BufferWriteAccess<Point3> positions(localSession->positions);
        for(int atom = 0; atom < count; atom++) {
            if((atom & 1023) == 0) requireLocalStage(true);
            const double* point = coordinates + static_cast<size_t>(atom) * 3;
            if(!std::isfinite(point[0]) || !std::isfinite(point[1]) || !std::isfinite(point[2]))
                throw std::runtime_error("DXA atom coordinates must be finite.");
            positions[atom] = Point3(point[0], point[1], point[2]);
        }
        return 1;
    }
    catch(...) {
        saveLocalError();
        localSession.reset();
        return 0;
    }
}

int alloy_dxa_local_identify(int start, int end) {
    localError.clear();
    if(localSession) localSession->hasResults = false;
    try {
        requireLocalStage(true);
        if(!localSession)
            throw std::runtime_error("CPU DXA local recognition has no prepared frame.");
        if(start < 0 || end < 0)
            throw std::runtime_error("Invalid CPU DXA local atom range.");
        requireLocalStage(localSession->structure->identifyStructuresRange(start, end));
        localSession->hasResults = true;
        return 1;
    }
    catch(...) { saveLocalError(); return 0; }
}

const int32_t* alloy_dxa_local_structures_ptr() {
    return localSession && localSession->hasResults ?
            static_cast<const int32_t*>(localSession->structures->data()) : nullptr;
}

const int32_t* alloy_dxa_local_neighbors_ptr() {
    static_assert(sizeof(int) == sizeof(int32_t), "DXA neighbor indices require 32-bit integers.");
    return localSession && localSession->hasResults ?
            reinterpret_cast<const int32_t*>(localSession->structure->neighborListsData()) : nullptr;
}

int alloy_dxa_local_neighbor_width() {
    return localSession ? static_cast<int>(localSession->structure->neighborListWidth()) : 0;
}

double alloy_dxa_local_max_distance() {
    return localSession && localSession->hasResults ? localSession->structure->maximumNeighborDistance() : 0;
}

} // extern "C"
