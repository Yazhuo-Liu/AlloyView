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
#include <ovito/particles/modifier/analysis/cna/CommonNeighborAnalysisModifier.h>
#include <ovito/crystalanalysis/data/ClusterGraph.h>

namespace Ovito::CrystalAnalysis {

/*
 * Determines the local structure of each atom.
 */
class StructureAnalysis
{
public:

    /// The coordination structure types.
    enum CoordinationStructureType {
        COORD_OTHER = 0,        //< Unidentified structure
        COORD_FCC,              //< Face-centered cubic
        COORD_HCP,              //< Hexagonal close-packed
        COORD_BCC,              //< Body-centered cubic
        COORD_CUBIC_DIAMOND,    //< Diamond cubic
        COORD_HEX_DIAMOND,      //< Diamond hexagonal

        NUM_COORD_TYPES         //< This just counts the number of defined coordination types.
    };

    /// The lattice structure types.
    enum LatticeStructureType {
        LATTICE_OTHER = 0,          //< Unidentified structure
        LATTICE_FCC,                //< Face-centered cubic
        LATTICE_HCP,                //< Hexagonal close-packed
        LATTICE_BCC,                //< Body-centered cubic
        LATTICE_CUBIC_DIAMOND,      //< Diamond cubic
        LATTICE_HEX_DIAMOND,        //< Diamond hexagonal

        NUM_LATTICE_TYPES           //< This just counts the number of defined coordination types.
    };

    /// The maximum number of neighbor atoms taken into account for the common neighbor analysis.
    enum { MAX_NEIGHBORS = 16 };

    struct CoordinationStructure {
        int numNeighbors;
        std::vector<Vector3> latticeVectors;
        CommonNeighborAnalysisModifier::NeighborBondArray neighborArray;
        int cnaSignatures[MAX_NEIGHBORS];
        int commonNeighbors[MAX_NEIGHBORS][2];
    };

    struct SymmetryPermutation {
        Matrix3 transformation;
        std::array<int, MAX_NEIGHBORS> permutation;
        std::vector<int> product;
        std::vector<int> inverseProduct;
    };

    struct LatticeStructure {
        const CoordinationStructure* coordStructure;
        std::vector<Vector3> latticeVectors;
        Matrix3 primitiveCell;
        Matrix3 primitiveCellInverse;
        int maxNeighbors;

        /// List of symmetry permutations of the lattice structure.
        /// Each entry contains the rotation/reflection matrix and the corresponding permutation of the neighbor bonds.
        std::vector<SymmetryPermutation> permutations;
    };

public:

    /// Constructor.
    StructureAnalysis(
            ConstPropertyPtr positions,
            const SimulationCellObject* simCell,
            LatticeStructureType inputCrystalType,
            ConstPropertyPtr particleSelection,
            PropertyPtr outputStructures,
            std::vector<Matrix3> preferredCrystalOrientations = std::vector<Matrix3>(),
            bool identifyPlanarDefects = true);

    /// Identifies the atomic structures.
    bool identifyStructures();

    /// Combines adjacent atoms to clusters.
    bool buildClusters();

    /// Determines the transition matrices between clusters.
    bool connectClusters();

    /// Combines clusters to super clusters.
    bool formSuperClusters();

    /// Returns the number of input atoms.
    int atomCount() const { return positions()->size(); }

    /// Returns the input particle positions.
    const ConstPropertyPtr& positions() const { return _positions; }

    /// Returns the input simulation cell.
    const DataOORef<const SimulationCellObject>& cell() const { return _simCell; }

    /// Returns the array of atom structure types.
    const PropertyPtr& structureTypes() const { return _structureTypes; }

    /// Returns the array of atom cluster IDs.
    const PropertyPtr& atomClusters() const { return _atomClusters; }

    /// Returns the maximum distance of any neighbor from a crystalline atom.
    FloatType maximumNeighborDistance() const { return _maximumNeighborDistance; }

    /// Returns the cluster graph.
    const std::shared_ptr<ClusterGraph>& clusterGraph() const { return _clusterGraph; }

    /// Returns the cluster an atom belongs to.
    Cluster* atomCluster(int atomIndex) const {
        return clusterGraph()->findCluster(_atomClustersArray[atomIndex]);
    }

    /// Returns the number of neighbors of the given atom.
    int numberOfNeighbors(int atomIndex) const {
        const int* neighborList = &_neighborLists[atomIndex * _neighborListsSize];
        size_t count = 0;
        while(count < _neighborListsSize && neighborList[count] != -1)
            count++;
        return count;
    }

    /// Returns an atom from an atom's neighbor list.
    int getNeighbor(int centralAtomIndex, int neighborListIndex) const {
        return _neighborLists[centralAtomIndex * _neighborListsSize + neighborListIndex];
    }

    /// Sets an entry in an atom's neighbor list.
    void setNeighbor(int centralAtomIndex, int neighborListIndex, int neighborAtomIndex) {
        _neighborLists[centralAtomIndex * _neighborListsSize + neighborListIndex] = neighborAtomIndex;
    }

    /// Returns the neighbor list index of the given atom.
    int findNeighbor(int centralAtomIndex, int neighborAtomIndex) const {
        const int* neighborList = &_neighborLists[centralAtomIndex * _neighborListsSize];
        for(size_t index = 0; index < _neighborListsSize && neighborList[index] != -1; index++) {
            if(neighborList[index] == neighborAtomIndex)
                return index;
        }
        return -1;
    }

    /// Releases the memory allocated for neighbor lists.
    void freeNeighborLists() {
        decltype(_neighborLists){}.swap(_neighborLists);
        decltype(_atomSymmetryPermutations){}.swap(_atomSymmetryPermutations);
        _atomClustersArray.reset();
    }

    /// Returns the ideal lattice vector associated with a neighbor bond.
    const Vector3& neighborLatticeVector(int centralAtomIndex, int neighborIndex) const {
        int structureType = _structureTypesArray[centralAtomIndex];
        const LatticeStructure& latticeStructure = _latticeStructures[structureType];
        OVITO_ASSERT(neighborIndex >= 0 && neighborIndex < _coordinationStructures[structureType].numNeighbors);
        int symmetryPermutationIndex = _atomSymmetryPermutations[centralAtomIndex];
        OVITO_ASSERT(symmetryPermutationIndex >= 0 && symmetryPermutationIndex < latticeStructure.permutations.size());
        const auto& permutation = latticeStructure.permutations[symmetryPermutationIndex].permutation;
        return latticeStructure.latticeVectors[permutation[neighborIndex]];
    }

    /// Returns the given lattice structure.
    static const LatticeStructure& latticeStructure(int structureIndex) {
        return _latticeStructures[structureIndex];
    }

    /// Throws an exception which tells the user that the periodic simulation cell is too small.
    static void generateCellTooSmallError(int dimension);

private:

    /// Determines the coordination structure of a particle.
    void determineLocalStructure(NearestNeighborFinder& neighList, size_t particleIndex);

    /// Prepares the list of coordination and lattice structures.
    static void initializeListOfStructures();

private:

    const LatticeStructureType _inputCrystalType;
    bool _identifyPlanarDefects;
    const ConstPropertyPtr _positions;
    const PropertyPtr _structureTypes;
    BufferWriteAccess<int32_t, access_mode::discard_read_write> _structureTypesArray;
    const PropertyPtr _atomClusters;
    BufferWriteAccess<int64_t, access_mode::discard_read_write> _atomClustersArray;
    std::vector<int> _neighborLists;
    std::vector<int> _atomSymmetryPermutations;
    size_t _neighborListsSize = 0;
    BufferReadAccessAndRef<SelectionIntType> _particleSelection;
    const std::shared_ptr<ClusterGraph> _clusterGraph;
    std::atomic<FloatType> _maximumNeighborDistance;
    DataOORef<const SimulationCellObject> _simCell;
    std::vector<Matrix3> _preferredCrystalOrientations;

    static CoordinationStructure _coordinationStructures[NUM_COORD_TYPES];
    static LatticeStructure _latticeStructures[NUM_LATTICE_TYPES];
};

}   // End of namespace
