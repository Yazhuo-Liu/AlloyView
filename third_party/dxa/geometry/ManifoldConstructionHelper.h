////////////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2023 OVITO GmbH, Germany
//
//  This file is part of OVITO (Open Visualization Tool).
//
//  OVITO is free software; you can redistribute it and/or modify it either under the
//  terms of the GNU General Public License version 3 as published by the Free Software
//  Foundation (the "GPL") or, at your option, under the terms of the MIT License.
//  If you do not alter this notice, a recipient may use your version of this
//  file under either the GPL or the MIT License.
//
//  You should have received a copy of the GPL along with this program in a
//  file LICENSE.GPL.txt.  You should have received a copy of the MIT License along
//  with this program in a file LICENSE.MIT.txt
//
//  This software is distributed on an "AS IS" basis, WITHOUT WARRANTY OF ANY KIND,
//  either express or implied. See the GPL or the MIT License for the specific language
//  governing rights and limitations.
//
////////////////////////////////////////////////////////////////////////////////////////

#pragma once
#include "DelaunayTessellation.h"
#include "SurfaceMeshBuilder.h"

namespace Ovito::Delaunay {
using namespace Ovito::Mesh;
// Headless port of the upstream one-sided DXA manifold path. The generic
// two-sided volume/region analysis and convex hull clipping are not used by DXA.
class ManifoldConstructionHelper {
public:
    struct DefaultPrepareMeshFaceFunc {
        void operator()(SurfaceMesh::face_index, const std::array<size_t,3>&,
            const std::array<DelaunayTessellation::VertexHandle,3>&, DelaunayTessellation::CellHandle) {}
    };
    struct DefaultPrepareMeshVertexFunc {
        void operator()(SurfaceMesh::vertex_index, size_t) {}
    };
    ManifoldConstructionHelper(DelaunayTessellation& tess, SurfaceMeshBuilder& mesh, FloatType alpha,
        bool createRegions, BufferReadAccess<Point3> positions) : _tessellation(tess), _mesh(mesh),
        _alpha(alpha), _positions(positions) {
        if(createRegions) throw Exception("The headless DXA manifold builder supports one-sided meshes only.");
    }
    template<typename CellRegionFunc, typename PrepareMeshFaceFunc = DefaultPrepareMeshFaceFunc,
        typename PrepareMeshVertexFunc = DefaultPrepareMeshVertexFunc>
    bool construct(CellRegionFunc&& region, ProgressingTask& op,
        PrepareMeshFaceFunc&& prepareFace = PrepareMeshFaceFunc(),
        PrepareMeshVertexFunc&& prepareVertex = PrepareMeshVertexFunc()) {
        op.beginProgressSubStepsWithWeights({1,1,2});
        if(!classifyTetrahedra(std::move(region), op)) return false;
        op.nextProgressSubStep();
        if(!createInterfaceFacets(std::move(prepareFace), std::move(prepareVertex), op)) return false;
        op.nextProgressSubStep();
        if(!linkHalfedges(op)) return false;
        op.endProgressSubSteps();
        return !op.isCanceled();
    }
private:
    template<typename CellRegionFunc>
    bool classifyTetrahedra(CellRegionFunc&& determineCellRegion, ProgressingTask& operation)
    {
        operation.setProgressMaximum(_tessellation.numberOfTetrahedra());

        _numFilledCells = 0;
        size_t progressCounter = 0;
        _mesh.setSpaceFillingRegion(SurfaceMesh::InvalidIndex);
        bool spaceFillingRegionUndetermined = true;
        bool isSpaceFilling = true;
        for(DelaunayTessellation::CellIterator cellIter = _tessellation.begin_cells(); cellIter != _tessellation.end_cells(); ++cellIter) {
            DelaunayTessellation::CellHandle cell = *cellIter;

            // Update progress indicator.
            if(!operation.setProgressValueIntermittent(progressCounter++))
                return false;

            // Alpha-shape criterion: This determines whether the Delaunay tetrahedron is part of a filled region.
            bool isFilledTetrehedron = false;
            if(_tessellation.isFiniteCell(cell)) {
                if(auto alphaTestResult = _tessellation.alphaTest(cell, _alpha)) {
                    isFilledTetrehedron = *alphaTestResult;
                }
                else {
                    // If the alpha test is inconclusive (which may happen if the element is a sliver tetrahedron),
                    // then we check the surrounding tetrahedra. Only if all four neighbors are classified as filled or inconclusive,
                    // then we accept the sliver tetradron as filled too.
                    int f = 0;
                    for(; f < 4; f++) {
                        DelaunayTessellation::CellHandle adjacentCell = _tessellation.mirrorFacet(cell, f).first;
                        if(!_tessellation.isFiniteCell(adjacentCell))
                            break;
                        auto adjacentAlphaTestResult = _tessellation.alphaTest(adjacentCell, _alpha);
                        if(adjacentAlphaTestResult && !*adjacentAlphaTestResult)
                            break;
                    }
                    if(f == 4)
                        isFilledTetrehedron = true;
                }
            }

            SurfaceMesh::region_index region = SurfaceMesh::InvalidIndex;
            if(isFilledTetrehedron) {
                region = determineCellRegion(cell);
                OVITO_ASSERT(region >= 0 || region == SurfaceMesh::InvalidIndex);
                
                OVITO_ASSERT(region < _mesh.regionCount() || region == SurfaceMesh::InvalidIndex);
            }
            _tessellation.setUserField(cell, region);

            if(!_tessellation.isGhostCell(cell)) {
                if(spaceFillingRegionUndetermined) {
                    _mesh.setSpaceFillingRegion(region);
                    spaceFillingRegionUndetermined = false;
                }
                else {
                    if(isSpaceFilling && _mesh.spaceFillingRegion() != region) {
                        _mesh.setSpaceFillingRegion(SurfaceMesh::InvalidIndex);
                        isSpaceFilling = false;
                    }
                }
            }

            if(region != SurfaceMesh::InvalidIndex && !_tessellation.isGhostCell(cell)) {
                _tessellation.setCellIndex(cell, _numFilledCells++);
            }
            else {
                _tessellation.setCellIndex(cell, -1);
            }
        }

        return !operation.isCanceled();
    }

    template<typename PrepareMeshFaceFunc, typename PrepareMeshVertexFunc>
    bool createInterfaceFacets(PrepareMeshFaceFunc&& prepareMeshFaceFunc, PrepareMeshVertexFunc&& prepareMeshVertexFunc, ProgressingTask& operation)
    {
        // Stores the triangle mesh vertices created for the vertices of the tetrahedral mesh.
        std::vector<SurfaceMesh::vertex_index> vertexMap(_positions.size(), SurfaceMesh::InvalidIndex);
        _tetrahedraFaceList.clear();
        _faceLookupMap.clear();

        // Create the vertex coordinates array, which will dynamically grow.
        std::vector<Point3> vertexPositions;

        // Create the per-face region array, which will dynamically grow.
        std::vector<SurfaceMesh::region_index> faceRegions;

        operation.setProgressMaximum(_numFilledCells);
        SurfaceMeshTopology* topo = _mesh.mutableTopology();

        for(DelaunayTessellation::CellIterator cellIter = _tessellation.begin_cells(); cellIter != _tessellation.end_cells(); ++cellIter) {
            DelaunayTessellation::CellHandle cell = *cellIter;

            // Consider only filled local tetrahedra.
            if(_tessellation.getCellIndex(cell) == -1)
                continue;
            SurfaceMesh::region_index filledRegion = _tessellation.getUserField(cell);
            OVITO_ASSERT(filledRegion != SurfaceMesh::InvalidIndex);

            // Update progress indicator.
            if(!operation.setProgressValueIntermittent(_tessellation.getCellIndex(cell)))
                return false;

            Point3 unwrappedVerts[4];
            for(int i = 0; i < 4; i++)
                unwrappedVerts[i] = _tessellation.vertexPosition(_tessellation.cellVertex(cell, i));

            // Check validity of tessellation.
            // Delaunay edges (of filled tetrahedro) should never span more than half of the simulation box in periodic directions.
            Vector3 ad = unwrappedVerts[0] - unwrappedVerts[3];
            Vector3 bd = unwrappedVerts[1] - unwrappedVerts[3];
            Vector3 cd = unwrappedVerts[2] - unwrappedVerts[3];
            if(_tessellation.simCell()->isWrappedVector(ad) || _tessellation.simCell()->isWrappedVector(bd) || _tessellation.simCell()->isWrappedVector(cd))
                throw Exception("Cannot construct manifold. Simulation cell length is too small for the given probe sphere radius parameter.");

            // Iterate over the four faces of the tetrahedron cell.
            _tessellation.setCellIndex(cell, -1);
            for(int f = 0; f < 4; f++) {

                // Check if the adjacent tetrahedron belongs to a different region.
                std::pair<DelaunayTessellation::CellHandle,int> mirrorFacet = _tessellation.mirrorFacet(cell, f);
                DelaunayTessellation::CellHandle adjacentCell = mirrorFacet.first;
                if(_tessellation.getUserField(adjacentCell) == filledRegion)
                    continue;

                // Create the three vertices of the face or use existing output vertices.
                std::array<SurfaceMesh::vertex_index,3> facetVertices;
                std::array<DelaunayTessellation::VertexHandle,3> vertexHandles;
                std::array<size_t,3> vertexIndices;
                for(int v = 0; v < 3; v++) {
                    vertexHandles[v] = _tessellation.cellVertex(cell, DelaunayTessellation::cellFacetVertexIndex(f, _flipOrientation ? v : (2-v)));
                    size_t vertexIndex = vertexIndices[v] = _tessellation.vertexIndex(vertexHandles[v]);
                    OVITO_ASSERT(vertexIndex < vertexMap.size());
                    if(vertexMap[vertexIndex] == SurfaceMesh::InvalidIndex) {
                        vertexMap[vertexIndex] = topo->createVertex();
                        vertexPositions.push_back(_positions[vertexIndex]);
                        prepareMeshVertexFunc(vertexMap[vertexIndex], vertexIndex);
                    }
                    facetVertices[v] = vertexMap[vertexIndex];
                }

                // Create a new triangle facet.
                SurfaceMesh::face_index face = topo->createFaceAndEdges(facetVertices.begin(), facetVertices.end());
                faceRegions.push_back(filledRegion);

                // Tell client code about the new facet.
                prepareMeshFaceFunc(face, vertexIndices, vertexHandles, cell);

                // Create additional face for exterior region if requested.
                

                // Insert new facet into lookup map.
                reorderFaceVertices(vertexIndices);
                _faceLookupMap.emplace(vertexIndices, face);

                // Insert into contiguous list of tetrahedron faces.
                if(_tessellation.getCellIndex(cell) == -1) {
                    _tessellation.setCellIndex(cell, _tetrahedraFaceList.size());
                    _tetrahedraFaceList.push_back(std::array<SurfaceMesh::face_index, 4>{{ SurfaceMesh::InvalidIndex, SurfaceMesh::InvalidIndex, SurfaceMesh::InvalidIndex, SurfaceMesh::InvalidIndex }});
                }
                _tetrahedraFaceList[_tessellation.getCellIndex(cell)][f] = face;
            }
        }

        // Store the vertex coordinates in the mesh.
        _mesh.setVertexPositions(std::move(vertexPositions));

        // Store the per-face region information in the mesh.
        _mesh.setFaceRegions(std::move(faceRegions));

        return !operation.isCanceled();
    }

    SurfaceMesh::face_index findAdjacentFace(DelaunayTessellation::CellHandle cell, int f, int e, bool reverse = false)
    {
        int vertexIndex1, vertexIndex2;
        if(!_flipOrientation) {
            vertexIndex1 = DelaunayTessellation::cellFacetVertexIndex(f, 2-e);
            vertexIndex2 = DelaunayTessellation::cellFacetVertexIndex(f, (4-e)%3);
        }
        else {
            vertexIndex1 = DelaunayTessellation::cellFacetVertexIndex(f, (e+1)%3);
            vertexIndex2 = DelaunayTessellation::cellFacetVertexIndex(f, e);
        }
        DelaunayTessellation::FacetCirculator circulator_start = _tessellation.incident_facets(cell, vertexIndex1, vertexIndex2, cell, f);
        DelaunayTessellation::FacetCirculator circulator = circulator_start;
        OVITO_ASSERT((*circulator).first == cell);
        OVITO_ASSERT((*circulator).second == f);
        int region = _tessellation.getUserField(cell);
        if(!reverse) {
            --circulator;
            OVITO_ASSERT(circulator != circulator_start);
            do {
                // Look for the first cell while going around the edge that belongs to a different region.
                if(_tessellation.getUserField((*circulator).first) != region)
                    break;
                --circulator;
            }
            while(circulator != circulator_start);
            OVITO_ASSERT(circulator != circulator_start);
        }
        else {
            ++circulator;
            OVITO_ASSERT(circulator != circulator_start);
            for(;;) {
                // Look for the first cell while going around the edge in reverse direction that belongs to the same region.
                if(_tessellation.getUserField((*circulator).first) == region)
                    break;
                ++circulator;
            }
            --circulator;
        }

        // Get the current adjacent cell, which is part of the same region as the first tet.
        std::pair<DelaunayTessellation::CellHandle,int> mirrorFacet = _tessellation.mirrorFacet(*circulator);
        OVITO_ASSERT(_tessellation.getUserField(mirrorFacet.first) == region);

        SurfaceMesh::face_index adjacentFace = findCellFace(mirrorFacet);
        OVITO_ASSERT(adjacentFace != SurfaceMesh::InvalidIndex);
        if(adjacentFace == SurfaceMesh::InvalidIndex)
            throw Exception("Cannot construct mesh for this input dataset. Adjacent cell face not found.");
        return adjacentFace;
    }

    bool linkHalfedges(ProgressingTask& operation)
    {
        operation.setProgressMaximum(_tetrahedraFaceList.size());

#ifdef OVITO_DEBUG
        BufferReadAccess<SurfaceMesh::region_index> faceRegions(_mesh.expectFaceProperty(SurfaceMeshFaces::RegionProperty));
#endif

        auto tet = _tetrahedraFaceList.cbegin();
        for(DelaunayTessellation::CellIterator cellIter = _tessellation.begin_cells(); cellIter != _tessellation.end_cells(); ++cellIter) {
            DelaunayTessellation::CellHandle cell = *cellIter;

            // Look for filled cells being adjacent to at least one mesh face.
            if(_tessellation.getCellIndex(cell) == -1) continue;
            OVITO_ASSERT(_tetrahedraFaceList.cbegin() + _tessellation.getCellIndex(cell) == tet);

            // Update progress indicator.
            if(!operation.setProgressValueIntermittent(_tessellation.getCellIndex(cell)))
                return false;

            // Visit the mesh faces adjacent to the current cell.
            for(int f = 0; f < 4; f++) {
                SurfaceMesh::face_index facet = (*tet)[f];
                if(facet == SurfaceMesh::InvalidIndex) continue;

                // Link within manifold.
                SurfaceMesh::edge_index edge = _mesh.firstFaceEdge(facet);
                for(int e = 0; e < 3; e++, edge = _mesh.nextFaceEdge(edge)) {
                    if(_mesh.hasOppositeEdge(edge)) continue;
                    SurfaceMesh::face_index adjacentFace = findAdjacentFace(cell, f, e);
                    SurfaceMesh::edge_index oppositeEdge = _mesh.findEdge(adjacentFace, _mesh.vertex2(edge), _mesh.vertex1(edge));
                    if(oppositeEdge == SurfaceMesh::InvalidIndex)
                        throw Exception("Cannot construct mesh for this input dataset. Opposite half-edge not found.");
                    _mesh.linkOppositeEdges(edge, oppositeEdge);
                }

                
            }
            ++tet;
        }
        OVITO_ASSERT(tet == _tetrahedraFaceList.cend());
        OVITO_ASSERT(_mesh.topology()->isClosed());

        // Set up manifold pointers at edges of the mesh.
        

        return !operation.isCanceled();
    }

    SurfaceMesh::face_index findCellFace(const std::pair<DelaunayTessellation::CellHandle,int>& facet)
    {
        // If the cell is a ghost cell, find the corresponding real cell first.
        auto cell = facet.first;
        if(_tessellation.getCellIndex(cell) != -1) {
            OVITO_ASSERT(_tessellation.getCellIndex(cell) >= 0 && _tessellation.getCellIndex(cell) < (qint64)_tetrahedraFaceList.size());
            return _tetrahedraFaceList[_tessellation.getCellIndex(cell)][facet.second];
        }
        else {
            std::array<size_t,3> faceVerts;
            for(size_t i = 0; i < 3; i++) {
                int vertexIndex = DelaunayTessellation::cellFacetVertexIndex(facet.second, _flipOrientation ? i : (2-i));
                faceVerts[i] = _tessellation.vertexIndex(_tessellation.cellVertex(cell, vertexIndex));
            }
            reorderFaceVertices(faceVerts);
            if(auto item = _faceLookupMap.find(faceVerts); item != _faceLookupMap.end())
                return item->second;
            else
                return SurfaceMesh::InvalidIndex;
        }
    }

    static void reorderFaceVertices(std::array<size_t,3>& vertexIndices) {
#if !defined(Q_OS_MACOS) && !defined(Q_OS_WASM)
        // Shift the order of vertices so that the smallest index is at the front.
        std::rotate(std::begin(vertexIndices), std::min_element(std::begin(vertexIndices), std::end(vertexIndices)), std::end(vertexIndices));
#else
        // Workaround for compiler bug in Xcode 10.0. Clang hangs when compiling the code above with -O2/-O3 flag.
        auto min_index = std::min_element(vertexIndices.begin(), vertexIndices.end()) - vertexIndices.begin();
        std::rotate(vertexIndices.begin(), vertexIndices.begin() + min_index, vertexIndices.end());
#endif
    }
    DelaunayTessellation& _tessellation;
    SurfaceMeshBuilder& _mesh;
    FloatType _alpha;
    BufferReadAccess<Point3> _positions;
    bool _flipOrientation = false;
    size_t _numFilledCells = 0;
    std::vector<std::array<SurfaceMesh::face_index, 4>> _tetrahedraFaceList;
    std::map<std::array<size_t,3>, SurfaceMesh::face_index> _faceLookupMap;
};
}
