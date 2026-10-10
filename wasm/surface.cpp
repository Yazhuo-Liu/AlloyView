// AlloyView's headless alpha-shape surface construction, after OVITO 3.9.4
// ConstructSurfaceModifier::AlphaShapeEngine (MIT option). The tessellation,
// the one-sided manifold construction, makeManifold() and smoothMesh() are the
// vendored sources in third_party/dxa. Volumetric regions follow upstream's
// ManifoldConstructionHelper::formFilledRegions()/formEmptyRegions(); see
// docs/features/surface-mesh.md for the differences in bookkeeping.
#include <geometry/DelaunayTessellation.h>
#include <geometry/ManifoldConstructionHelper.h>
#include <geometry/SurfaceMeshBuilder.h>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <vector>
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(void, alloy_surface_progress, (const char* phase, int completed, int total), {
  if (typeof Module.onSurfaceProgress === 'function') {
    Module.onSurfaceProgress(UTF8ToString(phase), completed, total);
  }
});
#else
static void alloy_surface_progress(const char*, int, int) {}
#endif

using namespace Ovito;
using namespace Ovito::Delaunay;
using namespace Ovito::Mesh;

namespace {
constexpr int surfaceStages = 6;
constexpr int32_t noRegion = -1;

struct SurfaceOutput {
    std::string json;
    std::vector<double> vertices;          // xyz per vertex
    std::vector<uint32_t> vertexParticles; // input atom of each vertex
    std::vector<uint32_t> faces;           // three vertices per face
    std::vector<int32_t> faceRegions;      // filled and empty region per face
    std::vector<double> regions;           // volume, area, filled, exterior per region
    void clear() { *this = SurfaceOutput(); }
};
SurfaceOutput output;
std::string surfaceError;

void requireSurface(bool success) {
    if (!success || Task::current()->isCanceled()) throw std::runtime_error("Surface construction was canceled.");
}

// A triangle of three atoms with a rotation-invariant orientation: the
// smallest index first, as in upstream's reorderFaceVertices().
struct FacetKey {
    uint32_t a, b, c;
    bool operator==(const FacetKey& other) const { return a == other.a && b == other.b && c == other.c; }
};
struct FacetKeyHash {
    size_t operator()(const FacetKey& key) const {
        uint64_t value = (uint64_t(key.a) * 0x9E3779B97F4A7C15ull) ^ (uint64_t(key.b) << 21) ^ (uint64_t(key.c) << 42)
            ^ (uint64_t(key.b) * 0xC2B2AE3D27D4EB4Full) ^ (uint64_t(key.c) * 0x165667B19E3779F9ull);
        return static_cast<size_t>(value ^ (value >> 29));
    }
};
FacetKey facetKey(const DelaunayTessellation& tessellation, DelaunayTessellation::CellHandle cell, int facet, bool reversed) {
    uint32_t atoms[3];
    for (int corner = 0; corner < 3; ++corner) {
        atoms[corner] = static_cast<uint32_t>(tessellation.vertexIndex(tessellation.cellVertex(cell,
            DelaunayTessellation::cellFacetVertexIndex(facet, reversed ? 2 - corner : corner))));
    }
    int first = 0;
    if (atoms[1] < atoms[first]) first = 1;
    if (atoms[2] < atoms[first]) first = 2;
    return { atoms[first], atoms[(first + 1) % 3], atoms[(first + 2) % 3] };
}

double tetrahedronVolume(const Point3& a, const Point3& b, const Point3& c, const Point3& d) {
    const Vector3 ad = b - a, bd = c - a, cd = d - a;
    return std::abs(ad.dot(cd.cross(bd))) / 6.0;
}

using Tetrahedron = std::array<Point3, 4>;

// Keep the part of each tetrahedron where sign * (x[axis] - bound) >= 0. A cut
// tetrahedron leaves one tetrahedron or a wedge, which is three tetrahedra.
void clipTetrahedra(std::vector<Tetrahedron>& tetrahedra, std::vector<Tetrahedron>& scratch, int axis, double bound, double sign) {
    scratch.clear();
    for (const Tetrahedron& tetrahedron : tetrahedra) {
        double distance[4];
        int inside[4], outside[4], insideCount = 0, outsideCount = 0;
        for (int vertex = 0; vertex < 4; ++vertex) {
            distance[vertex] = sign * (tetrahedron[vertex][axis] - bound);
            if (distance[vertex] >= 0) inside[insideCount++] = vertex;
            else outside[outsideCount++] = vertex;
        }
        if (insideCount == 4) { scratch.push_back(tetrahedron); continue; }
        if (insideCount == 0) continue;
        const auto cut = [&](int from, int to) {
            const double fraction = distance[from] / (distance[from] - distance[to]);
            Point3 point = tetrahedron[from] + (tetrahedron[to] - tetrahedron[from]) * fraction;
            point[axis] = bound;
            return point;
        };
        if (insideCount == 1) {
            const int a = inside[0];
            scratch.push_back({ tetrahedron[a], cut(a, outside[0]), cut(a, outside[1]), cut(a, outside[2]) });
        } else if (insideCount == 3) {
            const int a = outside[0];
            const Point3 b = tetrahedron[inside[0]], c = tetrahedron[inside[1]], d = tetrahedron[inside[2]];
            const Point3 cutB = cut(inside[0], a), cutC = cut(inside[1], a), cutD = cut(inside[2], a);
            scratch.push_back({ b, c, d, cutB });
            scratch.push_back({ c, d, cutB, cutC });
            scratch.push_back({ d, cutB, cutC, cutD });
        } else {
            const Point3 a = tetrahedron[inside[0]], b = tetrahedron[inside[1]];
            const Point3 a0 = cut(inside[0], outside[0]), a1 = cut(inside[0], outside[1]);
            const Point3 b0 = cut(inside[1], outside[0]), b1 = cut(inside[1], outside[1]);
            scratch.push_back({ a, a0, a1, b });
            scratch.push_back({ a0, a1, b, b0 });
            scratch.push_back({ a1, b, b0, b1 });
        }
    }
    tetrahedra.swap(scratch);
}

// Volume of a Delaunay cell inside the simulation cell, as upstream's
// calculateVolumeOverlap(). The overlap is clipped into tetrahedra in reduced
// coordinates instead of building a convex hull of clipped edges.
double cellOverlapVolume(const DelaunayTessellation& tessellation, DelaunayTessellation::CellHandle cell,
        std::array<bool, 3>& outside, std::vector<Tetrahedron>& tetrahedra, std::vector<Tetrahedron>& scratch) {
    const SimulationCellObject* domain = tessellation.simCell();
    Point3 positions[4];
    Tetrahedron reduced;
    bool inside = true;
    for (int vertex = 0; vertex < 4; ++vertex) {
        positions[vertex] = tessellation.vertexPosition(tessellation.cellVertex(cell, vertex));
        reduced[vertex] = domain->absoluteToReduced(positions[vertex]);
        for (int axis = 0; axis < 3; ++axis) {
            if (reduced[vertex][axis] < 0.0 || reduced[vertex][axis] > 1.0) { inside = false; outside[axis] = true; }
        }
    }
    if (inside) return tetrahedronVolume(positions[0], positions[1], positions[2], positions[3]);
    tetrahedra.clear();
    tetrahedra.push_back(reduced);
    for (int axis = 0; axis < 3 && !tetrahedra.empty(); ++axis) {
        clipTetrahedra(tetrahedra, scratch, axis, 0.0, 1.0);
        clipTetrahedra(tetrahedra, scratch, axis, 1.0, -1.0);
    }
    double volume = 0;
    for (const Tetrahedron& piece : tetrahedra) volume += tetrahedronVolume(piece[0], piece[1], piece[2], piece[3]);
    return volume * domain->volume3D();
}

struct UnionFind {
    std::vector<int32_t> parent;
    int32_t find(int32_t index) {
        while (parent[index] != index) { parent[index] = parent[parent[index]]; index = parent[index]; }
        return index;
    }
};

void saveSurfaceError() {
    output.clear();
    try { throw; }
    catch (const std::bad_alloc&) {
        surfaceError = "Insufficient memory for the surface tessellation. Reduce the analyzed structure.";
    } catch (const std::exception& error) {
        surfaceError = error.what();
    } catch (...) {
        surfaceError = "Surface construction failed.";
    }
}

void constructSurface(const double* coordinates, int count, const double* cellData, int pbcBits,
        const uint8_t* selection, double radius, int smoothingLevel) {
    requireSurface(true);
    if (!coordinates || !cellData || count < 1) throw std::runtime_error("Surface construction requires a non-empty structure.");
    if (!std::isfinite(radius) || radius <= 0) throw std::runtime_error("Radius parameter must be positive.");
    if (smoothingLevel < 0 || smoothingLevel > 1000) throw std::runtime_error("The surface smoothing level must be between 0 and 1000.");
    for (int k = 0; k < 12; ++k)
        if (!std::isfinite(cellData[k])) throw std::runtime_error("The simulation cell contains non-finite coordinates.");
    AffineTransformation matrix;
    for (int k = 0; k < 4; ++k)
        matrix.column(k) = Vector3(cellData[k * 3], cellData[k * 3 + 1], cellData[k * 3 + 2]);
    if (std::abs(matrix.determinant()) <= std::numeric_limits<double>::epsilon())
        throw std::runtime_error("Simulation cell is degenerate (volume of parallelepiped is zero).");
    const SimulationCellObject cell(matrix, bool(pbcBits & 1), bool(pbcBits & 2), bool(pbcBits & 4));
    if (cell.isDegenerate()) throw std::runtime_error("Simulation cell is degenerate (volume of parallelepiped is zero).");

    PropertyPtr positions = std::make_shared<PropertyStorage>(count, sizeof(Point3));
    std::vector<SelectionIntType> selected;
    size_t inputCount = count;
    {
        BufferWriteAccess<Point3> access(positions);
        for (int i = 0; i < count; ++i) {
            if ((i & 1023) == 0) requireSurface(true);
            const double* p = coordinates + static_cast<size_t>(i) * 3;
            if (!std::isfinite(p[0]) || !std::isfinite(p[1]) || !std::isfinite(p[2]))
                throw std::runtime_error("Atom coordinates must be finite.");
            access[i] = Point3(p[0], p[1], p[2]);
        }
    }
    if (selection) {
        selected.resize(count);
        inputCount = 0;
        for (int i = 0; i < count; ++i) { selected[i] = selection[i] ? 1 : 0; inputCount += selection[i] ? 1 : 0; }
    }

    const double alpha = radius * radius;
    const FloatType ghostLayerSize = radius * FloatType(3.5);
    // Check if combination of radius parameter and simulation cell size is valid.
    for (size_t dim = 0; dim < 3; dim++) {
        if (cell.hasPbc(dim)) {
            int stencilCount = (int)std::ceil(ghostLayerSize / cell.matrix().column(dim).dot(cell.cellNormalVector(dim)));
            if (stencilCount > 1)
                throw std::runtime_error("Cannot generate Delaunay tessellation. Simulation cell is too small, or radius parameter is too large.");
        }
    }

    ProgressingTask operation;
    DelaunayTessellation tessellation;
    SurfaceMesh mesh;
    SurfaceMeshBuilder builder(&mesh);
    builder.setDomain(&cell);
    builder.mutableRegions()->setElementCount(1);

    // One entry per mesh face: the filled cell it was created from, the
    // facet of that cell and the three atoms in face order.
    std::vector<DelaunayTessellation::CellHandle> faceCells;
    std::vector<uint8_t> faceFacets;
    std::vector<uint32_t> faceAtoms;
    size_t tetrahedronCount = 0;

    if (inputCount > 0) {
        alloy_surface_progress("Periodic Delaunay tessellation", 0, surfaceStages);
        // Finite tetrahedra must cover the whole cell to measure empty regions:
        // eight far helper points are added, as upstream does when it
        // identifies regions. They never belong to a filled tetrahedron.
        requireSurface(tessellation.generateTessellation(&cell, BufferReadAccess<Point3>(positions).cbegin(), count,
            ghostLayerSize, true, selection ? selected.data() : nullptr, operation));
        tetrahedronCount = tessellation.numberOfTetrahedra();

        alloy_surface_progress("Classify tetrahedra and build the surface", 1, surfaceStages);
        const auto tetrahedronRegion = [](DelaunayTessellation::CellHandle) -> SurfaceMesh::region_index { return 0; };
        const auto prepareMeshFace = [&](SurfaceMesh::face_index, const std::array<size_t, 3>& atoms,
                const std::array<DelaunayTessellation::VertexHandle, 3>& handles, DelaunayTessellation::CellHandle cell) {
            int facet = 0;
            for (; facet < 4; ++facet) {
                const auto vertex = tessellation.cellVertex(cell, facet);
                if (vertex != handles[0] && vertex != handles[1] && vertex != handles[2]) break;
            }
            if (facet == 4) throw std::runtime_error("Cannot construct mesh for this input dataset. Face is not a cell facet.");
            faceCells.push_back(cell);
            faceFacets.push_back(static_cast<uint8_t>(facet));
            for (size_t atom : atoms) faceAtoms.push_back(static_cast<uint32_t>(atom));
        };
        ManifoldConstructionHelper manifoldConstructor(tessellation, builder, alpha, false, positions);
        requireSurface(manifoldConstructor.construct(tetrahedronRegion, operation, prepareMeshFace));
    }
    const int faceCount = builder.faceCount();
    if (faceCells.size() != size_t(faceCount)) throw std::runtime_error("Surface faces are inconsistent with the tessellation.");

    alloy_surface_progress("Identify filled and empty regions", 2, surfaceStages);
    const size_t cellCount = tetrahedronCount;
    const auto isFilled = [&](DelaunayTessellation::CellHandle cell) {
        return tessellation.getUserField(cell) != SurfaceMesh::InvalidIndex;
    };

    // Mesh faces of each filled primary cell, and all faces by their atoms.
    std::vector<std::array<int32_t, 4>> cellFaces;
    std::unordered_map<FacetKey, int32_t, FacetKeyHash> faceLookup;
    faceLookup.reserve(size_t(faceCount) * 2);
    for (int face = 0; face < faceCount; ++face) {
        const auto index = tessellation.getCellIndex(faceCells[face]);
        if (index < 0) throw std::runtime_error("Surface faces are inconsistent with the tessellation.");
        if (size_t(index) >= cellFaces.size()) cellFaces.resize(size_t(index) + 1, { -1, -1, -1, -1 });
        cellFaces[index][faceFacets[face]] = face;
        faceLookup.emplace(facetKey(tessellation, faceCells[face], faceFacets[face], true), face);
    }
    // Upstream's findCellFace(): the mesh face on a facet seen from its filled side.
    const auto findCellFace = [&](const DelaunayTessellation::Facet& facet) -> int32_t {
        const auto index = tessellation.getCellIndex(facet.first);
        if (index != -1) return cellFaces[index][facet.second];
        const auto found = faceLookup.find(facetKey(tessellation, facet.first, facet.second, true));
        return found == faceLookup.end() ? -1 : found->second;
    };

    // --- Filled regions: facet-connected filled cells of the periodic structure.
    // cellRegion holds union-find parents first, then region numbers.
    std::vector<int32_t> cellRegion(cellCount, noRegion);
    std::vector<double> regionVolumes, regionAreas;
    std::vector<uint8_t> regionExterior;
    int filledRegionCount = 0;
    size_t filledCellCount = 0;
    {
        UnionFind sets;
        sets.parent.swap(cellRegion);
        // A filled ghost cell is a periodic image of a filled primary cell.
        // Index the primary facets that face ghost cells to find that image.
        std::unordered_map<FacetKey, int32_t, FacetKeyHash> primaryFacets;
        for (size_t cell = 0; cell < cellCount; ++cell) {
            if ((cell & 4095) == 0) requireSurface(true);
            if (!isFilled(cell) || tessellation.isGhostCell(cell)) continue;
            sets.parent[cell] = static_cast<int32_t>(cell);
            ++filledCellCount;
            for (int facet = 0; facet < 4; ++facet) {
                const auto adjacent = tessellation.cellAdjacent(cell, facet);
                if (isFilled(adjacent) && tessellation.isGhostCell(adjacent))
                    primaryFacets.emplace(facetKey(tessellation, cell, facet, false), static_cast<int32_t>(cell));
            }
        }
        const auto unite = [&](int32_t first, int32_t second) {
            first = sets.find(first); second = sets.find(second);
            // The lower cell stays the root, so regions keep upstream's order.
            if (first < second) sets.parent[second] = first;
            else if (second < first) sets.parent[first] = second;
        };
        for (size_t cell = 0; cell < cellCount; ++cell) {
            if ((cell & 4095) == 0) requireSurface(true);
            if (sets.parent[cell] == noRegion) continue;
            for (int facet = 0; facet < 4; ++facet) {
                const auto adjacent = tessellation.cellAdjacent(cell, facet);
                if (!isFilled(adjacent)) continue;
                if (!tessellation.isGhostCell(adjacent)) { unite(cell, adjacent); continue; }
                const auto image = primaryFacets.find(facetKey(tessellation, cell, facet, true));
                if (image != primaryFacets.end()) unite(cell, image->second);
            }
        }
        // Point every member at its root, then number the sets. A root is the
        // lowest cell of its set, so it is numbered (stored as -2 - region)
        // before any of its members reads it.
        for (size_t cell = 0; cell < cellCount; ++cell)
            if (sets.parent[cell] != noRegion) sets.parent[cell] = sets.find(static_cast<int32_t>(cell));
        for (size_t cell = 0; cell < cellCount; ++cell) {
            if ((cell & 4095) == 0) requireSurface(true);
            const int32_t root = sets.parent[cell];
            if (root == noRegion) continue;
            int32_t region;
            if (root == int32_t(cell)) { region = filledRegionCount++; regionVolumes.push_back(0); }
            else region = -2 - sets.parent[root];
            regionVolumes[region] += tetrahedronVolume(
                tessellation.vertexPosition(tessellation.cellVertex(cell, 0)), tessellation.vertexPosition(tessellation.cellVertex(cell, 1)),
                tessellation.vertexPosition(tessellation.cellVertex(cell, 2)), tessellation.vertexPosition(tessellation.cellVertex(cell, 3)));
            sets.parent[cell] = -2 - region;
        }
        for (size_t cell = 0; cell < cellCount; ++cell)
            if (sets.parent[cell] != noRegion) sets.parent[cell] = -2 - sets.parent[cell];
        cellRegion.swap(sets.parent);
    }

    // --- Empty regions, following upstream's formEmptyRegions().
    // Connected surface components give preliminary region numbers.
    std::vector<int32_t> faceEmptyRegion(faceCount, noRegion);
    int surfaceComponentCount = 0;
    {
        std::vector<int32_t> stack;
        for (int seed = 0; seed < faceCount; ++seed) {
            if (faceEmptyRegion[seed] != noRegion) continue;
            const int32_t region = filledRegionCount + surfaceComponentCount++;
            faceEmptyRegion[seed] = region;
            stack.push_back(seed);
            while (!stack.empty()) {
                const int32_t face = stack.back();
                stack.pop_back();
                const auto first = builder.firstFaceEdge(face);
                auto edge = first;
                do {
                    const int32_t neighbor = builder.adjacentFace(builder.oppositeEdge(edge));
                    if (faceEmptyRegion[neighbor] == noRegion) { faceEmptyRegion[neighbor] = region; stack.push_back(neighbor); }
                    edge = builder.nextFaceEdge(edge);
                } while (edge != first);
            }
            requireSurface(true);
        }
    }
    // Periodic directions in which some surface edge passes through the cell boundary.
    bool surfaceCrossesBoundaries[3] = { false, false, false };
    for (int edge = 0; edge < builder.edgeCount(); ++edge) {
        const Vector3 delta = mesh.points[builder.vertex2(edge)] - mesh.points[builder.vertex1(edge)];
        for (size_t dim = 0; dim < 3; dim++) {
            if (!surfaceCrossesBoundaries[dim] && cell.hasPbc(dim) && std::abs(cell.inverseMatrix().prodrow(delta, dim)) >= FloatType(0.5))
                surfaceCrossesBoundaries[dim] = true;
        }
    }

    int emptyRegionCount = surfaceComponentCount;
    std::vector<int32_t> emptyRegionIds(surfaceComponentCount);
    {
        // Disjoint sets for merging preliminary empty regions.
        std::vector<size_t> regionParents(emptyRegionCount), regionSizes(emptyRegionCount, 1);
        std::vector<double> emptyVolumes(emptyRegionCount, 0.0);
        std::vector<uint8_t> emptyExterior(emptyRegionCount, 0);
        std::iota(regionParents.begin(), regionParents.end(), size_t(0));
        const auto findRegion = [&](size_t index) {
            size_t parent = regionParents[index];
            while (parent != regionParents[parent]) parent = regionParents[parent];
            regionParents[index] = parent;
            return parent;
        };
        const auto mergeRegions = [&](int32_t regionA, int32_t regionB) {
            if (regionA == regionB) return;
            const size_t parentA = findRegion(regionA - filledRegionCount), parentB = findRegion(regionB - filledRegionCount);
            if (parentA == parentB) return;
            // Attach smaller tree under root of larger tree.
            const bool intoB = regionSizes[parentA] < regionSizes[parentB];
            const size_t root = intoB ? parentB : parentA, child = intoB ? parentA : parentB;
            regionParents[child] = root;
            regionSizes[root] += regionSizes[child];
            emptyVolumes[root] += emptyVolumes[child];
            emptyExterior[root] |= emptyExterior[child];
        };
        // The empty region that is split by a periodic boundary no surface crosses.
        int32_t splitPeriodicRegion = noRegion;
        std::deque<DelaunayTessellation::CellHandle> cellsToProcess;
        std::vector<Tetrahedron> pieces, scratch;
        size_t visited = 0;
        for (size_t seed = 0; seed < cellCount; ++seed) {
            // Only consider finite cells that are neither filled nor visited.
            if (!tessellation.isFiniteCell(seed) || isFilled(seed) || cellRegion[seed] != noRegion) continue;
            // Start from cells next to a face of the surface mesh.
            int32_t emptyRegion = noRegion;
            for (int f = 0; f < 4; f++) {
                const int32_t face = findCellFace(tessellation.mirrorFacet(seed, f));
                if (face != -1) emptyRegion = faceEmptyRegion[face];
            }
            if (emptyRegion == noRegion) continue;
            cellsToProcess.push_back(seed);
            cellRegion[seed] = emptyRegion;
            double regionVolume = 0;
            bool touchesOpenBoundaries = false;
            do {
                const auto currentCell = cellsToProcess.front();
                cellsToProcess.pop_front();
                if ((++visited & 1023) == 0) requireSurface(true);
                std::array<bool, 3> cellCrossesBoundaries = { false, false, false };
                const double overlapVolume = cellOverlapVolume(tessellation, currentCell, cellCrossesBoundaries, pieces, scratch);
                // An exterior region reaches an open boundary of the simulation cell.
                touchesOpenBoundaries |= (cellCrossesBoundaries[0] && !cell.hasPbc(0))
                    || (cellCrossesBoundaries[1] && !cell.hasPbc(1)) || (cellCrossesBoundaries[2] && !cell.hasPbc(2));
                // Stop at cells that are completely outside of the simulation box.
                if (overlapVolume == 0) continue;
                regionVolume += overlapVolume;
                for (size_t dim = 0; dim < 3; dim++) {
                    if (cellCrossesBoundaries[dim] && !surfaceCrossesBoundaries[dim] && cell.hasPbc(dim)) {
                        if (splitPeriodicRegion == noRegion) splitPeriodicRegion = emptyRegion;
                        else mergeRegions(emptyRegion, splitPeriodicRegion);
                    }
                }
                for (int f = 0; f < 4; f++) {
                    const DelaunayTessellation::Facet mirrorFacet = tessellation.mirrorFacet(currentCell, f);
                    const int32_t face = findCellFace(mirrorFacet);
                    if (face != -1) {
                        // A region border: both sides name the same empty region.
                        mergeRegions(emptyRegion, faceEmptyRegion[face]);
                        continue;
                    }
                    const auto neighborCell = mirrorFacet.first;
                    if (!tessellation.isFiniteCell(neighborCell) || isFilled(neighborCell)) continue;
                    if (cellRegion[neighborCell] != noRegion) { mergeRegions(emptyRegion, cellRegion[neighborCell]); continue; }
                    cellRegion[neighborCell] = emptyRegion;
                    cellsToProcess.push_back(neighborCell);
                }
            } while (!cellsToProcess.empty());
            const size_t index = findRegion(emptyRegion - filledRegionCount);
            emptyVolumes[index] += regionVolume;
            emptyExterior[index] |= touchesOpenBoundaries ? 1 : 0;
        }
        // Remap merged regions to a contiguous range after the filled regions.
        emptyRegionCount = 0;
        for (size_t i = 0; i < regionParents.size(); i++) {
            if (findRegion(i) != i) continue;
            emptyRegionIds[i] = filledRegionCount + emptyRegionCount++;
            regionVolumes.push_back(emptyVolumes[i]);
            regionExterior.push_back(emptyExterior[i]);
        }
        for (size_t i = 0; i < regionParents.size(); i++) emptyRegionIds[i] = emptyRegionIds[findRegion(i)];
        for (int32_t& region : faceEmptyRegion) region = emptyRegionIds[region - filledRegionCount];
    }
    // A single space-filling empty region if there is no filled region at all.
    if (emptyRegionCount == 0 && filledRegionCount == 0) {
        regionVolumes.push_back(cell.volume3D());
        regionExterior.push_back(!cell.hasPbc(0) || !cell.hasPbc(1) || !cell.hasPbc(2));
        emptyRegionCount = 1;
    }
    const int regionCount = filledRegionCount + emptyRegionCount;
    // The filled region of each face is the region of the cell it bounds.
    std::vector<int32_t> faceFilledRegion(faceCount);
    for (int face = 0; face < faceCount; ++face) faceFilledRegion[face] = cellRegion[faceCells[face]];
    const int spaceFillingRegion = faceCount ? -1 : 0;
    // Release the tessellation working arrays before the output copies.
    std::vector<int32_t>().swap(cellRegion);
    std::vector<std::array<int32_t, 4>>().swap(cellFaces);
    faceLookup = {};

    alloy_surface_progress("Separate manifolds and smooth the surface", 3, surfaceStages);
    // Make sure every mesh vertex is only part of one surface manifold.
    const int duplicatedVertices = faceCount ? builder.makeManifold() : 0;
    requireSurface(true);
    requireSurface(builder.smoothMesh(smoothingLevel, operation));

    alloy_surface_progress("Measure the surface", 4, surfaceStages);
    regionAreas.assign(regionCount, 0.0);
    double surfaceArea = 0;
    for (int face = 0; face < faceCount; ++face) {
        const auto edge = builder.firstFaceEdge(face);
        const Vector3 e1 = builder.edgeVector(edge), e2 = builder.edgeVector(builder.nextFaceEdge(edge));
        const double area = e1.cross(e2).length() / 2;
        surfaceArea += area;
        regionAreas[faceFilledRegion[face]] += area;
        regionAreas[faceEmptyRegion[face]] += area;
    }
    double filledVolume = 0, emptyVolume = 0, voidVolume = 0;
    int voidRegionCount = 0;
    for (int region = 0; region < regionCount; ++region) {
        if (region < filledRegionCount) { filledVolume += regionVolumes[region]; continue; }
        emptyVolume += regionVolumes[region];
        if (!regionExterior[region - filledRegionCount]) { voidVolume += regionVolumes[region]; ++voidRegionCount; }
    }

    alloy_surface_progress("Collect the surface mesh", 5, surfaceStages);
    const int vertexCount = builder.vertexCount();
    output.vertices.resize(size_t(vertexCount) * 3);
    for (int vertex = 0; vertex < vertexCount; ++vertex)
        for (int axis = 0; axis < 3; ++axis) output.vertices[size_t(vertex) * 3 + axis] = mesh.points[vertex][axis];
    output.vertexParticles.assign(vertexCount, 0);
    output.faces.resize(size_t(faceCount) * 3);
    output.faceRegions.resize(size_t(faceCount) * 2);
    for (int face = 0; face < faceCount; ++face) {
        if ((face & 4095) == 0) requireSurface(true);
        auto edge = builder.firstFaceEdge(face);
        for (int corner = 0; corner < 3; ++corner, edge = builder.nextFaceEdge(edge)) {
            // Vertices duplicated by makeManifold() keep their atom.
            const auto vertex = builder.vertex1(edge);
            output.faces[size_t(face) * 3 + corner] = static_cast<uint32_t>(vertex);
            output.vertexParticles[vertex] = faceAtoms[size_t(face) * 3 + corner];
        }
        if (edge != builder.firstFaceEdge(face)) throw std::runtime_error("The surface mesh contains a face that is not a triangle.");
        output.faceRegions[size_t(face) * 2] = faceFilledRegion[face];
        output.faceRegions[size_t(face) * 2 + 1] = faceEmptyRegion[face];
    }
    output.regions.resize(size_t(regionCount) * 4);
    for (int region = 0; region < regionCount; ++region) {
        const bool filled = region < filledRegionCount;
        output.regions[size_t(region) * 4] = regionVolumes[region];
        output.regions[size_t(region) * 4 + 1] = regionAreas[region];
        output.regions[size_t(region) * 4 + 2] = filled ? 1 : 0;
        output.regions[size_t(region) * 4 + 3] = !filled && regionExterior[region - filledRegionCount] ? 1 : 0;
    }
    std::ostringstream out;
    out << std::setprecision(17);
    out << "{\"algorithm\":\"OVITO alpha shape 3.9.4\",\"radius\":" << radius << ",\"smoothingLevel\":" << smoothingLevel
        << ",\"atomCount\":" << count << ",\"inputCount\":" << inputCount << ",\"tetrahedronCount\":" << tetrahedronCount
        << ",\"filledTetrahedronCount\":" << filledCellCount
        << ",\"vertexCount\":" << vertexCount << ",\"faceCount\":" << faceCount << ",\"duplicatedVertices\":" << duplicatedVertices
        << ",\"surfaceComponentCount\":" << surfaceComponentCount << ",\"regionCount\":" << regionCount
        << ",\"spaceFilling\":" << (spaceFillingRegion == 0 && filledRegionCount > 0 ? "true" : "false")
        << ",\"surfaceArea\":" << surfaceArea << ",\"cellVolume\":" << cell.volume3D()
        << ",\"filledVolume\":" << filledVolume << ",\"emptyVolume\":" << emptyVolume << ",\"voidVolume\":" << voidVolume
        << ",\"filledRegionCount\":" << filledRegionCount << ",\"emptyRegionCount\":" << emptyRegionCount
        << ",\"voidRegionCount\":" << voidRegionCount << '}';
    output.json = out.str();
    alloy_surface_progress("Surface complete", surfaceStages, surfaceStages);
}
}

extern "C" {
const char* alloy_surface_last_error() { return surfaceError.c_str(); }
void alloy_surface_dispose() { output.clear(); }

// Cell vectors are columns of cellData; cellData[9..11] is the origin and
// bits 0 to 2 of pbcBits mark periodic directions, as for alloy_dxa_begin.
// `selection` is null or one byte per atom; unselected atoms are left out.
const char* alloy_surface_construct(const double* coordinates, int count, const double* cellData, int pbcBits,
        const uint8_t* selection, double radius, int smoothingLevel) {
    output.clear();
    surfaceError.clear();
    try {
        constructSurface(coordinates, count, cellData, pbcBits, selection, radius, smoothingLevel);
        return output.json.c_str();
    } catch (...) { saveSurfaceError(); }
    return nullptr;
}
int alloy_surface_vertex_count() { return static_cast<int>(output.vertices.size() / 3); }
int alloy_surface_face_count() { return static_cast<int>(output.faces.size() / 3); }
int alloy_surface_region_count() { return static_cast<int>(output.regions.size() / 4); }
const double* alloy_surface_vertices_ptr() { return output.vertices.data(); }
const uint32_t* alloy_surface_vertex_particles_ptr() { return output.vertexParticles.data(); }
const uint32_t* alloy_surface_faces_ptr() { return output.faces.data(); }
const int32_t* alloy_surface_face_regions_ptr() { return output.faceRegions.data(); }
const double* alloy_surface_regions_ptr() { return output.regions.data(); }
}
