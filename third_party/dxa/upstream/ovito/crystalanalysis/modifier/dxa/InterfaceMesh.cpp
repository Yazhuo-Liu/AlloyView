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

#include <ovito/crystalanalysis/CrystalAnalysis.h>
#include <ovito/delaunay/ManifoldConstructionHelper.h>
#include <ovito/core/utilities/concurrent/Task.h>
#include "InterfaceMesh.h"
#include "DislocationTracer.h"
#include "DislocationAnalysisModifier.h"
#include "DislocationAnalysisEngine.h"

namespace Ovito::CrystalAnalysis {

using namespace Ovito::Delaunay;

/** Find the most common element in the [first, last) range.

    O(n) in time; O(1) in space.

    [first, last) must be valid sorted range.
    Elements must be equality comparable.
*/
template <class ForwardIterator>
ForwardIterator most_common(ForwardIterator first, ForwardIterator last)
{
    ForwardIterator it(first), max_it(first);
    size_t count = 0, max_count = 0;
    for( ; first != last; ++first) {
        if(*it == *first)
            count++;
        else {
            it = first;
            count = 1;
        }
        if(count > max_count) {
            max_count = count;
            max_it = it;
        }
    }
    return max_it;
}

/******************************************************************************
* Creates the mesh facets separating good and bad tetrahedra.
******************************************************************************/
bool InterfaceMesh::createMesh(FloatType maximumNeighborDistance, BufferReadAccess<int64_t> crystalClusters, ProgressingTask& operation)
{
    operation.beginProgressSubSteps(2);

    // Determines if a tetrahedron belongs to the good or bad crystal region.
    auto tetrahedronRegion = [this,&crystalClusters](DelaunayTessellation::CellHandle cell) {
        if(elasticMapping().isElasticMappingCompatible(cell)) {
            if(crystalClusters) {
                std::array<int,4> clusters;
                for(int v = 0; v < 4; v++)
                    clusters[v] = crystalClusters[tessellation().vertexIndex(tessellation().cellVertex(cell, v))];
                std::sort(std::begin(clusters), std::end(clusters));
                return *most_common(std::begin(clusters), std::end(clusters));
            }
            return 0;
        }
        else return SurfaceMesh::InvalidIndex;
    };

    // Transfer cluster vectors from tessellation edges to mesh edges.
    auto prepareMeshFace = [this](face_index face, const std::array<size_t,3>& vertexIndices, const std::array<DelaunayTessellation::VertexHandle,3>& vertexHandles, DelaunayTessellation::CellHandle cell) {
        // Obtain unwrapped vertex positions.
        Point3 vertexPositions[3] = { tessellation().vertexPosition(vertexHandles[0]), tessellation().vertexPosition(vertexHandles[1]), tessellation().vertexPosition(vertexHandles[2]) };

        // Extend the internal per-edge data array.
        _edges.resize(edgeCount());

        edge_index edge = firstFaceEdge(face);
        for(int i = 0; i < 3; i++, edge = nextFaceEdge(edge)) {
            _edges[edge].physicalVector = vertexPositions[(i+1)%3] - vertexPositions[i];

            // Check if edge is spanning more than half of a periodic simulation cell.
            if(this->domain()) {
                for(size_t dim = 0; dim < 3; dim++) {
                    if(this->domain()->hasPbc(dim)) {
                        if(std::abs(this->domain()->inverseMatrix().prodrow(_edges[edge].physicalVector, dim)) >= FloatType(0.5) + FLOATTYPE_EPSILON)
                            StructureAnalysis::generateCellTooSmallError(dim);
                    }
                }
            }

            // Transfer cluster vector from Delaunay edge to interface mesh edge.
            std::tie(_edges[edge].clusterVector, _edges[edge].clusterTransition) = elasticMapping().getEdgeClusterVector(vertexIndices[i], vertexIndices[(i+1)%3]);
        }
    };

    // Threshold for filtering out elements at the surface.
    double alpha = 5.0 * maximumNeighborDistance;

    // Create the 'good' region.
    mutableRegions()->setElementCount(1);
    OVITO_ASSERT(regionCount() == 1);

    // Construct a one-sided surface mesh.
    ManifoldConstructionHelper manifoldConstructor(tessellation(), *this, alpha, false, structureAnalysis().positions());
    if(!manifoldConstructor.construct(tetrahedronRegion, operation, prepareMeshFace))
        return false;

    operation.nextProgressSubStep();

    // Make sure each vertex is only part of a single manifold.
    makeManifold();

    // Allocate the internal per-vertex and per-face data arrays.
    _faces.resize(faceCount());
    _vertices.resize(vertexCount());
    OVITO_ASSERT(edgeCount() == _edges.size());
    BufferReadAccess<Point3> vertexPositions(expectVertexProperty(SurfaceMeshVertices::PositionProperty));
    // Copy the topology from the SurfaceMeshTopology fields to the internal data structures of the InterfaceMesh.
    for(vertex_index v = 0; v < vertexCount(); v++) {
        _vertices[v]._pos = vertexPositions[v];
        if(firstVertexEdge(v) != SurfaceMesh::InvalidIndex)
            _vertices[v]._edges = &_edges[firstVertexEdge(v)];
    }
    for(face_index f = 0; f < faceCount(); f++) {
        if(firstFaceEdge(f) != SurfaceMesh::InvalidIndex)
            _faces[f]._edges = &_edges[firstFaceEdge(f)];
    }
    for(edge_index e = 0; e < edgeCount(); e++) {
        if(hasOppositeEdge(e))
            _edges[e]._oppositeEdge = &_edges[oppositeEdge(e)];
        _edges[e]._vertex2 = &_vertices[vertex2(e)];
        _edges[e]._face = &_faces[adjacentFace(e)];
        _edges[e]._nextFaceEdge = &_edges[nextFaceEdge(e)];
        _edges[e]._prevFaceEdge = &_edges[prevFaceEdge(e)];
        if(nextVertexEdge(e) != SurfaceMesh::InvalidIndex)
            _edges[e]._nextVertexEdge = &_edges[nextVertexEdge(e)];
    }

    // Validate constructed mesh.
#ifdef OVITO_DEBUG
    for(Vertex& vertex : vertices()) {
        int edgeCount = 0;
        for(Edge* edge = vertex.edges(); edge != nullptr; edge = edge->nextVertexEdge()) {
            OVITO_ASSERT(edge->oppositeEdge()->oppositeEdge() == edge);
            OVITO_ASSERT(edge->physicalVector.equals(-edge->oppositeEdge()->physicalVector, CA_ATOM_VECTOR_EPSILON));
            OVITO_ASSERT(edge->clusterTransition == edge->oppositeEdge()->clusterTransition->reverse);
            OVITO_ASSERT(edge->clusterTransition->reverse == edge->oppositeEdge()->clusterTransition);
            OVITO_ASSERT(edge->clusterVector.equals(-edge->oppositeEdge()->clusterTransition->transform(edge->oppositeEdge()->clusterVector), CA_LATTICE_VECTOR_EPSILON));
            OVITO_ASSERT(edge->nextFaceEdge()->prevFaceEdge() == edge);
            OVITO_ASSERT(edge->prevFaceEdge()->nextFaceEdge() == edge);
            OVITO_ASSERT(edge->nextFaceEdge()->nextFaceEdge() == edge->prevFaceEdge());
            OVITO_ASSERT(edge->prevFaceEdge()->prevFaceEdge() == edge->nextFaceEdge());
            edgeCount++;
        }
        OVITO_ASSERT(edgeCount >= 3);

        Edge* edge = vertex.edges();
        do {
            OVITO_ASSERT(edgeCount > 0);
            Edge* nextEdge = edge->oppositeEdge()->nextFaceEdge();
            OVITO_ASSERT(nextEdge->prevFaceEdge()->oppositeEdge() == edge);
            edge = nextEdge;
            edgeCount--;
        }
        while(edge != vertex.edges());
        OVITO_ASSERT(edgeCount == 0);
    }
#endif

    operation.endProgressSubSteps();
    return !operation.isCanceled();
}

/******************************************************************************
* Generates the nodes and facets of the defect mesh based on the interface mesh.
******************************************************************************/
bool InterfaceMesh::generateDefectMesh(const DislocationTracer& tracer, SurfaceMeshBuilder& defectMesh, ProgressingTask& operation)
{
    // Adopt all vertices from the interface mesh.
    BufferReadAccess<Point3> vertexPositions(expectVertexProperty(SurfaceMeshVertices::PositionProperty));
    defectMesh.createVerticesRange(vertexPositions);
    defectMesh.setSpaceFillingRegion(spaceFillingRegion());
    defectMesh.setDomain(domain());

    SurfaceMeshBuilder::VertexGrower vertexGrower(defectMesh);
    SurfaceMeshBuilder::FaceGrower faceGrower(defectMesh);

    // Copy faces and half-edges.
    std::vector<face_index> faceMap(faceCount(), SurfaceMesh::InvalidIndex);
    auto faceMapIter = faceMap.begin();
    std::vector<vertex_index> faceVertices;
    face_index face_o_idx = 0;
    for(InterfaceMesh::Face& face_o : faces()) {

        // Skip parts of the interface mesh that have been swept by a Burgers circuit and are
        // now part of a dislocation line.
        if(face_o.circuit != nullptr) {
            if(face_o.testFlag(1) || face_o.circuit->isDangling == false) {
                ++faceMapIter;
                face_o_idx++;
                continue;
            }
        }

        // Collect the vertices of the current face.
        OVITO_ASSERT(firstFaceEdge(face_o_idx) != SurfaceMesh::InvalidIndex);
        faceVertices.clear();
        edge_index edge_o = firstFaceEdge(face_o_idx);
        do {
            faceVertices.push_back(vertex1(edge_o));
            edge_o = nextFaceEdge(edge_o);
        }
        while(edge_o != firstFaceEdge(face_o_idx));

        // Create a copy of the face in the output mesh.
        *faceMapIter++ = faceGrower.createFace(faceVertices.begin(), faceVertices.end());
        face_o_idx++;
    }

    // Link opposite half-edges.
    auto face_c = faceMap.cbegin();
    for(face_index face_o = 0; face_o < faceMap.size(); face_o++, ++face_c) {
        if(*face_c == SurfaceMesh::InvalidIndex) continue;
        edge_index edge_o = firstFaceEdge(face_o);
        edge_index edge_c = defectMesh.firstFaceEdge(*face_c);
        do {
            OVITO_ASSERT(vertex1(edge_o) == defectMesh.vertex1(edge_c));
            OVITO_ASSERT(vertex2(edge_o) == defectMesh.vertex2(edge_c));
            if(hasOppositeEdge(edge_o) && !defectMesh.hasOppositeEdge(edge_c)) {
                face_index oppositeFace = faceMap[adjacentFace(oppositeEdge(edge_o))];
                if(oppositeFace != SurfaceMesh::InvalidIndex) {
                    edge_index oppositeEdge = defectMesh.findEdge(oppositeFace, defectMesh.vertex2(edge_c), defectMesh.vertex1(edge_c));
                    OVITO_ASSERT(oppositeEdge != SurfaceMesh::InvalidIndex);
                    defectMesh.linkOppositeEdges(edge_c, oppositeEdge);
                }
            }
            edge_o = nextFaceEdge(edge_o);
            edge_c = defectMesh.nextFaceEdge(edge_c);
        }
        while(edge_o != firstFaceEdge(face_o));
    }

    // Generate cap vertices and facets to close holes left by dangling Burgers circuits.
    for(DislocationNode* dislocationNode : tracer.danglingNodes()) {
        BurgersCircuit* circuit = dislocationNode->circuit;
        OVITO_ASSERT(dislocationNode->isDangling());
        OVITO_ASSERT(circuit != nullptr);
        OVITO_ASSERT(circuit->segmentMeshCap.size() >= 2);
        OVITO_ASSERT(circuit->segmentMeshCap[0]->vertex2() == circuit->segmentMeshCap[1]->vertex1());
        OVITO_ASSERT(circuit->segmentMeshCap.back()->vertex2() == circuit->segmentMeshCap.front()->vertex1());

        vertex_index capVertex = vertexGrower.createVertex(dislocationNode->position());
        for(Edge* meshEdge : circuit->segmentMeshCap) {
            vertex_index v1 = vertexIndex(meshEdge->vertex2());
            vertex_index v2 = vertexIndex(meshEdge->vertex1());
            faceGrower.createFace({v1, v2, capVertex});
        }
    }

    // Link dangling half-edges to their opposite edges.
    if(!defectMesh.connectOppositeHalfedges()) {
        OVITO_ASSERT(false);    // Mesh is not closed.
    }

    return true;
}

}   // End of namespace
