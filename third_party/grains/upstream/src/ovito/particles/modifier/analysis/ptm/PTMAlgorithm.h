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
#include <ovito/particles/util/NearestNeighborFinder.h>
#include <ovito/stdobj/properties/PropertyObject.h>
#include <3rdparty/ptm/ptm_functions.h>
#include <3rdparty/ptm/ptm_initialize_data.h>

extern "C" {
    typedef struct ptm_local_handle* ptm_local_handle_t;
}

namespace Ovito::Particles {

/**
 * \brief This class is a wrapper around the Polyhedral Template Matching algorithm
 *      implemented in the PTM third-party library.
 *
 * It allows clients to perform the PTM structure analysis for individual atoms.
 *
 * The PolyhedralTemplateMatchingModifier internally employs the PTMAlgorithm to
 * perform the actual calculation for every input particle of a system.
 */
class OVITO_PARTICLES_EXPORT PTMAlgorithm : private NearestNeighborFinder
{
    Q_GADGET

public:

    /// The structure types known by the PTM routine.
    enum StructureType {
        OTHER = 0,          //< Unidentified structure
        FCC,                //< Face-centered cubic
        HCP,                //< Hexagonal close-packed
        BCC,                //< Body-centered cubic
        ICO,                //< Icosahedral structure
        SC,                 //< Simple cubic structure
        CUBIC_DIAMOND,      //< Cubic diamond structure
        HEX_DIAMOND,        //< Hexagonal diamond structure
        GRAPHENE,           //< Graphene structure

        NUM_STRUCTURE_TYPES //< This counts the number of defined structure types.
    };
    Q_ENUM(StructureType);

    /// The lattice ordering types known by the PTM routine.
    enum OrderingType {
        ORDERING_NONE = 0,
        ORDERING_PURE = 1,
        ORDERING_L10 = 2,
        ORDERING_L12_A = 3,
        ORDERING_L12_B = 4,
        ORDERING_B2 = 5,
        ORDERING_ZINCBLENDE_WURTZITE = 6,
        ORDERING_BORON_NITRIDE = 7,

        NUM_ORDERING_TYPES  //< This just counts the number of defined ordering types.
    };
    Q_ENUM(OrderingType);

#ifndef Q_CC_MSVC
    /// Maximum number of input nearest neighbors needed for the PTM analysis.
    static constexpr int MAX_INPUT_NEIGHBORS = 18;
#else // Workaround for a deficiency in the MSVC compiler:
    /// Maximum number of input nearest neighbors needed for the PTM analysis.
    enum { MAX_INPUT_NEIGHBORS = 18 };
#endif


#ifndef Q_CC_MSVC
    /// Maximum number of nearest neighbors for any structure returned by the PTM analysis routine.
    static constexpr int MAX_OUTPUT_NEIGHBORS = 16;
#else // Workaround for a deficiency in the MSVC compiler:
    /// Maximum number of nearest neighbors for any structure returned by the PTM analysis routine.
    enum { MAX_OUTPUT_NEIGHBORS = 16 };
#endif

    /// Converts a PTM Ovito StructureType to the PTM index.
    static StructureType ptm_to_ovito_structure_type(int type) {
        if(type == PTM_MATCH_NONE) return OTHER;
        if(type == PTM_MATCH_SC) return SC;
        if(type == PTM_MATCH_FCC) return FCC;
        if(type == PTM_MATCH_HCP) return HCP;
        if(type == PTM_MATCH_ICO) return ICO;
        if(type == PTM_MATCH_BCC) return BCC;
        if(type == PTM_MATCH_DCUB) return CUBIC_DIAMOND;
        if(type == PTM_MATCH_DHEX) return HEX_DIAMOND;
        if(type == PTM_MATCH_GRAPHENE) return GRAPHENE;
        OVITO_ASSERT(0);
        return OTHER;
    }

    /// Converts an Ovito StructureType to the PTM index.
    static int ovito_to_ptm_structure_type(StructureType type) {
        if(type == OTHER) return PTM_MATCH_NONE;
        if(type == SC) return PTM_MATCH_SC;
        if(type == FCC) return PTM_MATCH_FCC;
        if(type == HCP) return PTM_MATCH_HCP;
        if(type == ICO) return PTM_MATCH_ICO;
        if(type == BCC) return PTM_MATCH_BCC;
        if(type == CUBIC_DIAMOND) return PTM_MATCH_DCUB;
        if(type == HEX_DIAMOND) return PTM_MATCH_DHEX;
        if(type == GRAPHENE) return PTM_MATCH_GRAPHENE;
        OVITO_ASSERT(0);
        return PTM_MATCH_NONE;
    }

    static const double (*get_template(StructureType structureType, int templateIndex))[3]
    {
        if (structureType == OTHER) {
            return nullptr;
        }

        int ptm_type = ovito_to_ptm_structure_type(structureType);
        const ptm::refdata_t* ref = ptm::refdata[ptm_type];
        return ref->points[templateIndex];
    }

#if 0
    static const int8_t (*get_scaled_template(StructureType structureType, int templateIndex))[3]
    {
        if (structureType == OTHER
            || structureType == ICO) {  // ICO structure does not form a lattice
            return nullptr;
        }

        int ptm_type = ovito_to_ptm_structure_type(structureType);
        const ptm::refdata_t* ref = ptm::refdata[ptm_type];
        if (templateIndex == 0) {
            return ref->scaled;
        }
        else if (templateIndex == 1) {
            return ref->scaled_alt1;
        }
        else if (templateIndex == 2) {
            return ref->scaled_alt2;
        }
        else if (templateIndex == 3) {
            return ref->scaled_alt3;
        }
        OVITO_ASSERT(0);
        return nullptr;
    }
#endif

    template<typename QuaternionType1, typename QuaternionType2>
    static FloatType calculate_disorientation(StructureType structureTypeA,
                                              StructureType structureTypeB,
                                              const QuaternionType1& qa,
                                              const QuaternionType2& qb)
    {
        FloatType disorientation = std::numeric_limits<FloatType>::max();
        if(structureTypeA != structureTypeB)
            return disorientation;

        double orientA[4] = { qa.w(), qa.x(), qa.y(), qa.z() };
        double orientB[4] = { qb.w(), qb.x(), qb.y(), qb.z() };

        int structureType = structureTypeA;
        if(structureType == PTMAlgorithm::SC || structureType == PTMAlgorithm::FCC || structureType == PTMAlgorithm::BCC || structureType == PTMAlgorithm::CUBIC_DIAMOND)
            disorientation = (FloatType)ptm::quat_disorientation_cubic(orientA, orientB);
        else if(structureType == PTMAlgorithm::HCP || structureType == PTMAlgorithm::HEX_DIAMOND || structureType == PTMAlgorithm::GRAPHENE)
            disorientation = (FloatType)ptm::quat_disorientation_hcp_conventional(orientA, orientB);
        else
            return disorientation;

        return qRadiansToDegrees(disorientation);
    }

    /// Creates the algorithm object.
    PTMAlgorithm();

    /// Sets the threshold for the RMSD that must not be exceeded for a structure match to be valid.
    /// A zero cutoff value turns off the threshold filtering. The default threshold value is 0.1.
    void setRmsdCutoff(FloatType cutoff) { _rmsdCutoff = cutoff; }

    /// Returns the threshold for the RMSD that must not be exceeded for a structure match to be valid.
    FloatType rmsdCutoff() const { return _rmsdCutoff; }

    /// Enables/disables the identification of a specific structure type by the PTM.
    /// When the PTMAlgorithm is created, identification is activated for no structure type.
    void setStructureTypeIdentification(StructureType structureType, bool enableIdentification) {
        _typesToIdentify[structureType] = enableIdentification;
    }

    /// Returns true if at least one of the supported structure types has been enabled for identification.
    bool isAnyStructureTypeEnabled() const {
        return std::any_of(_typesToIdentify.begin()+1, _typesToIdentify.end(), [](bool b) { return b; });
    }

    /// Activates the calculation of local elastic deformation gradients by the PTM algorithm (off by default).
    /// After a successful call to Kernel::identifyStructure(), use the Kernel::deformationGradient() method to access the computed
    /// deformation gradient tensor.
    void setCalculateDefGradient(bool calculateDefGradient) { _calculateDefGradient = calculateDefGradient; }

    /// Returns whether calculation of local elastic deformation gradients by the PTM algorithm is enabled.
    bool calculateDefGradient() const { return _calculateDefGradient; }

    /// Activates the identification of chemical ordering types and specifies the chemical types of the input particles.
    void setIdentifyOrdering(ConstDataBufferPtr particleTypes) {
        _particleTypes = std::move(particleTypes);
        _identifyOrdering = (_particleTypes != nullptr);
    }

    /// \brief Initializes the PTMAlgorithm with the input system of particles.
    /// \param positions The particle coordinates.
    /// \param cell The simulation cell information.
    /// \param selection Per-particle selection flags determining which particles are included in the neighbor search (optional).
    /// \return \c false when the operation has been canceled by the user;
    ///         \c true on success.
    /// \throw Exception on error.
    bool prepare(BufferReadAccess<Point3> positions, const SimulationCellObject* cell, BufferReadAccess<SelectionIntType> selection = {}) {
        return NearestNeighborFinder::prepare(std::move(positions), cell, std::move(selection));
    }

    /// This nested class performs a PTM calculation on a single input particle.
    /// It is thread-safe to use several Kernel objects concurrently, initialized from the same PTMAlgorithm object.
    /// The Kernel object performs the PTM analysis and yields the identified structure type and, if a match has been detected,
    /// the ordered list of neighbor particles forming the structure around the central particle.
    class OVITO_PARTICLES_EXPORT Kernel : private NearestNeighborFinder::Query<MAX_INPUT_NEIGHBORS>
    {
    private:
        /// The internal query type for finding the input set of nearest neighbors.
        using NeighborQuery = NearestNeighborFinder::Query<MAX_INPUT_NEIGHBORS>;

    public:
        /// Constructs a new kernel from the given algorithm object, which must have previously been initialized
        /// by a call to PTMAlgorithm::prepare().
        Kernel(const PTMAlgorithm& algo);

        /// Destructor.
        ~Kernel();

        /// Identifies the local structure of the given particle and builds the list of nearest neighbors
        /// that form that structure. Subsequently, in case of a successful match, additional outputs of the calculation
        /// can be retrieved with the query methods below.
        StructureType identifyStructure(size_t particleIndex, const std::vector<uint64_t>& cachedNeighbors);

        // Calculates the topological ordering of a particle's neighbors.
        int cacheNeighbors(size_t particleIndex, uint64_t* res);

        /// Returns the structure type identified by the PTM for the current particle.
        StructureType structureType() const { return _structureType; }

        /// Returns the root-mean-square deviation calculated by the PTM for the current particle.
        double rmsd() const { return _rmsd; }

        /// Returns the elastic deformation gradient computed by PTM for the current particle.
        const Matrix_3<double>& deformationGradient() const { return _F; }

        /// Returns the local interatomic distance parameter computed by the PTM routine for the current particle.
        double interatomicDistance() const { return _interatomicDistance; }

        /// Returns the local chemical ordering identified by the PTM routine for the current particle.
        OrderingType orderingType() const { return static_cast<OrderingType>(_orderingType); }

        /// Returns the local structure orientation computed by the PTM routine for the current particle.
        Quaternion orientation() const {
            return Quaternion((FloatType)_q[1], (FloatType)_q[2], (FloatType)_q[3], (FloatType)_q[0]);
        }

        /// The index of the structure template.
        int templateIndex() const { return _templateIndex; }

        /// Returns the number of neighbors for the PTM structure found for the current particle.
        int numTemplateNeighbors() const;

        /// Returns the number of nearest neighbors found for the current particle.
        int numNearestNeighbors() const { return results().size(); }
        //int numNearestNeighbors() const { return _env.num - 1; }

        /// Returns the number of nearest neighbors that lie within a ball of twice the radius of the nearest neighbor distance.
        int numGoodNeighbors() const {
            //return results().size();

            FloatType minDist = std::numeric_limits<FloatType>::infinity();;
            FloatType distances[PTM_MAX_INPUT_POINTS];
            //qDebug() << "_env.num:" << _env.num << PTM_MAX_INPUT_POINTS << minDist;
            OVITO_ASSERT(_env.num <= PTM_MAX_INPUT_POINTS);
            for (int i=1;i<_env.num;i++) {
                FloatType dx = _env.points[i][0];
                FloatType dy = _env.points[i][1];
                FloatType dz = _env.points[i][2];
                distances[i] = sqrt(dx * dx + dy * dy + dz * dz);
                minDist = std::min(minDist, distances[i]);
            }

            int n = 0;
            for (int i=1;i<_env.num;i++) {
                if (distances[i] < 2 * minDist)
                    n++;
            }

            return n;
        }

        uint64_t correspondence() {
            int type = ovito_to_ptm_structure_type(structureType());
            return ptm_encode_correspondences(type, _env.num, _env.correspondences, _templateIndex);
        }

    private:
        /// Reference to the parent algorithm object.
        const PTMAlgorithm& _algo;

        /// Thread-local storage needed by the PTM.
        ptm_local_handle_t _handle;

        // Output quantities computed by the PTM routine during the last call to identifyStructure():
        double _rmsd;
        double _scale;
        double _interatomicDistance;
        double _q[4];
        Matrix_3<double> _F{Matrix_3<double>::Zero()};
        StructureType _structureType = OTHER;
        int32_t _orderingType = ORDERING_NONE;
        int _templateIndex;
        ptm_atomicenv_t _env;
    };

    static FloatType calculate_interfacial_disorientation(StructureType structureTypeA,
                                                          StructureType structureTypeB,
                                                          const Quaternion& qa,
                                                          const Quaternion& qb,
                                                          Quaternion& output)
    {
        FloatType disorientation = std::numeric_limits<FloatType>::infinity();
        double orientA[4] = { qa.w(), qa.x(), qa.y(), qa.z() };
        double orientB[4] = { qb.w(), qb.x(), qb.y(), qb.z() };

        if (structureTypeA == PTMAlgorithm::FCC || structureTypeA == PTMAlgorithm::CUBIC_DIAMOND) {
            disorientation = (FloatType)ptm::quat_disorientation_hexagonal_to_cubic(orientA, orientB);
        }
        else {
            disorientation = (FloatType)ptm::quat_disorientation_cubic_to_hexagonal(orientA, orientB);
        }

        output.w() = orientB[0];
        output.x() = orientB[1];
        output.y() = orientB[2];
        output.z() = orientB[3];
        return qRadiansToDegrees(disorientation);
    }

private:

    /// Bit array controlling which structures the PTM algorithm will look for.
    std::array<bool, NUM_STRUCTURE_TYPES> _typesToIdentify = {};

    /// Activates the identification of chemical orderings.
    bool _identifyOrdering = false;

    /// The chemical types of the input particles, needed for ordering analysis.
    ConstDataBufferPtr _particleTypes;

    /// Activates the calculation of the elastic deformation gradient by PTM.
    bool _calculateDefGradient = false;

    /// The RMSD threshold that must not be exceeded.
    FloatType _rmsdCutoff = 0.1;
};

}   // End of namespace
