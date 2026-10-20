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

    using EdgeIndex = uint32_t;
    static constexpr EdgeIndex InvalidEdge = std::numeric_limits<EdgeIndex>::max();

    // Immutable endpoints live in the compact adjacency rows, not in every
    // payload. A lookup scans only neighbor IDs before fetching the vector.
    struct AdjacentEdge {
        uint32_t vertex;
        EdgeIndex edge;
    };
    struct TessellationEdge {
        Vector3 clusterVector;
        ClusterTransition* clusterTransition = nullptr;
        bool hasClusterVector() const { return clusterTransition != nullptr; }
        void assignClusterVector(const Vector3& v, ClusterTransition* transition) {
            clusterVector = v;
            clusterTransition = transition;
        }
    };

    // The index is stable after generation. Bounded parallel path batches
    // carry their source vertex and adjacency slot, without copying vectors.
    struct EdgeWork {
        uint32_t vertex1;
        uint32_t adjacency;
    };

public:

    /// Constructor.
    ElasticMapping(StructureAnalysis& structureAnalysis, DelaunayTessellation& tessellation) :
        _structureAnalysis(structureAnalysis),
        _tessellation(tessellation), _clusterGraph(structureAnalysis.clusterGraph()),
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

    // Read-only CPU Worker snapshot traversal; native mapping ownership stays here.
    size_t workerEdgeCount() const { return _edges.size(); }
    size_t compactEdgeBytes() const {
        return _edges.capacity() * sizeof(TessellationEdge) + _adjacency.capacity() * sizeof(AdjacentEdge)
            + _vertexOffsets.capacity() * sizeof(uint32_t) + _leavingCounts.capacity() * sizeof(uint32_t);
    }
    size_t edgeBuildPeakBytes() const { return _edgeBuildPeakBytes; }
    size_t parallelCandidateCells() const { return _parallelCandidateCells; }
    size_t parallelPathEdges() const { return _parallelPathEdges; }
    size_t parallelPathBatches() const { return _parallelPathBatches; }
    size_t deferredPathEdges() const { return _deferredPathEdges; }
    size_t directPathEdges() const { return _directPathEdges; }
    template<typename Visitor> void visitWorkerEdges(Visitor&& visit) const {
        struct EdgeView {
            size_t vertex1, vertex2;
            const Vector3& clusterVector;
            ClusterTransition* clusterTransition;
            bool hasClusterVector() const { return clusterTransition != nullptr; }
        };
        for(size_t vertex = 0; vertex < _leavingCounts.size(); ++vertex) {
            const size_t end = _vertexOffsets[vertex] + _leavingCounts[vertex];
            for(size_t index = _vertexOffsets[vertex]; index < end; ++index) {
                const auto& adjacent = _adjacency[index];
                const auto& edge = _edges[adjacent.edge];
                const EdgeView view{vertex, adjacent.vertex, edge.clusterVector, edge.clusterTransition};
                visit(view);
            }
        }
    }

    /// Returns the cluster to which a vertex of the tessellation has been assigned (may be NULL).
    Cluster* clusterOfVertex(size_t vertexIndex) const {
        OVITO_ASSERT(vertexIndex < _vertexClusters.size());
        return _vertexClusters[vertexIndex];
    }

    /// Returns the lattice vector assigned to a tessellation edge.
    std::pair<Vector3, ClusterTransition*> getEdgeClusterVector(size_t vertexIndex1, size_t vertexIndex2) const {
        const auto [tessEdge, reversed] = findEdge(vertexIndex1, vertexIndex2);
        OVITO_ASSERT(tessEdge != nullptr);
        OVITO_ASSERT(tessEdge->hasClusterVector());
        if(!reversed)
            return std::make_pair(tessEdge->clusterVector, tessEdge->clusterTransition);
        else
            return std::make_pair(tessEdge->clusterTransition->transform(-tessEdge->clusterVector), tessEdge->clusterTransition->reverse);
    }

private:

    /// Looks up an edge and reports whether the query reverses its original
    /// first-seen orientation. Rows retain leaving-then-arriving list order.
    std::pair<const TessellationEdge*, bool> findEdge(size_t vertexIndex1, size_t vertexIndex2) const {
        OVITO_ASSERT(vertexIndex1 < _leavingCounts.size());
        OVITO_ASSERT(vertexIndex2 < _leavingCounts.size());
        const size_t first = _vertexOffsets[vertexIndex1];
        const size_t leavingEnd = first + _leavingCounts[vertexIndex1];
        for(size_t index = first; index < _vertexOffsets[vertexIndex1 + 1]; ++index)
            if(_adjacency[index].vertex == vertexIndex2)
                return {&_edges[_adjacency[index].edge], index >= leavingEnd};
        return {nullptr, false};
    }

private:

    /// The structure analysis object.
    StructureAnalysis& _structureAnalysis;

    /// The underlying tessellation of the atomistic system.
    DelaunayTessellation& _tessellation;

    /// The cluster graph.
    const std::shared_ptr<ClusterGraph> _clusterGraph;

    // Each row starts with the original leaving list and ends with the
    // original arriving list. Endpoints/links used during construction are
    // discarded before allocating the vector payloads.
    std::vector<uint32_t> _vertexOffsets, _leavingCounts;
    std::vector<AdjacentEdge> _adjacency;
    std::vector<TessellationEdge> _edges;
    size_t _edgeBuildPeakBytes = 0;
    size_t _parallelCandidateCells = 0, _parallelPathEdges = 0;
    size_t _parallelPathBatches = 0, _deferredPathEdges = 0, _directPathEdges = 0;

    /// Stores the cluster assigned to each vertex atom of the tessellation.
    std::vector<Cluster*> _vertexClusters;
};

}   // End of namespace
