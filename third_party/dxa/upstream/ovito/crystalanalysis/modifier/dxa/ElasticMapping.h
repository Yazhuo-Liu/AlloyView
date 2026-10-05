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
#include <ovito/delaunay/DelaunayTessellation.h>
#include <ovito/core/utilities/MemoryPool.h>
#include <ovito/crystalanalysis/data/Cluster.h>
#include <ovito/crystalanalysis/data/ClusterGraph.h>
#include "StructureAnalysis.h"

namespace Ovito::CrystalAnalysis {

using namespace Ovito::Delaunay;

/**
 * Computes the elastic mapping from the physical configuration to a stress-free reference state.
 */
class ElasticMapping
{
private:

    /// Data structure associated with each edge of the tessellation.
    struct TessellationEdge {

        /// Constructor.
        TessellationEdge(size_t v1, size_t v2) : vertex1(v1), vertex2(v2), clusterTransition(nullptr) {}

        /// The vertex this edge is originating from.
        size_t vertex1;

        /// The vertex this edge is pointing to.
        size_t vertex2;

        /// The vector corresponding to this edge in the stress-free reference configuration.
        Vector3 clusterVector;

        /// The transition matrix when going from the cluster of vertex 1 to the cluster of vertex 2.
        ClusterTransition* clusterTransition;

        /// The next edge in the linked-list of edges leaving vertex 1.
        TessellationEdge* nextLeavingEdge;

        /// The next edge in the linked-list of edges arriving at vertex 1.
        TessellationEdge* nextArrivingEdge;

        /// Returns true if this edge has been assigned an ideal vector in the coordinate system of the local cluster.
        bool hasClusterVector() const { return clusterTransition != nullptr; }

        /// Assigns a vector to this edge.
        /// Also stores the cluster transition that connects the two clusters of the two vertices.
        void assignClusterVector(const Vector3& v, ClusterTransition* transition) {
            clusterVector = v;
            clusterTransition = transition;
        }

        /// Removes the assigned cluster vector.
        void clearClusterVector() {
            clusterTransition = nullptr;
        }
    };

public:

    /// Constructor.
    ElasticMapping(StructureAnalysis& structureAnalysis, DelaunayTessellation& tessellation) :
        _structureAnalysis(structureAnalysis),
        _tessellation(tessellation), _clusterGraph(structureAnalysis.clusterGraph()), _edgeCount(0),
        _edgePool(16384),
        _vertexEdges(structureAnalysis.atomCount(), std::pair<TessellationEdge*,TessellationEdge*>(nullptr,nullptr)),
        _vertexClusters(structureAnalysis.atomCount(), nullptr)
    {}

    /// Returns the structure analysis object.
    const StructureAnalysis& structureAnalysis() const { return _structureAnalysis; }

    /// Returns the underlying tessellation.
    DelaunayTessellation& tessellation() { return _tessellation; }

    /// Returns the underlying tessellation.
    const DelaunayTessellation& tessellation() const { return _tessellation; }

    /// Returns the cluster graph.
    const std::shared_ptr<ClusterGraph>& clusterGraph() const { return _clusterGraph; }

    /// Builds the list of edges in the tetrahedral tessellation.
    bool generateTessellationEdges(ProgressingTask& operation);

    /// Assigns each tessellation vertex to a cluster.
    bool assignVerticesToClusters(ProgressingTask& operation);

    /// Determines the ideal vector corresponding to each edge of the tessellation.
    bool assignIdealVectorsToEdges(int crystalPathSteps, ProgressingTask& operation);

    /// Determines whether the elastic mapping from the physical configuration
    /// of the crystal to the imaginary, stress-free configuration is compatible
    /// within the given tessellation cell. Returns false if the mapping is incompatible
    /// or cannot be determined.
    bool isElasticMappingCompatible(DelaunayTessellation::CellHandle cell) const;

    /// Returns the cluster to which a vertex of the tessellation has been assigned (may be NULL).
    Cluster* clusterOfVertex(size_t vertexIndex) const {
        OVITO_ASSERT(vertexIndex < _vertexClusters.size());
        return _vertexClusters[vertexIndex];
    }

    /// Returns the lattice vector assigned to a tessellation edge.
    std::pair<Vector3, ClusterTransition*> getEdgeClusterVector(size_t vertexIndex1, size_t vertexIndex2) const {
        TessellationEdge* tessEdge = findEdge(vertexIndex1, vertexIndex2);
        OVITO_ASSERT(tessEdge != nullptr);
        OVITO_ASSERT(tessEdge->hasClusterVector());
        if(tessEdge->vertex1 == vertexIndex1)
            return std::make_pair(tessEdge->clusterVector, tessEdge->clusterTransition);
        else
            return std::make_pair(tessEdge->clusterTransition->transform(-tessEdge->clusterVector), tessEdge->clusterTransition->reverse);
    }

private:

    /// Returns the number of tessellation edges.
    size_t edgeCount() const { return _edgeCount; }

    /// Looks up the tessellation edge connecting two tessellation vertices.
    /// Returns NULL if the vertices are not connected by an edge.
    TessellationEdge* findEdge(size_t vertexIndex1, size_t vertexIndex2) const {
        OVITO_ASSERT(vertexIndex1 < _vertexEdges.size());
        OVITO_ASSERT(vertexIndex2 < _vertexEdges.size());
        for(TessellationEdge* e = _vertexEdges[vertexIndex1].first; e != nullptr; e = e->nextLeavingEdge)
            if(e->vertex2 == vertexIndex2) return e;
        for(TessellationEdge* e = _vertexEdges[vertexIndex1].second; e != nullptr; e = e->nextArrivingEdge)
            if(e->vertex1 == vertexIndex2) return e;
        return nullptr;
    }

private:

    /// The structure analysis object.
    StructureAnalysis& _structureAnalysis;

    /// The underlying tessellation of the atomistic system.
    DelaunayTessellation& _tessellation;

    /// The cluster graph.
    const std::shared_ptr<ClusterGraph> _clusterGraph;

    /// Stores the heads of the linked lists of leaving/arriving edges of each vertex.
    std::vector<std::pair<TessellationEdge*,TessellationEdge*>> _vertexEdges;

    /// Memory pool for the creation of TessellationEdge structure instances.
    MemoryPool<TessellationEdge> _edgePool;

    /// Number of tessellation edges on the local processor.
    size_t _edgeCount;

    /// Stores the cluster assigned to each vertex atom of the tessellation.
    std::vector<Cluster*> _vertexClusters;
};

}   // End of namespace
