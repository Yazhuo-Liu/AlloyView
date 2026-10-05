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

#include "SurfaceMeshTopology.h"

namespace Ovito::Mesh {
void SurfaceMeshTopology::clear()
{
    _vertexEdges.clear();
    _faceEdges.clear();
    _oppositeFaces.clear();
    _edgeFaces.clear();
    _edgeVertices.clear();
    _nextVertexEdges.clear();
    _nextFaceEdges.clear();
    _prevFaceEdges.clear();
    _oppositeEdges.clear();
    _nextManifoldEdges.clear();
}

/******************************************************************************
* Adds several new vertices to the mesh.
* Returns the index of the first newly-created vertex.
******************************************************************************/
SurfaceMeshTopology::vertex_index SurfaceMeshTopology::createVertices(size_type n)
{
    OVITO_ASSERT(n >= 0);
    vertex_index newIndex = vertexCount();
    _vertexEdges.resize(_vertexEdges.size() + n, InvalidIndex);
    return newIndex;
}

/******************************************************************************
* Internal method that creates a new face without edges.
* Returns the index of the new face.
******************************************************************************/
SurfaceMeshTopology::face_index SurfaceMeshTopology::createFace()
{
    face_index newIndex = faceCount();
    _faceEdges.push_back(InvalidIndex);
    _oppositeFaces.push_back(InvalidIndex);
    return newIndex;
}

/******************************************************************************
* Creates a new half-edge between two vertices and adjacent to the given face.
* Returns the index of the new half-edge.
******************************************************************************/
SurfaceMeshTopology::edge_index SurfaceMeshTopology::createEdge(vertex_index vertex1, vertex_index vertex2, face_index face, edge_index insertAfterEdge)
{
    OVITO_ASSERT(vertex1 >= 0 && vertex1 < vertexCount());
    OVITO_ASSERT(vertex2 >= 0 && vertex2 < vertexCount());
    OVITO_ASSERT(face >= 0 && face < faceCount());
    edge_index newIndex = edgeCount();

    // Connect the half-edge to the face.
    _edgeFaces.push_back(face);

    // Connect the half-edge to the second vertex.
    _edgeVertices.push_back(vertex2);

    // Insert the half-edge into the linked-list of edges of the first vertex.
    _nextVertexEdges.push_back(_vertexEdges[vertex1]);
    _vertexEdges[vertex1] = newIndex;

    // Insert the half-edge into the linked-list of edges of the face.
    if(insertAfterEdge == InvalidIndex) {
        edge_index& faceEdge = _faceEdges[face];
        if(faceEdge != InvalidIndex) {
            _nextFaceEdges.push_back(faceEdge);
            _prevFaceEdges.push_back(prevFaceEdge(faceEdge));
            setNextFaceEdge(prevFaceEdge(faceEdge), newIndex);
            setPrevFaceEdge(faceEdge, newIndex);
        }
        else {
            _nextFaceEdges.push_back(newIndex);
            _prevFaceEdges.push_back(newIndex);
            faceEdge = newIndex;
        }
    }
    else {
        OVITO_ASSERT(adjacentFace(insertAfterEdge) == face);
        _nextFaceEdges.push_back(nextFaceEdge(insertAfterEdge));
        _prevFaceEdges.push_back(insertAfterEdge);
        setNextFaceEdge(insertAfterEdge, newIndex);
        setPrevFaceEdge(_nextFaceEdges.back(), newIndex);
    }

    // Initialize opposite edge field.
    _oppositeEdges.push_back(InvalidIndex);

    // Initialize next-manifold field.
    _nextManifoldEdges.push_back(InvalidIndex);

    return newIndex;
}

/******************************************************************************
* Tries to wire each half-edge with its opposite (reverse) half-edge.
* Returns true if every half-edge has an opposite half-edge, i.e. if the mesh
* is closed after this method returns.
******************************************************************************/
bool SurfaceMeshTopology::connectOppositeHalfedges()
{
    bool isClosed = true;
    auto v2 = _edgeVertices.cbegin();
    auto prevFaceEdge = _prevFaceEdges.cbegin();
    edge_index edgeIndex = 0;
    for(edge_index& oppositeEdge : _oppositeEdges) {
        if(oppositeEdge == InvalidIndex) {
            // Search in the edge list of the second vertex for a half-edge that leads back to the first vertex.
            vertex_index vertex1 = vertex2(*prevFaceEdge);
            for(edge_index currentEdge = firstVertexEdge(*v2); currentEdge != InvalidIndex; currentEdge = nextVertexEdge(currentEdge)) {
                if(vertex2(currentEdge) == vertex1 && !hasOppositeEdge(currentEdge)) {
                    // Link the two half-edges together.
                    oppositeEdge = currentEdge;
                    _oppositeEdges[currentEdge] = edgeIndex;
                    break;
                }
            }
            if(oppositeEdge == InvalidIndex)
                isClosed = false;
        }
        else {
            OVITO_ASSERT(_oppositeEdges[oppositeEdge] == edgeIndex);
        }
        ++v2;
        ++prevFaceEdge;
        ++edgeIndex;
    }
    return isClosed;
}

/******************************************************************************
* Links each half-edge leaving from the given vertex to an opposite (reverse)
* half-edge leading back to the vertex.
******************************************************************************/
void SurfaceMeshTopology::connectOppositeHalfedgesAtVertex(vertex_index vert)
{
    for(edge_index edge = firstVertexEdge(vert); edge != InvalidIndex; edge = _nextVertexEdges[edge]) {
        if(hasOppositeEdge(edge)) continue;
        for(edge_index oppositeEdge = firstVertexEdge(vertex2(edge)); oppositeEdge != InvalidIndex; oppositeEdge = _nextVertexEdges[oppositeEdge]) {
            if(vertex2(oppositeEdge) == vert) {
                if(hasOppositeEdge(oppositeEdge)) continue;
                linkOppositeEdges(edge, oppositeEdge);
                break;
            }
        }
        OVITO_ASSERT(hasOppositeEdge(edge));
    }
}

/******************************************************************************
* Disconnects a half-edge from a vertex and adds it to the list of half-edges
* of another vertex. Moves the opposite half-edge to the new vertex as well
* by default.
******************************************************************************/
void SurfaceMeshTopology::transferEdgeToVertex(edge_index edge, vertex_index oldVertex, vertex_index newVertex, bool updateOppositeEdge)
{
    OVITO_ASSERT(edge >= 0 && edge < edgeCount());
    OVITO_ASSERT(oldVertex >= 0 && oldVertex < vertexCount());
    OVITO_ASSERT(newVertex >= 0 && newVertex < vertexCount());
    OVITO_ASSERT(newVertex != oldVertex);
    if(updateOppositeEdge) {
        OVITO_ASSERT(hasOppositeEdge(edge));
        OVITO_ASSERT(_edgeVertices[oppositeEdge(edge)] == oldVertex);
        _edgeVertices[oppositeEdge(edge)] = newVertex;
    }
    removeEdgeFromVertex(oldVertex, edge);
    addEdgeToVertex(newVertex, edge);
}

/******************************************************************************
* Removes a half-edge from a vertex' list of half-edges.
******************************************************************************/
void SurfaceMeshTopology::removeEdgeFromVertex(vertex_index vertex, edge_index edge)
{
    OVITO_ASSERT(edge >= 0 && edge < edgeCount());
    OVITO_ASSERT(vertex >= 0 && vertex < vertexCount());
    edge_index& vertexEdge = _vertexEdges[vertex];
    if(vertexEdge == edge) {
        vertexEdge = _nextVertexEdges[edge];
        _nextVertexEdges[edge] = InvalidIndex;
    }
    else {
        for(edge_index precedingEdge = vertexEdge; precedingEdge != InvalidIndex; precedingEdge = _nextVertexEdges[precedingEdge]) {
            OVITO_ASSERT(precedingEdge != edge);
            if(_nextVertexEdges[precedingEdge] == edge) {
                _nextVertexEdges[precedingEdge] = _nextVertexEdges[edge];
                _nextVertexEdges[edge] = InvalidIndex;
                return;
            }
        }
        OVITO_ASSERT(false); // Half-edge to be removed was not found in the vertex' list of half-edges.
    }
}

/******************************************************************************
* Determines whether the mesh represents a closed two-dimensional manifold,
* i.e., every half-edge is linked to an opposite half-edge.
******************************************************************************/
bool SurfaceMeshTopology::isClosed() const
{
    return std::find(_oppositeEdges.cbegin(), _oppositeEdges.cend(), InvalidIndex) == _oppositeEdges.cend();
}

/******************************************************************************
* Flips the orientation of all faces in the mesh.
******************************************************************************/
void SurfaceMeshTopology::flipFaces()
{
    for(edge_index firstFaceEdge : _faceEdges) {
        if(firstFaceEdge == InvalidIndex) continue;
        edge_index e = firstFaceEdge;
        do {
            transferEdgeToVertex(e, vertex1(e), vertex2(e), false);
            e = nextFaceEdge(e);
        }
        while(e != firstFaceEdge);
        vertex_index v1 = vertex1(e);
        do {
            std::swap(_edgeVertices[e], v1);
            std::swap(_nextFaceEdges[e], _prevFaceEdges[e]);
            e = prevFaceEdge(e);
        }
        while(e != firstFaceEdge);
    }
}


}
