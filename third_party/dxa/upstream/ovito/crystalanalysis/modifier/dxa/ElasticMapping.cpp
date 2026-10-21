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
#include <geometry/DxaProfiling.h>
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

    // Build only topology here. Stable integer IDs survive vector growth;
    // no reference-vector storage or permanent second edge index is needed.
    struct BuildEdge { uint32_t vertex1, vertex2; EdgeIndex nextLeaving, nextArriving; };
    struct Heads { EdgeIndex leaving = InvalidEdge, arriving = InvalidEdge; };
    const size_t vertices = structureAnalysis().atomCount();
    if(vertices >= std::numeric_limits<uint32_t>::max())
        throw Exception("DXA compact edge vertices exceed the supported index range.");
    std::vector<BuildEdge> building;
    std::vector<Heads> heads(vertices);
    auto exists = [&](size_t first, size_t second) {
        for(EdgeIndex index = heads[first].leaving; index != InvalidEdge; index = building[index].nextLeaving)
            if(building[index].vertex2 == second) return true;
        for(EdgeIndex index = heads[first].arriving; index != InvalidEdge; index = building[index].nextArriving)
            if(building[index].vertex1 == second) return true;
        return false;
    };

    // Six candidate bits per primary cell. The prepass only reads immutable
    // geometry; all deduplication, first-seen orientations and adjacency-list
    // insertion below retain the original cell/edge order. Keeping one byte
    // per primary cell avoids a second full edge index or six endpoint arrays.
    auto candidateMask = [&](DelaunayTessellation::CellHandle cell) {
        DelaunayTessellation::VertexHandle handles[4];
        size_t indices[4];
        for(int vertex = 0; vertex < 4; ++vertex) {
            handles[vertex] = tessellation().cellVertex(cell, vertex);
            indices[vertex] = tessellation().vertexIndex(handles[vertex]);
        }
        uint8_t mask = 0;
        for(int edgeIndex = 0; edgeIndex < 6; ++edgeIndex) {
            const int a = edgeVertices[edgeIndex][0], b = edgeVertices[edgeIndex][1];
            if(indices[a] == indices[b]) continue;
            const Point3& p1 = tessellation().vertexPosition(handles[a]);
            const Point3& p2 = tessellation().vertexPosition(handles[b]);
            if(structureAnalysis().cell() && structureAnalysis().cell()->isWrappedVector(p1 - p2)) continue;
            mask |= uint8_t(1u << edgeIndex);
        }
        return mask;
    };
    std::vector<uint8_t> candidates;
    if(dxaThreadCount() > 1 && tessellation().numberOfPrimaryTetrahedra() >= 2048) {
        DxaProfiling::Scope candidateScope("edges.candidate_masks");
        try { candidates.resize(tessellation().numberOfPrimaryTetrahedra()); }
        catch(const std::bad_alloc&) { /* The original serial path needs no mask. */ }
        if(!candidates.empty()) {
            if(!parallelForWithProgress(tessellation().numberOfTetrahedra(), [&](size_t index) {
                const auto cell = static_cast<DelaunayTessellation::CellHandle>(index);
                if(!tessellation().isGhostCell(cell)) candidates[tessellation().getCellIndex(cell)] = candidateMask(cell);
            })) return false;
            _parallelCandidateCells = candidates.size();
        }
    }

    DxaProfiling::Scope orderedScope("edges.ordered_construction");
    for(auto cellIter = tessellation().begin_cells(); cellIter != tessellation().end_cells(); ++cellIter) {
        const auto cell = *cellIter;
        if(tessellation().isGhostCell(cell)) continue;
        if(!operation.setProgressValueIntermittent(tessellation().getCellIndex(cell))) return false;
        const uint8_t mask = candidates.empty() ? candidateMask(cell) : candidates[tessellation().getCellIndex(cell)];
        if(mask == 0) continue;
        size_t indices[4];
        for(int vertex = 0; vertex < 4; ++vertex)
            indices[vertex] = tessellation().vertexIndex(tessellation().cellVertex(cell, vertex));
        for(int edgeIndex = 0; edgeIndex < 6; ++edgeIndex) {
            if(!(mask & (1u << edgeIndex))) continue;
            const size_t vertex1 = indices[edgeVertices[edgeIndex][0]], vertex2 = indices[edgeVertices[edgeIndex][1]];
            if(!exists(vertex1, vertex2)) {
                // Two directed adjacency entries must fit the row offsets.
                if(building.size() >= std::numeric_limits<uint32_t>::max() / 2)
                    throw Exception("DXA compact edge adjacency exceeds the supported index range.");
                const EdgeIndex index = static_cast<EdgeIndex>(building.size());
                building.push_back({static_cast<uint32_t>(vertex1), static_cast<uint32_t>(vertex2),
                    heads[vertex1].leaving, heads[vertex2].arriving});
                heads[vertex1].leaving = index;
                heads[vertex2].arriving = index;
            }
        }
    }

    orderedScope.stop();
    DxaProfiling::Scope compactScope("edges.compact_adjacency");
    // Compact in exactly the old linked-list order, including the separate
    // leaving and arriving parts used by first-match cluster propagation.
    const size_t edgeCount = building.size();
    _vertexOffsets.resize(vertices + 1);
    _leavingCounts.resize(vertices);
    size_t offset = 0;
    for(size_t vertex = 0; vertex < vertices; ++vertex) {
        if((vertex & 255) == 0 && operation.isCanceled()) return false;
        _vertexOffsets[vertex] = static_cast<uint32_t>(offset);
        for(EdgeIndex index = heads[vertex].leaving; index != InvalidEdge; index = building[index].nextLeaving) ++offset;
        _leavingCounts[vertex] = static_cast<uint32_t>(offset - _vertexOffsets[vertex]);
        for(EdgeIndex index = heads[vertex].arriving; index != InvalidEdge; index = building[index].nextArriving) ++offset;
    }
    OVITO_ASSERT(offset == edgeCount * 2);
    _vertexOffsets[vertices] = static_cast<uint32_t>(offset);
    _adjacency.resize(offset);
    for(size_t vertex = 0; vertex < vertices; ++vertex) {
        if((vertex & 255) == 0 && operation.isCanceled()) return false;
        size_t slot = _vertexOffsets[vertex];
        for(EdgeIndex index = heads[vertex].leaving; index != InvalidEdge; index = building[index].nextLeaving)
            _adjacency[slot++] = {building[index].vertex2, index};
        for(EdgeIndex index = heads[vertex].arriving; index != InvalidEdge; index = building[index].nextArriving)
            _adjacency[slot++] = {building[index].vertex1, index};
    }
    _edgeBuildPeakBytes = compactEdgeBytes() + building.capacity() * sizeof(BuildEdge)
        + heads.capacity() * sizeof(Heads) + candidates.capacity();
    // Release temporary endpoints/links before allocating the larger payload.
    std::vector<BuildEdge>().swap(building);
    std::vector<Heads>().swap(heads);
    std::vector<uint8_t>().swap(candidates);
    _edges.resize(edgeCount);
    _edgeBuildPeakBytes = std::max(_edgeBuildPeakBytes, compactEdgeBytes());
    compactScope.stop();
    DxaProfiling::set("edges.count", edgeCount);
    DxaProfiling::set("edges.payload_bytes", _edges.capacity() * sizeof(TessellationEdge));
    DxaProfiling::set("edges.adjacency_bytes", _adjacency.capacity() * sizeof(AdjacentEdge));
    DxaProfiling::set("edges.offset_bytes", (_vertexOffsets.capacity() + _leavingCounts.capacity()) * sizeof(uint32_t));
    DxaProfiling::set("edges.retained_bytes", compactEdgeBytes());
    DxaProfiling::set("edges.build_peak_bytes", _edgeBuildPeakBytes);
    return !operation.isCanceled();
}

/******************************************************************************
* Assigns each tessellation vertex to a cluster.
******************************************************************************/
bool ElasticMapping::assignVerticesToClusters(ProgressingTask& operation)
{
    DxaProfiling::Scope timing("clusters.assignVertices");
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
        DxaProfiling::add("clusters.assignmentPasses", 1);
        for(size_t vertexIndex = 0; vertexIndex < _vertexClusters.size(); vertexIndex++) {
            if(clusterOfVertex(vertexIndex)->id != 0) continue;
            for(size_t index = _vertexOffsets[vertexIndex]; index < _vertexOffsets[vertexIndex + 1]; ++index) {
                const uint32_t neighbor = _adjacency[index].vertex;
                if(clusterOfVertex(neighbor)->id != 0) {
                    _vertexClusters[vertexIndex] = _vertexClusters[neighbor];
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
    DxaProfiling::Scope mappingTiming("mapping.total");
    const bool profileMapping = DxaProfiling::enabled();
    std::atomic<uint64_t> contextConstructions{0}, contextConstructionNs{0};
    size_t serialSearches = 0;
    DxaProfiling::Scope serialContextTiming("mapping.serialContext");
    CrystalPathFinder pathFinder(_structureAnalysis, crystalPathSteps);
    serialContextTiming.stop();
    operation.setProgressMaximum(_leavingCounts.size());

    // Graph cache writes are committed in the original vertex/linked-list order.
    // Parallel searches only use transitions which already exist at the start
    // of a batch. A missing transition defers the complete path search, because
    // mutating/cache-filling the graph on workers can change tie resolution.
    auto commit = [&](const EdgeWork& work, const std::optional<ClusterVector>& idealVector) {
        if(!idealVector) return;
        const auto& adjacent = _adjacency[work.adjacency];
        TessellationEdge* edge = &_edges[adjacent.edge];
        Cluster* cluster1 = clusterOfVertex(work.vertex1);
        Cluster* cluster2 = clusterOfVertex(adjacent.vertex);
        Vector3 localVec;
        if(idealVector->cluster() == cluster1) localVec = idealVector->localVec();
        else {
            ClusterTransition* transition = clusterGraph()->determineClusterTransition(idealVector->cluster(), cluster1);
            if(!transition) return;
            localVec = transition->transform(idealVector->localVec());
        }
        ClusterTransition* transition = clusterGraph()->determineClusterTransition(cluster1, cluster2);
        if(transition) edge->assignClusterVector(localVec, transition);
    };
    const bool useParallel = dxaThreadCount() > 1 && _edges.size() >= 2048;
    // Bound extra storage independent of atom count: 4 MiB in Wasm32.
    // Unassigned edges already own vector storage. Each worker may write that
    // storage, but clusterTransition remains null until the ordered commit.
    constexpr size_t batchCapacity = 262144;
    struct SearchResult { Cluster* cluster = nullptr; bool deferred = false; };
    std::vector<EdgeWork> batch;
    std::vector<SearchResult> results;
    if(useParallel) {
        try { batch.reserve(std::min(batchCapacity, _edges.size())); results.resize(std::min(batchCapacity, _edges.size())); }
        catch(const std::bad_alloc&) { batch.clear(); results.clear(); }
    }
    auto flush = [&]() {
        if(batch.empty()) return true;
        DxaProfiling::Scope searchTiming("mapping.batchSearch");
        if(!dxaParallelForWithContext(batch.size(),
            [&] {
                if(!profileMapping) return std::make_unique<CrystalPathFinder>(_structureAnalysis, crystalPathSteps);
                const auto started = std::chrono::steady_clock::now();
                auto context = std::make_unique<CrystalPathFinder>(_structureAnalysis, crystalPathSteps);
                const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
                    std::chrono::steady_clock::now() - started).count();
                // Once per context, never an atomic operation per searched edge.
                contextConstructions.fetch_add(1, std::memory_order_relaxed);
                contextConstructionNs.fetch_add(elapsed, std::memory_order_relaxed);
                return context;
            },
            [&](std::unique_ptr<CrystalPathFinder>& finder, size_t index) {
                const auto& work = batch[index];
                const auto& adjacent = _adjacency[work.adjacency];
                const auto vector = finder->findPath(work.vertex1, adjacent.vertex, true, &results[index].deferred);
                results[index].cluster = vector ? vector->cluster() : nullptr;
                if(vector) _edges[adjacent.edge].clusterVector = vector->localVec();
            }, true)) return false;
        searchTiming.stop();
        DxaProfiling::Scope commitTiming("mapping.orderedBatchCommit");
        _parallelPathEdges += batch.size();
        ++_parallelPathBatches;
        for(size_t index = 0; index < batch.size(); ++index) {
            if((index & 255) == 0 && operation.isCanceled()) return false;
            // Each undirected edge appears in one leaving list. Also retain
            // the serial already-assigned guard at commit for future imports.
            const auto& work = batch[index];
            const auto& adjacent = _adjacency[work.adjacency];
            TessellationEdge* edge = &_edges[adjacent.edge];
            if(edge->hasClusterVector()) continue;
            auto& result = results[index];
            if(result.deferred) {
                ++_deferredPathEdges;
                commit(work, pathFinder.findPath(work.vertex1, adjacent.vertex));
            }
            else if(result.cluster) {
                Cluster* cluster1 = clusterOfVertex(work.vertex1);
                if(result.cluster == cluster1) {
                    // The worker wrote the exact reference vector into this
                    // edge's otherwise unassigned storage. Commit only its
                    // transition; no extra vector copy or optional is needed.
                    ClusterTransition* transition = clusterGraph()->determineClusterTransition(cluster1, clusterOfVertex(adjacent.vertex));
                    if(transition) edge->clusterTransition = transition;
                }
                else commit(work, ClusterVector(edge->clusterVector, result.cluster));
            }
        }
        batch.clear();
        return true;
    };
    size_t progressCounter = 0;
    for(size_t vertex = 0; vertex < _leavingCounts.size(); ++vertex) {
        if(!operation.setProgressValueIntermittent(progressCounter++)) return false;
        const size_t end = _vertexOffsets[vertex] + _leavingCounts[vertex];
        for(size_t index = _vertexOffsets[vertex]; index < end; ++index) {
            const auto& adjacent = _adjacency[index];
            const EdgeWork work{static_cast<uint32_t>(vertex), static_cast<uint32_t>(index)};
            TessellationEdge* edge = &_edges[adjacent.edge];
            if(edge->hasClusterVector()) continue;
            Cluster* cluster1 = clusterOfVertex(vertex);
            Cluster* cluster2 = clusterOfVertex(adjacent.vertex);
            OVITO_ASSERT(cluster1 && cluster2);
            if(cluster1->id == 0 || cluster2->id == 0) continue;
            if(results.empty()) {
                if(profileMapping) ++serialSearches;
                commit(work, pathFinder.findPath(vertex, adjacent.vertex));
            }
            else {
                // Most perfect-bulk edges return at findPath's first neighbor
                // test. Avoid staging that cheap work twice. This branch uses
                // precisely that same lookup and reference vector. Existing
                // self-transitions never mutate graph state; when a self-edge
                // must be created, flush earlier searches first to preserve
                // the original graph-cache insertion order.
                if(cluster1 == cluster2 && _structureAnalysis.atomCluster(vertex) == cluster1) {
                    const qint64 neighbor = _structureAnalysis.findNeighbor(vertex, adjacent.vertex);
                    if(neighbor != -1) {
                        if(!cluster1->transitions || !cluster1->transitions->isSelfTransition()) {
                            if(!flush()) return false;
                        }
                        edge->assignClusterVector(_structureAnalysis.neighborLatticeVector(vertex, neighbor),
                            clusterGraph()->createSelfTransition(cluster1));
                        ++_directPathEdges;
                        continue;
                    }
                }
                batch.push_back(work);
                if(batch.size() == results.size() && !flush()) return false;
            }
        }
    }
    if(!flush()) return false;

    DxaProfiling::set("mapping.contextConstructions", contextConstructions.load(std::memory_order_relaxed));
    DxaProfiling::addTiming("mapping.contextConstructionCpuMs", contextConstructionNs.load(std::memory_order_relaxed) * 1e-6);
    DxaProfiling::set("mapping.serialSearches", serialSearches);
    DxaProfiling::set("mapping.parallelSearches", _parallelPathEdges);
    DxaProfiling::set("mapping.parallelBatches", _parallelPathBatches);
    DxaProfiling::set("mapping.deferredSearches", _deferredPathEdges);
    DxaProfiling::set("mapping.directPaths", _directPathEdges);
    DxaProfiling::set("mapping.batchCapacityBytes", batch.capacity() * sizeof(EdgeWork) + results.capacity() * sizeof(SearchResult));
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
        const auto [tessEdge, reversed] = findEdge(vertex1, vertex2);
        if(!tessEdge || !tessEdge->hasClusterVector())
            return false;
        if(!reversed) {
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
