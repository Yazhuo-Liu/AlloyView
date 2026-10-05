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
#include <ovito/core/utilities/concurrent/Task.h>
#include "ElasticMapping.h"
#include "CrystalPathFinder.h"
#include "DislocationTracer.h"
#include "DislocationAnalysisEngine.h"

namespace Ovito::CrystalAnalysis {

// List of vertices that bound the six edges of a tetrahedron.
static const int edgeVertices[6][2] = {{0,1},{0,2},{0,3},{1,2},{1,3},{2,3}};

/******************************************************************************
* Builds the list of edges in the tetrahedral tessellation.
******************************************************************************/
bool ElasticMapping::generateTessellationEdges(ProgressingTask& operation)
{
    operation.setProgressMaximum(tessellation().numberOfPrimaryTetrahedra());

    // Generate list of tessellation edges.
    for(DelaunayTessellation::CellIterator cellIter = tessellation().begin_cells(); cellIter != tessellation().end_cells(); ++cellIter) {
        DelaunayTessellation::CellHandle cell = *cellIter;

        // Skip invalid cells (those not connecting four physical atoms) and ghost cells.
        if(tessellation().isGhostCell(cell)) continue;

        // Update progress indicator.
        if(!operation.setProgressValueIntermittent(tessellation().getCellIndex(cell)))
            return false;

        // Create edge data structure for each of the six edges of the cell.
        for(int edgeIndex = 0; edgeIndex < 6; edgeIndex++) {
            size_t vertex1 = tessellation().vertexIndex(tessellation().cellVertex(cell, edgeVertices[edgeIndex][0]));
            size_t vertex2 = tessellation().vertexIndex(tessellation().cellVertex(cell, edgeVertices[edgeIndex][1]));
            if(vertex1 == vertex2)
                continue;
            Point3 p1 = tessellation().vertexPosition(tessellation().cellVertex(cell, edgeVertices[edgeIndex][0]));
            Point3 p2 = tessellation().vertexPosition(tessellation().cellVertex(cell, edgeVertices[edgeIndex][1]));
            if(structureAnalysis().cell() && structureAnalysis().cell()->isWrappedVector(p1 - p2))
                continue;
            TessellationEdge* edge = findEdge(vertex1, vertex2);
            if(edge == nullptr) {
                // Create a new edge.
                TessellationEdge* edge12 = _edgePool.construct(vertex1, vertex2);
                edge12->nextLeavingEdge = _vertexEdges[vertex1].first;
                _vertexEdges[vertex1].first = edge12;
                edge12->nextArrivingEdge = _vertexEdges[vertex2].second;
                _vertexEdges[vertex2].second = edge12;
                _edgeCount++;
            }
        }
    }

    return !operation.isCanceled();
}

/******************************************************************************
* Assigns each tessellation vertex to a cluster.
******************************************************************************/
bool ElasticMapping::assignVerticesToClusters(ProgressingTask& operation)
{
    // Unknown runtime length.
    operation.setProgressMaximum(0);

    // Assign a cluster to each vertex of the tessellation, which will be used to express
    // reference vectors assigned to the edges leaving the vertex.

    // If an atoms is part of an atomic cluster, then the cluster is also assigned to the corresponding tessellation vertex.
    for(size_t atomIndex = 0; atomIndex < _vertexClusters.size(); atomIndex++) {
        _vertexClusters[atomIndex] = structureAnalysis().atomCluster(atomIndex);
    }

    // Now try to assign a cluster to those vertices of the tessellation whose corresponding atom
    // is not part of a cluster. This is performed by repeatedly copying the cluster assignment
    // from an already assigned vertex to all its unassigned neighbors.
    bool notDone;
    do {
        if(operation.isCanceled())
            return false;

        notDone = false;
        for(size_t vertexIndex = 0; vertexIndex < _vertexClusters.size(); vertexIndex++) {
            if(clusterOfVertex(vertexIndex)->id != 0) continue;
            for(TessellationEdge* e = _vertexEdges[vertexIndex].first; e != nullptr; e = e->nextLeavingEdge) {
                OVITO_ASSERT(e->vertex1 == vertexIndex);
                if(clusterOfVertex(e->vertex2)->id != 0) {
                    _vertexClusters[vertexIndex] = _vertexClusters[e->vertex2];
                    notDone = true;
                    break;
                }
            }
            if(clusterOfVertex(vertexIndex)->id != 0) continue;
            for(TessellationEdge* e = _vertexEdges[vertexIndex].second; e != nullptr; e = e->nextArrivingEdge) {
                OVITO_ASSERT(e->vertex2 == vertexIndex);
                if(clusterOfVertex(e->vertex1)->id != 0) {
                    _vertexClusters[vertexIndex] = _vertexClusters[e->vertex1];
                    notDone = true;
                    break;
                }
            }
        }
    }
    while(notDone);

    return !operation.isCanceled();
}

/******************************************************************************
* Determines the ideal vector corresponding to each edge of the tessellation.
******************************************************************************/
bool ElasticMapping::assignIdealVectorsToEdges(int crystalPathSteps, ProgressingTask& operation)
{
    CrystalPathFinder pathFinder(_structureAnalysis, crystalPathSteps);

    // Try to assign a reference vector to the tessellation edges.
    operation.setProgressMaximum(_vertexEdges.size());
    size_t progressCounter = 0;
    for(const auto& firstEdge : _vertexEdges) {

        if(!operation.setProgressValueIntermittent(progressCounter++))
            return false;

        for(TessellationEdge* edge = firstEdge.first; edge != nullptr; edge = edge->nextLeavingEdge) {
            // Check if the reference vector of this edge has already been determined.
            if(edge->hasClusterVector()) continue;

            Cluster* cluster1 = clusterOfVertex(edge->vertex1);
            Cluster* cluster2 = clusterOfVertex(edge->vertex2);
            OVITO_ASSERT(cluster1 && cluster2);
            if(cluster1->id == 0 || cluster2->id == 0) continue;

            // Determine the ideal vector connecting the two atoms.
            std::optional<ClusterVector> idealVector = pathFinder.findPath(edge->vertex1, edge->vertex2);
            if(!idealVector)
                continue;

            // Translate vector to the frame of the vertex cluster.
            Vector3 localVec;
            if(idealVector->cluster() == cluster1)
                localVec = idealVector->localVec();
            else {
                ClusterTransition* transition = clusterGraph()->determineClusterTransition(idealVector->cluster(), cluster1);
                if(!transition)
                    continue;
                localVec = transition->transform(idealVector->localVec());
            }

            // Assign the cluster transition to the edge.
            ClusterTransition* transition = clusterGraph()->determineClusterTransition(cluster1, cluster2);
            // The two clusters may be part of two disconnected components of the cluster graph.
            if(!transition)
                continue;

            // Assign cluster vector to the edge.
            edge->assignClusterVector(localVec, transition);
        }
    }

#if 0
    _unassignedEdges = new BondsStorage();
    for(const auto& firstEdge : _vertexEdges) {
        for(TessellationEdge* edge = firstEdge.first; edge != nullptr; edge = edge->nextLeavingEdge) {
            if(edge->hasClusterVector()) continue;
            _unassignedEdges->push_back({ Vector_3<int8_t>::Zero(), edge->vertex1, edge->vertex2 });
            _unassignedEdges->push_back({ Vector_3<int8_t>::Zero(), edge->vertex2, edge->vertex1 });
        }
    }
#endif

    return !operation.isCanceled();
}

/******************************************************************************
* Determines whether the elastic mapping from the physical configuration
* of the crystal to the imaginary, stress-free configuration is compatible
* within the given tessellation cell. Returns false if the mapping is incompatible
* or cannot be determined at all.
******************************************************************************/
bool ElasticMapping::isElasticMappingCompatible(DelaunayTessellation::CellHandle cell) const
{
    // Must be a valid tessellation cell to determine the mapping.
    if(!tessellation().isFiniteCell(cell))
        return false;

    // Retrieve the cluster vectors assigned to the six edges of the tetrahedron.
    std::pair<Vector3, ClusterTransition*> edgeVectors[6];
    for(int edgeIndex = 0; edgeIndex < 6; edgeIndex++) {
        size_t vertex1 = tessellation().vertexIndex(tessellation().cellVertex(cell, edgeVertices[edgeIndex][0]));
        size_t vertex2 = tessellation().vertexIndex(tessellation().cellVertex(cell, edgeVertices[edgeIndex][1]));
        TessellationEdge* tessEdge = findEdge(vertex1, vertex2);
        if(!tessEdge || !tessEdge->hasClusterVector())
            return false;
        if(tessEdge->vertex1 == vertex1) {
            edgeVectors[edgeIndex].first = tessEdge->clusterVector;
            edgeVectors[edgeIndex].second = tessEdge->clusterTransition;
        }
        else {
            edgeVectors[edgeIndex].first = tessEdge->clusterTransition->transform(-tessEdge->clusterVector);
            edgeVectors[edgeIndex].second = tessEdge->clusterTransition->reverse;
        }
    }

    static const int circuits[4][3] = { {0,4,2}, {1,5,2}, {0,3,1}, {3,5,4} };

    // Perform the Burgers circuit test on each of the four faces of the tetrahedron.
    for(int face = 0; face < 4; face++) {
        Vector3 burgersVector = edgeVectors[circuits[face][0]].first;
        burgersVector += edgeVectors[circuits[face][0]].second->reverseTransform(edgeVectors[circuits[face][1]].first);
        burgersVector -= edgeVectors[circuits[face][2]].first;
        if(!burgersVector.isZero(CA_LATTICE_VECTOR_EPSILON)) {
            return false;
        }
    }

    // Perform disclination test on each of the four faces.
    for(int face = 0; face < 4; face++) {
        ClusterTransition* t1 = edgeVectors[circuits[face][0]].second;
        ClusterTransition* t2 = edgeVectors[circuits[face][1]].second;
        ClusterTransition* t3 = edgeVectors[circuits[face][2]].second;
        if(!t1->isSelfTransition() || !t2->isSelfTransition() || !t3->isSelfTransition()) {
            Matrix3 frankRotation = t3->reverse->tm * t2->tm * t1->tm;
            if(!frankRotation.equals(Matrix3::Identity(), CA_TRANSITION_MATRIX_EPSILON))
                return false;
        }
    }

    return true;
}

}   // End of namespace
