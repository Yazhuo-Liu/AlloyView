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

#include "SurfaceMeshBuilder.h"

namespace Ovito::Mesh {
const PropertyObject* SurfaceMeshBuilder::expectVertexProperty(int) const {
    _positionProperty = std::make_unique<PropertyObject>(_mesh->points.data(), _mesh->points.size(), 3);
    return _positionProperty.get();
}
const PropertyObject* SurfaceMeshBuilder::expectFaceProperty(int) const {
    _faceRegionProperty = std::make_unique<PropertyObject>(_mesh->faceRegions.data(), _mesh->faceRegions.size(), 1, sizeof(region_index));
    return _faceRegionProperty.get();
}

SurfaceMesh::size_type SurfaceMeshBuilder::makeManifold()
{
    VertexGrower vertexGrower(*this);

    size_type numSharedVertices = 0;
    size_type oldVertexCount = vertexCount();

    // Stack of edges of the current manifold still to be visited.
    std::vector<edge_index> edgesToVisit;

    // Edges that have been marked as visited.
    std::vector<bool> visitedEdges(edgeCount(), false);

    for(vertex_index vertex = 0; vertex < oldVertexCount; vertex++) {
        // Count the number of half-edges incident on the current vertex.
        size_type numVertexEdges = vertexEdgeCount(vertex);
        OVITO_ASSERT(numVertexEdges >= 2);

        edge_index firstEdge = firstVertexEdge(vertex);
        size_type numManifoldEdges = 0;

        // Initialize the stack of edges to be visited.
        visitedEdges[firstEdge] = true;
        edgesToVisit.push_back(firstEdge);
        do {
            // Take the next edge from the stack.
            edge_index currentEdge = edgesToVisit.back();
            edgesToVisit.pop_back();

            // Verify integrity of mesh structure.
            OVITO_ASSERT(currentEdge != InvalidIndex); // Mesh must be closed.
            OVITO_ASSERT(adjacentFace(currentEdge) != InvalidIndex); // Every edge must be connected to a face.
            OVITO_ASSERT(prevFaceEdge(currentEdge) != InvalidIndex); // Every edge must be preceded by another edge along the same face.
            OVITO_ASSERT(vertex1(currentEdge) == vertex);   // Edge must be incident on the current vertex.

            // Count the current edge.
            numManifoldEdges++;

            // Visit all manifolds that share the current edge.
            edge_index edge = nextManifoldEdge(currentEdge);
            while(edge != InvalidIndex) {
                if(!visitedEdges[edge]) {
                    // Put the next edge onto the stack.
                    visitedEdges[edge] = true;
                    edgesToVisit.push_back(edge);
                }
                edge = nextManifoldEdge(edge);
                if(edge == currentEdge) break;
            }

            // Go in positive direction around the vertex, facet by facet.
            edge_index nextManifoldEdge = oppositeEdge(prevFaceEdge(currentEdge));
            OVITO_ASSERT(nextManifoldEdge != InvalidIndex);
            if(!visitedEdges[nextManifoldEdge]) {
                // Put the next edge in the current manifold onto the stack.
                visitedEdges[nextManifoldEdge] = true;
                edgesToVisit.push_back(nextManifoldEdge);
            }
        }
        while(!edgesToVisit.empty());

        // If the number of edges in the first manifold is equal to the total number of edges
        // incident on the vertex, then the vertex is not part of separate manifolds and we are done.
        if(numManifoldEdges == numVertexEdges)
            continue;
        OVITO_ASSERT(numManifoldEdges < numVertexEdges);

        // Now identify the other manifolds and create a vertex copy for each.
        do {
            // Create a second vertex that will receive the edges not visited yet.
            // Copy all properties of the original vertex to its duplicate.
            vertex_index newVertex = vertexGrower.copyVertex(vertex);

            // Iterate over the edges of the vertex until we find the next one that
            // hasn't been visited yet. This edge will by used to start the new manifold.
            for(firstEdge = firstVertexEdge(vertex); firstEdge != InvalidIndex; firstEdge = nextVertexEdge(firstEdge)) {
                if(!visitedEdges[firstEdge])
                    break;
            }
            OVITO_ASSERT(firstEdge != InvalidIndex);

            // Initialize the stack of edges to be visited.
            visitedEdges[firstEdge] = true;
            edgesToVisit.push_back(firstEdge);
            do {
                // Take the next edge from the stack.
                edge_index currentEdge = edgesToVisit.back();
                edgesToVisit.pop_back();

                // Verify integrity of mesh structure.
                OVITO_ASSERT(currentEdge != InvalidIndex); // Mesh must be closed.
                OVITO_ASSERT(adjacentFace(currentEdge) != InvalidIndex); // Every edge must be connected to a face.
                OVITO_ASSERT(prevFaceEdge(currentEdge) != InvalidIndex); // Every edge must be preceded by another edge along the same face.

                // Transfer current edge to new vertex.
                OVITO_ASSERT(firstVertexEdge(vertex) != currentEdge);
                mutableTopology()->transferEdgeToVertex(currentEdge, vertex, newVertex);

                // Count the current edge.
                numManifoldEdges++;

                // Visit all manifolds that share the current edge.
                edge_index edge = nextManifoldEdge(currentEdge);
                while(edge != InvalidIndex) {
                    if(!visitedEdges[edge]) {
                        // Put the next edge onto the stack.
                        visitedEdges[edge] = true;
                        edgesToVisit.push_back(edge);
                    }
                    edge = nextManifoldEdge(edge);
                    if(edge == currentEdge) break;
                }

                // Go in positive direction around the vertex, facet by facet.
                edge_index nextManifoldEdge = oppositeEdge(prevFaceEdge(currentEdge));
                OVITO_ASSERT(nextManifoldEdge != InvalidIndex);
                if(!visitedEdges[nextManifoldEdge]) {
                    // Put the next edge in the current manifold onto the stack.
                    visitedEdges[nextManifoldEdge] = true;
                    edgesToVisit.push_back(nextManifoldEdge);
                }
            }
            while(!edgesToVisit.empty());
        }
        while(numManifoldEdges != numVertexEdges);

        numSharedVertices++;
    }

    return numSharedVertices;
}

/******************************************************************************
* Fairs a closed triangle mesh.
******************************************************************************/
bool SurfaceMeshBuilder::smoothMesh(int numIterations, ProgressingTask& task, FloatType k_PB, FloatType lambda)
{
    // This is the implementation of the mesh smoothing algorithm:
    //
    // Gabriel Taubin
    // A Signal Processing Approach To Fair Surface Design
    // In SIGGRAPH 95 Conference Proceedings, pages 351-358 (1995)

    // Performs one iteration of the smoothing algorithm.
    auto smoothMeshIteration = [this](FloatType prefactor) {

        // Compute displacement for each vertex.
        std::vector<Vector3> displacements(vertexCount());
        parallelFor(vertexCount(), [&](vertex_index vertex) {
            Vector3 d = Vector3::Zero();

            // Go in positive direction around vertex, facet by facet.
            edge_index currentEdge = firstVertexEdge(vertex);
            if(currentEdge != InvalidIndex) {
                int numManifoldEdges = 0;
                do {
                    OVITO_ASSERT(currentEdge != InvalidIndex);
                    OVITO_ASSERT(adjacentFace(currentEdge) != InvalidIndex);
                    d += edgeVector(currentEdge);
                    numManifoldEdges++;
                    currentEdge = oppositeEdge(prevFaceEdge(currentEdge));
                }
                while(currentEdge != firstVertexEdge(vertex));
                d *= (prefactor / numManifoldEdges);
            }

            displacements[vertex] = d;
        });

        // Apply computed displacements.
        auto d = displacements.cbegin();
        for(Point3& vertex : _mesh->points)
            vertex += *d++;
    };

    FloatType mu = FloatType(1) / (k_PB - FloatType(1)/lambda);
    task.setProgressMaximum(numIterations);

    for(int iteration = 0; iteration < numIterations; iteration++) {
        if(!task.setProgressValue(iteration))
            return false;
        smoothMeshIteration(lambda);
        smoothMeshIteration(mu);
    }

    return !task.isCanceled();
}
}
