////////////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2015 OVITO GmbH, Germany
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
#include <ovito/core/utilities/MemoryPool.h>
#include <ovito/crystalanalysis/data/ClusterVector.h>
#include "StructureAnalysis.h"

namespace Ovito::CrystalAnalysis {

/**
 * Utility class that can find the shortest connecting path between two atoms
 * (which may not be nearest neighbors) in the good crystal region.
 *
 * If a path can be found, the routine returns the ClusterVector connecting the two atoms.
 */
class CrystalPathFinder
{
public:

    /// Constructor.
    CrystalPathFinder(StructureAnalysis& structureAnalysis, int maxPathLength) :
        _structureAnalysis(structureAnalysis), _nodePool(1024),
        _visitedAtoms(structureAnalysis.atomCount()),
        _maxPathLength(maxPathLength) {
        OVITO_ASSERT(maxPathLength >= 1);
    }

    /// Returns a reference to the results of the structure analysis.
    const StructureAnalysis& structureAnalysis() const { return _structureAnalysis; }

    /// Returns a reference to the cluster graph.
    const std::shared_ptr<ClusterGraph>& clusterGraph() { return structureAnalysis().clusterGraph(); }

    /// Finds an atom-to-atom path from atom 1 to atom 2 that lies entirely in the good crystal region.
    /// If a path could be found, returns the corresponding ideal vector connecting the two
    /// atoms in the ideal stress-free reference configuration.
    std::optional<ClusterVector> findPath(size_t atomIndex1, size_t atomIndex2);

private:

    /**
     * This data structure is used for the shortest path search.
     */
    struct PathNode
    {
        /// Constructor
        PathNode(size_t _atomIndex, const ClusterVector& _idealVector) :
            atomIndex(_atomIndex), idealVector(_idealVector) {}

        /// The atom index.
        size_t atomIndex;

        /// The vector from the start atom of the path to this atom.
        ClusterVector idealVector;

        /// Number of steps between this atom and the start atom of the recursive walk.
        int distance;

        /// Linked list.
        PathNode* nextToProcess = nullptr;
    };

    /// The results of the pattern analysis.
    StructureAnalysis& _structureAnalysis;

    /// A memory pool to create PathNode instances.
    MemoryPool<PathNode> _nodePool;

    /// Work array to keep track of atoms which have been visited already.
    boost::dynamic_bitset<> _visitedAtoms;

    /// The maximum length of an atom-to-atom path.
    /// A length of 1 would only return paths between direct neighbor atoms.
    int _maxPathLength;
};

}   // End of namespace
