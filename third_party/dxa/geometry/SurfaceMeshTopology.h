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


#include "compat/compat.h"

namespace Ovito::Mesh {

/**
 * A polygonal mesh stored as a half-edge data structure.
 *
 * Each half-edge is adjacent to one face.
 * Each half-edge has a pointer to the next half-edge adjacent to the same face.
 * Each half-edge has a pointer to its opposite half-edge, unless it forms the boundary of a manifold.
 * Each half-edge has a pointer to the vertex it points to.
 * Each half-edge has a pointer to the next half-edge in the linked list of half-edges originating from the same vertex.
 * Each vertex has a pointer to the first half-edge originating from it.
 * Each face has a pointer to one of the half-edges adjacent to it.
 *
 * Note that this class stores only the topolgy of the mesh, i.e. the connectivty of vertices, half-edges
 * and faces. The embedding of the mesh into three-dimensional space, i.e. the vertex coordinates,
 * are not managed by the class and must be kept in a separate data array.
 */
class SurfaceMeshTopology
{

public:

    /// Data type used for list indices and counting vertices/edges/faces.
    using size_type = int;

    /// Data type used for vertex indices.
    using vertex_index = size_type;

    /// Data type used for edge indices.
    using edge_index = size_type;

    /// Data type used for face indices.
    using face_index = size_type;

    /// Special value used to indicate an invalid list index.
    constexpr static size_type InvalidIndex = -1;

public:

    /// Constructor creating an empty SurfaceMeshTopology object.
    SurfaceMeshTopology() = default;

    /// Removes all faces, edges and vertices from this mesh.
    void clear();

    /// Returns the number of vertices in this mesh.
    size_type vertexCount() const { return _vertexEdges.size(); }

    /// Returns the number of faces in this mesh.
    size_type faceCount() const { return _faceEdges.size(); }

    /// Returns the number of half-edges in this mesh.
    size_type edgeCount() const { return _edgeFaces.size(); }

    /// Adds several new vertices to the mesh.
    /// Returns the index of the first newly-created vertex.
    vertex_index createVertices(size_type n);

    /// Adds a new vertex to the mesh.
    /// Returns the index of the newly-created vertex.
    vertex_index createVertex() { return createVertices(1); }

    /// Internal method that creates a new face without any edges.
    /// Returns the index of the new face.
    face_index createFace();

    /// Creates a new face defined by the given range of vertices.
    /// Half-edges connecting the vertices will be created by this method too.
    /// Returns the index of the newly-created face.
    template<typename VertexIterator>
    face_index createFaceAndEdges(VertexIterator begin, VertexIterator end) {
        // Faces - even degenerate ones - must have at least two vertices.
        OVITO_ASSERT(std::distance(begin, end) >= 2);

        face_index faceIndex = createFace();

        VertexIterator v2 = begin;
        VertexIterator v1 = v2++;
        for(; v2 != end; ++v1, ++v2) {
            createEdge(*v1, *v2, faceIndex);
        }
        createEdge(*v1, *begin, faceIndex);

        // First edge of face should start at first supplied vertex.
        OVITO_ASSERT(firstFaceVertex(faceIndex) == *begin);

        return faceIndex;
    }

    /// Creates a new face defined by the given range of vertices.
    template<typename VertexRange>
    face_index createFaceAndEdges(VertexRange range) {
        return createFaceAndEdges(std::begin(range), std::end(range));
    }

    /// Creates a new face defined by the given range of vertices.
    face_index createFaceAndEdges(std::initializer_list<vertex_index> range) {
        return createFaceAndEdges(std::begin(range), std::end(range));
    }

    /// Creates a new half-edge between two vertices and adjacent to the given face.
    /// Returns the index of the new half-edge.
    edge_index createEdge(vertex_index vertex1, vertex_index vertex2, face_index face, edge_index insertAfterEdge = InvalidIndex);

    /// Creates a new half-edge connecting the two vertices of an existing edge in reverse direction
    /// and which is adjacent to the given face. Returns the index of the new half-edge.
    edge_index createOppositeEdge(edge_index edge, face_index face) {
        OVITO_ASSERT(!hasOppositeEdge(edge));
        edge_index new_e = createEdge(vertex2(edge), vertex1(edge), face);
        _oppositeEdges[edge] = new_e;
        _oppositeEdges[new_e] = edge;
        return new_e;
    }

    /// Tries to wire each half-edge with its opposite (reverse) half-edge.
    /// Returns true if every half-edge has an opposite half-edge, i.e. if the mesh
    /// is closed after this method returns.
    bool connectOppositeHalfedges();

    /// Links each half-edge leaving from the given vertex to an opposite (reverse) half-edge leading back to the vertex.
    void connectOppositeHalfedgesAtVertex(vertex_index vert);

    /// Determines whether the mesh represents a closed two-dimensional manifold,
    /// i.e., every half-edge is linked to an opposite half-edge.
    bool isClosed() const;

    /// Flips the orientation of all faces in the mesh.
    void flipFaces();

    /// Converts the half-edge mesh to a triangle mesh.
    /// Note that this class holds only the mesh topology and no
    /// vertex coordinates. Thus, it is the responsibility of the caller to set the
    /// vertex coordinates for the generated TriMesh.


    /// Deletes a face from the mesh.
    /// A hole in the mesh will be left behind at the location of the deleted face.
    /// The half-edges of the face are also disconnected from their respective opposite half-edges and deleted by this method.


    /// Deletes all faces from the mesh for which the entry in the given mask array is set.
    /// Holes in the mesh will be left behind at the location of the deleted faces.
    /// The half-edges of the faces are also disconnected from their respective opposite half-edges and deleted by this method.


    /// Deletes a vertex from the mesh.
    /// This method assumes that the vertex is not connected to any part of the mesh.


    /// Returns the first edge from a vertex' list of outgoing half-edges.
    edge_index firstVertexEdge(vertex_index vertex) const { OVITO_ASSERT(vertex >= 0 && vertex < vertexCount()); return _vertexEdges[vertex]; }

    /// Returns the half-edge following the given half-edge in the linked list of half-edges of a vertex.
    edge_index nextVertexEdge(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _nextVertexEdges[edge]; }

    /// Returns the first half-edge from the linked-list of half-edges of a face.
    edge_index firstFaceEdge(face_index face) const { OVITO_ASSERT(face >= 0 && face < faceCount()); return _faceEdges[face]; }

    /// Sets the first half-edge from the linked-list of half-edges of a face.
    void setFirstFaceEdge(face_index face, edge_index firstEdge) { OVITO_ASSERT(face >= 0 && face < faceCount()); _faceEdges[face] = firstEdge; }

    /// Returns the list of first half-edges for each face.
    const std::vector<edge_index>& firstFaceEdges() const { return _faceEdges; }

    /// Returns the opposite face of a face.
    face_index oppositeFace(face_index face) const { OVITO_ASSERT(face >= 0 && face < faceCount()); return _oppositeFaces[face]; };

    /// Determines whether the given face is linked to an opposite face.
    bool hasOppositeFace(face_index face) const { return oppositeFace(face) != InvalidIndex; };

    /// Returns the next half-edge following the given half-edge in the linked-list of half-edges of a face.
    edge_index nextFaceEdge(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _nextFaceEdges[edge]; }

    /// Sets the next half-edge following the given half-edge in the linked-list of half-edges of a face.
    void setNextFaceEdge(edge_index edge, edge_index nextEdge) { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); _nextFaceEdges[edge] = nextEdge; }

    /// Returns the previous half-edge preceding the given edge in the linked-list of half-edges of a face.
    edge_index prevFaceEdge(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _prevFaceEdges[edge]; }

    /// Sets the previous half-edge preceding the given edge in the linked-list of half-edges of a face.
    void setPrevFaceEdge(edge_index edge, edge_index prevEdge) { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); _prevFaceEdges[edge] = prevEdge; }

    /// Returns the second half-edge (following the first half-edge) from the linked-list of half-edges of a face.
    edge_index secondFaceEdge(face_index face) const { return nextFaceEdge(firstFaceEdge(face)); }

    /// Returns the vertex the given half-edge is originating from.
    vertex_index vertex1(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return vertex2(_prevFaceEdges[edge]); }

    /// Returns the vertex the given half-edge is leading to.
    vertex_index vertex2(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _edgeVertices[edge]; }

    /// Returns the face which is adjacent to the given half-edge.
    face_index adjacentFace(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _edgeFaces[edge]; }

    /// Sets the face which is adjacent to the given half-edge.
    void setAdjacentFace(edge_index edge, face_index face) { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); _edgeFaces[edge] = face; }

    /// Returns the first vertex from the contour of a face.
    vertex_index firstFaceVertex(face_index face) const { return vertex1(firstFaceEdge(face)); }

    /// Returns the second vertex from the contour of a face.
    vertex_index secondFaceVertex(face_index face) const { return vertex2(firstFaceEdge(face)); }

    /// Returns the third vertex from the contour of a face.
    vertex_index thirdFaceVertex(face_index face) const { return vertex2(secondFaceEdge(face)); }

    /// Returns the opposite half-edge of the given edge.setNextManifoldEdge
    edge_index oppositeEdge(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _oppositeEdges[edge]; }

    /// Returns whether the given half-edge has an opposite half-edge.
    bool hasOppositeEdge(edge_index edge) const { return oppositeEdge(edge) != InvalidIndex; }

    /// Sets the opposite half-edge of a half-edge.
    void setOppositeEdge(edge_index edge, edge_index oppositeEdge) { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); _oppositeEdges[edge] = oppositeEdge; }

    /// Returns the next incident manifold when going around the given half-edge.
    edge_index nextManifoldEdge(edge_index edge) const { OVITO_ASSERT(edge >= 0 && edge < edgeCount()); return _nextManifoldEdges[edge]; };

    /// Sets what is the next incident manifold when going around the given half-edge.
    void setNextManifoldEdge(edge_index edge, edge_index nextManifoldEdge) {
        OVITO_ASSERT(edge >= 0 && edge < edgeCount());
        OVITO_ASSERT(nextManifoldEdge == InvalidIndex || vertex1(edge) == vertex1(nextManifoldEdge));
        OVITO_ASSERT(nextManifoldEdge == InvalidIndex || vertex2(edge) == vertex2(nextManifoldEdge));
        _nextManifoldEdges[edge] = nextManifoldEdge;
    }

    /// Links two opposite half-edges together.
    void linkOppositeEdges(edge_index edge1, edge_index edge2) {
        OVITO_ASSERT(vertex1(edge1) == vertex2(edge2));
        OVITO_ASSERT(vertex2(edge1) == vertex1(edge2));
        OVITO_ASSERT(!hasOppositeEdge(edge1));
        OVITO_ASSERT(!hasOppositeEdge(edge2));
        _oppositeEdges[edge1] = edge2;
        _oppositeEdges[edge2] = edge1;
    }

    /// Links two opposite faces together.
    void linkOppositeFaces(face_index face1, face_index face2) {
        OVITO_ASSERT((!hasOppositeFace(face1) && !hasOppositeFace(face2)) || (oppositeFace(face1) == face2 && oppositeFace(face2) == face1));
        OVITO_ASSERT(areOppositeFaces(face1, face2));
        _oppositeFaces[face1] = face2;
        _oppositeFaces[face2] = face1;
    }

    /// Tests if two faces connect the same sequence of vertices in reverse order.
    bool areOppositeFaces(face_index face1, face_index face2) const {
        edge_index ffe = firstFaceEdge(face1);
        edge_index opposite_edge = findEdge(face2, vertex2(ffe), vertex1(ffe));
        if(opposite_edge == InvalidIndex)
            return false;
        edge_index e = ffe;
        do {
            e = nextFaceEdge(e);
            opposite_edge = prevFaceEdge(opposite_edge);
            if(vertex2(e) != vertex1(opposite_edge))
                return false;
            OVITO_ASSERT(vertex1(e) == vertex2(opposite_edge));
        }
        while(e != ffe);
        return true;
    }

    /// Unlinks two opposite faces.
    void unlinkFromOppositeFace(face_index face1) {
        OVITO_ASSERT(hasOppositeFace(face1));
        face_index face2 = oppositeFace(face1);
        OVITO_ASSERT(oppositeFace(face2) == face1);
        _oppositeFaces[face1] = InvalidIndex;
        _oppositeFaces[face2] = InvalidIndex;
    }

    /// Counts the number of outgoing half-edges adjacent to the given mesh vertex.
    size_type vertexEdgeCount(vertex_index vertex) const {
        OVITO_ASSERT(vertex >= 0 && vertex < vertexCount());
        size_type numEdges = 0;
        for(edge_index currentEdge = _vertexEdges[vertex]; currentEdge != InvalidIndex; currentEdge = _nextVertexEdges[currentEdge])
            numEdges++;
        return numEdges;
    }

    /// Searches the half-edges of a face for one connecting the two given vertices.
    edge_index findEdge(face_index face, vertex_index v1, vertex_index v2) const {
        edge_index ffe = firstFaceEdge(face);
        edge_index e = ffe;
        vertex_index ev1 = vertex1(e);
        do {
            vertex_index ev2 = vertex2(e);
            if(ev1 == v1 && ev2 == v2) return e;
            e = nextFaceEdge(e);
            ev1 = ev2;
        }
        while(e != ffe);
        return InvalidIndex;
    }

    /// Transfers a segment of a face boundary, formed by the given edge and its successor edge,
    /// to a different vertex.
    void transferFaceBoundaryToVertex(edge_index edge, vertex_index newVertex) {
        OVITO_ASSERT(newVertex >= 0 && newVertex < vertexCount());
        vertex_index oldVertex = vertex2(edge);
        if(newVertex != oldVertex) {
            removeEdgeFromVertex(oldVertex, nextFaceEdge(edge));
            addEdgeToVertex(newVertex, nextFaceEdge(edge));
            _edgeVertices[edge] = newVertex;
        }
    }

    /// Determines the number of manifolds adjacent to a half-edge.
    int countManifolds(edge_index edge) const {
        edge_index e = nextManifoldEdge(edge);
        if(e == InvalidIndex) return 0;
        int count = 1;
        for(; e != edge; e = nextManifoldEdge(e)) {
            OVITO_ASSERT(e != InvalidIndex);
            count++;
        }
        return count;
    }

    /// Computes the number of edges (as well as vertices) of a face.
    size_type countFaceEdges(face_index face) const {
        return faceEdgeCount(firstFaceEdge(face));
    }

    /// Inserts a vertex in the midle of an existing edge.


protected:

    /// Creates a copy of this object.


public:

    /// Disconnects a half-edge from a vertex and adds it to the list of half-edges of another vertex.
    /// Moves the opposite half-edge to the new vertex as well by default.
    void transferEdgeToVertex(edge_index edge, vertex_index oldVertex, vertex_index newVertex, bool updateOppositeEdge = true);

    /// Removes a half-edge from a vertex' list of half-edges.
    void removeEdgeFromVertex(vertex_index vertex, edge_index edge);

    /// Adds a half-edge to a vertex.
    void addEdgeToVertex(vertex_index vertex, edge_index edge) {
        OVITO_ASSERT(edge >= 0 && edge < edgeCount());
        OVITO_ASSERT(vertex >= 0 && vertex < vertexCount());
        OVITO_ASSERT(_nextVertexEdges[edge] == InvalidIndex);
        _nextVertexEdges[edge] = _vertexEdges[vertex];
        _vertexEdges[vertex] = edge;
    }

    /// Computes the number of edges (as well as vertices) of a face.
    size_type faceEdgeCount(edge_index firstFaceEdge) const {
        size_type c = 0;
        edge_index e = firstFaceEdge;
        do {
            OVITO_ASSERT(e >= 0 && e < edgeCount());
            c++;
            e = _nextFaceEdges[e];
        }
        while(e != firstFaceEdge);
        return c;
    }

    /// Deletes a half-edge from the mesh.
    /// This method assumes that the half-edge is not connected to any part of the mesh.
    /// Returns the successor edge along the face's boundary.


    /// Deletes all half-edges from the mesh for which the bit is set in the given mask array.


    ///////////////// Per vertex data //////////////////

    /// Stores the first half-edge of each vertex.
    std::vector<edge_index> _vertexEdges;

    /////////////////// Per face data ///////////////////

    /// Stores the index of the first half-edge of each face.
    std::vector<edge_index> _faceEdges;

    /// Stores the index of the opposite face of each face.
    std::vector<face_index> _oppositeFaces;

    /////////////// Per half-edge data //////////////////

    /// Stores the index of the face of each half-edge.
    std::vector<face_index> _edgeFaces;

    /// Stores the second vertex of each half-edge.
    std::vector<vertex_index> _edgeVertices;

    /// Stores the next half-edge in the linked list of half-edges of a vertex.
    std::vector<edge_index> _nextVertexEdges;

    /// Stores the next half-edge in the linked list of half-edges of a face.
    std::vector<edge_index> _nextFaceEdges;

    /// Stores the predecessor half-edge in the linked list of half-edges of a face.
    std::vector<edge_index> _prevFaceEdges;

    /// Stores the opposite half-edge of each half-edge.
    std::vector<edge_index> _oppositeEdges;

    /// Stores the half-edge leading to the next manifold at each half-edge.
    std::vector<edge_index> _nextManifoldEdges;

    friend class SurfaceMeshBuilder;
};

}   // End of namespace
