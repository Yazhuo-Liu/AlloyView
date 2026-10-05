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


#include <ovito/crystalanalysis/CrystalAnalysis.h>
#include <ovito/mesh/surface/SurfaceMeshBuilder.h>
#include "ElasticMapping.h"

namespace Ovito::CrystalAnalysis {

struct BurgersCircuit;              // defined in BurgersCircuit.h
struct BurgersCircuitSearchStruct;  // defined in DislocationTracer.cpp
class DislocationTracer;            // defined in DislocationTracer.h


/**
 * The interface mesh that separates the 'bad' crystal regions from the 'good' crystal regions.
 */
class InterfaceMesh : private DataOORef<SurfaceMesh>, public SurfaceMeshBuilder
{
public:

    struct Edge;

    struct Vertex
    {
        /// This pointer is used during Burgers circuit search on the mesh.
        /// This field is used by the DislocationTracer class.
        BurgersCircuitSearchStruct* burgersSearchStruct = nullptr;

        /// A bit flag used by various algorithms.
        bool visited = false;

        /// Returns the head of the vertex' linked-list of outgoing half-edges.
        Edge* edges() const { return _edges; }

        /// Returns the coordinates of the vertex.
        const Point3& pos() const { return _pos; }

        /// The coordinates of the vertex.
        Point3 _pos;

        /// The head of the linked-list of outgoing half-edges.
        Edge* _edges = nullptr;
    };

    struct Face
    {
        /// The Burgers circuit which has swept this facet.
        /// This field is used by the DislocationTracer class.
        BurgersCircuit* circuit = nullptr;

        /// Returns a pointer to the head of the linked-list of half-edges that bound this face.
        Edge* edges() const { return _edges; }

        /// Replaces all bit flags for this face with new values.
        void setFlags(unsigned int flags) { _flags = flags; }

        /// Tests if a flag is set for this face.
        bool testFlag(unsigned int flag) const { return (_flags & flag); }

        /// Sets a bit flag for this face.
        void setFlag(unsigned int flag) { _flags |= flag; }

        /// Clears a bit flag of this face.
        void clearFlag(unsigned int flag) { _flags &= ~flag; }

        /// Head of the linked-list of half-edges that bound this face.
        Edge* _edges = nullptr;

        /// Bit flags of this face.
        unsigned int _flags = 0;
    };

    struct Edge
    {
        /// The (unwrapped) vector connecting the two vertices.
        Vector3 physicalVector;

        /// The ideal vector in the reference configuration assigned to this edge.
        Vector3 clusterVector;

        /// The cluster transition when going from the cluster of node 1 to the cluster of node 2.
        ClusterTransition* clusterTransition;

        /// The Burgers circuit going through this edge.
        /// This field is used by the DislocationTracer class.
        BurgersCircuit* circuit = nullptr;

        /// If this edge is part of a Burgers circuit, then this points to the next edge in the circuit.
        /// This field is used by the DislocationTracer class.
        Edge* nextCircuitEdge = nullptr;

        /// Returns the vertex this half-edge is coming from.
        Vertex* vertex1() const { return prevFaceEdge()->vertex2(); }

        /// Returns the vertex this half-edge is pointing to.
        Vertex* vertex2() const { return _vertex2; }

        /// Returns a pointer to the face that is adjacent to this half-edge.
        Face* face() const { return _face; }

        /// Returns the next half-edge in the linked-list of half-edges that
        /// leave the same vertex as this edge.
        Edge* nextVertexEdge() const { return _nextVertexEdge; }

        /// Returns the next half-edge in the linked-list of half-edges adjacent to the
        /// same face as this edge.
        Edge* nextFaceEdge() const { return _nextFaceEdge; }

        /// Returns the previous half-edge in the linked-list of half-edges adjacent to the
        /// same face as this edge.
        Edge* prevFaceEdge() const { return _prevFaceEdge; }

        /// Returns a pointer to this edge's opposite half-edge.
        Edge* oppositeEdge() const { return _oppositeEdge; }

        /// The opposite half-edge.
        Edge* _oppositeEdge = nullptr;

        /// The vertex this half-edge is pointing to.
        Vertex* _vertex2;

        /// The face adjacent to this half-edge.
        Face* _face;

        /// The next half-edge in the linked-list of half-edges of the source vertex.
        Edge* _nextVertexEdge;

        /// The next half-edge in the linked-list of half-edges adjacent to the face.
        Edge* _nextFaceEdge;

        /// The previous half-edge in the linked-list of half-edges adjacent to the face.
        Edge* _prevFaceEdge;
    };

public:

    /// Constructor.
    explicit InterfaceMesh(ElasticMapping& elasticMapping) :
        DataOORef<SurfaceMesh>(DataOORef<SurfaceMesh>::create()),
        SurfaceMeshBuilder(this->get()),
        _elasticMapping(elasticMapping) {
            setDomain(elasticMapping.structureAnalysis().cell());
        }

    /// Returns the mapping from the physical configuration of the system
    /// to the stress-free imaginary configuration.
    ElasticMapping& elasticMapping() { return _elasticMapping; }

    /// Returns the mapping from the physical configuration of the system
    /// to the stress-free imaginary configuration.
    const ElasticMapping& elasticMapping() const { return _elasticMapping; }

    /// Returns the underlying tessellation of the atomistic system.
    DelaunayTessellation& tessellation() { return elasticMapping().tessellation(); }

    /// Returns the structure analysis object.
    const StructureAnalysis& structureAnalysis() const { return elasticMapping().structureAnalysis(); }

    /// Creates the mesh facets separating good and bad tetrahedra.
    bool createMesh(FloatType maximumNeighborDistance, BufferReadAccess<int64_t> crystalClusters, ProgressingTask& operation);

    /// Generates the nodes and facets of the defect mesh based on the interface mesh.
    bool generateDefectMesh(const DislocationTracer& tracer, SurfaceMeshBuilder& defectMesh, ProgressingTask& operation);

    /// Returns the list of extra per-vertex infos kept by the interface mesh.
    std::vector<Vertex>& vertices() { return _vertices; }

    /// Returns the list of extra per-edge info kept by the interface mesh.
    std::vector<Edge>& edges() { return _edges; }

    /// Returns the list of extra per-face info kept by the interface mesh.
    std::vector<Face>& faces() { return _faces; }

    /// Clears the given flag for all faces.
    void clearFaceFlag(unsigned int flag) {
        for(Face& face : faces())
            face.clearFlag(flag);
    }

    vertex_index vertexIndex(Vertex* v) const {
        return v - _vertices.data();
    }

private:

    /// The underlying mapping from the physical configuration of the system
    /// to the stress-free imaginary configuration.
    ElasticMapping& _elasticMapping;

    /// Extra per-vertex info kept by the interface mesh.
    std::vector<Vertex> _vertices;

    /// Extra per-edge info kept by the interface mesh.
    std::vector<Edge> _edges;

    /// Extra per-face info kept by the interface mesh.
    std::vector<Face> _faces;
};

}   // End of namespace
