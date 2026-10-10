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


#include <ovito/particles/Particles.h>
#include <ovito/particles/modifier/analysis/ptm/PTMAlgorithm.h>
#include <ovito/stdobj/properties/PropertyObject.h>

namespace Ovito::Particles {

/**
 * \brief This utility class finds the neighbors of a particle whose local crystalline order has been determined
 *        with the PolyhedralTemplateMatching modifier. In order to use this class, the "output_orientation"
 *        parameter must be set (in the scripting interface) or "Lattice orientations" (in the GUI).
 *
 * The PTMNeighborFinder class must be initialized by a call to prepare().
 *
 * After the PTMNeighborFinder has been initialized, one can find the nearest neighbors of some central
 * particle by constructing an instance of the PTMNeighborFinder::Query class. This class also contains some
 * properties computed by PTM.
 */
class OVITO_PARTICLES_EXPORT PTMNeighborFinder : private NearestNeighborFinder
{
public:

    //// Constructor.
    PTMNeighborFinder(bool all_properties);

    /// \brief Prepares the tree data structure.
    /// \return \c false when the operation has been canceled by the user;
    ///         \c true on success.
    /// \throw Exception on error.
    bool prepare(BufferReadAccess<Point3> positions, const SimulationCellObject* cell, BufferReadAccess<SelectionIntType> selection,
                 ConstDataBufferPtr structuresArray,
                 ConstDataBufferPtr orientationsArray,
                 ConstDataBufferPtr correspondencesArray);

    /// Returns the number of input particles in the system for which the NearestNeighborFinder was created.
    using NearestNeighborFinder::particleCount;

    /// Returns the "Structure Type" particle property.
    const ConstDataBufferPtr& structureTypes() const { return _structuresArray; }

    /// Stores information about a single neighbor of the central particle.
    struct Neighbor : public NearestNeighborFinder::Neighbor
    {
        Vector3 idealVector;
        //Vector_3<int8_t> scaledVector;
        FloatType disorientation;
    };

    /// This nested class performs a PTM calculation on a single input particle.
    /// It is thread-safe to use several Kernel objects concurrently, initialized from the same PTMNeighborFinder object.
    class OVITO_PARTICLES_EXPORT Query
    {
        /// The internal query type for finding the input set of nearest neighbors.
        using NeighborQuery = NearestNeighborFinder::Query<PTMAlgorithm::MAX_INPUT_NEIGHBORS>;

    public:

        /// Constructs a new kernel from the given neighbor finder, which must have previously been initialized
        /// by a call to PTMNeighborFinder::prepare().
        Query(const PTMNeighborFinder& finder) : _finder(finder) {}

        /// Computes the ordered list of neighbor particles fo rthe given central particle.
        void findNeighbors(size_t particleIndex, std::optional<Quaternion> targetOrientation = {});

        /// Returns the structure type identified by the PTM for the current particle.
        PTMAlgorithm::StructureType structureType() const { return _structureType; }

        /// Returns the root-mean-square deviation calculated by the PTM for the current particle.
        double rmsd() const { return _rmsd; }

        /// Returns the interatomic distance calculated by the PTM for the current particle.
        double interatomicDistance() const { return _interatomicDistance; }

        /// Returns the local structure orientation computed by the PTM routine for the current particle.
        const Quaternion& orientation() const { return _orientation; }

        /// Returns the list of neighbor particles.
        const QVarLengthArray<Neighbor, PTMAlgorithm::MAX_INPUT_NEIGHBORS>& neighbors() const { return _list; }

        /// Returns the number of neighbors found for the current central particle.
        int neighborCount() const { return _list.size(); }

    private:

        void getNeighbors(size_t particleIndex, int ptm_type);
        void fillNeighbors(const NeighborQuery& neighborQuery, size_t particleIndex, int offset, int num, const double* delta);
        void calculateRMSDScale();

    private:

        /// Reference to the parent neighbor finder object.
        const PTMNeighborFinder& _finder;

        // Local quantities computed by the PTM algorithm:
        double _rmsd;
        double _interatomicDistance;
        PTMAlgorithm::StructureType _structureType;
        Quaternion _orientation;

        ptm_atomicenv_t _env;
        int _templateIndex = 0;
        QVarLengthArray<Neighbor, PTMAlgorithm::MAX_INPUT_NEIGHBORS> _list;
    };

private:
    bool _all_properties;
    ConstDataBufferPtr _structuresArray;
    ConstDataBufferPtr _orientationsArray;
    ConstDataBufferPtr _correspondencesArray;
};

}   // End of namespace
