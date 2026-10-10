////////////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2021 OVITO GmbH, Germany
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

#include <ovito/particles/Particles.h>
#include "PTMAlgorithm.h"


namespace Ovito::Particles {

/******************************************************************************
* Creates the algorithm object.
******************************************************************************/
PTMAlgorithm::PTMAlgorithm() : NearestNeighborFinder(MAX_INPUT_NEIGHBORS)
{
    ptm_initialize_global();
}

/******************************************************************************
* Constructs a new kernel from the given algorithm object, which must have
* previously been initialized by a call to PTMAlgorithm::prepare().
******************************************************************************/
PTMAlgorithm::Kernel::Kernel(const PTMAlgorithm& algo) : NeighborQuery(algo), _algo(algo)
{
    // Reserve thread-local storage of PTM routine.
    _handle = ptm_initialize_local();
}

/******************************************************************************
* Destructor.
******************************************************************************/
PTMAlgorithm::Kernel::~Kernel()
{
    // Release thread-local storage of PTM routine.
    ptm_uninitialize_local(_handle);
}

// Neighbor data passed to PTM routine.  Used in the get_neighbours callback function.
struct ptmnbrdata_t
{
    const NearestNeighborFinder* neighFinder;
    BufferReadAccess<int32_t> particleTypes;
    const std::vector<uint64_t>* cachedNeighbors;
};

static int get_neighbours(void* vdata, size_t _unused_lammps_variable, size_t atom_index, int num_requested, ptm_atomicenv_t* env)
{
    ptmnbrdata_t* nbrdata = (ptmnbrdata_t*)vdata;
    const NearestNeighborFinder* neighFinder = nbrdata->neighFinder;
    const BufferReadAccess<int32_t>& particleTypes = nbrdata->particleTypes;
    const std::vector<uint64_t>& cachedNeighbors = *nbrdata->cachedNeighbors;

    // Find nearest neighbors.
    OVITO_ASSERT(atom_index < cachedNeighbors.size());
    NearestNeighborFinder::Query<PTMAlgorithm::MAX_INPUT_NEIGHBORS> neighQuery(*neighFinder);
    neighQuery.findNeighbors(atom_index);
    int numNeighbors = std::min(num_requested - 1, neighQuery.results().size());
    OVITO_ASSERT(numNeighbors <= PTMAlgorithm::MAX_INPUT_NEIGHBORS);

    int dummy = 0;
    ptm_decode_correspondences(PTM_MATCH_FCC,   //this gives us default behaviour
                               cachedNeighbors[atom_index],
                               env->correspondences,
                               &dummy);

    // Bring neighbor coordinates into a form suitable for the PTM library.
    env->atom_indices[0] = atom_index;
    env->points[0][0] = 0;
    env->points[0][1] = 0;
    env->points[0][2] = 0;
    for(int i = 0; i < numNeighbors; i++) {
        int p = env->correspondences[i+1] - 1;
        OVITO_ASSERT(p >= 0);
        OVITO_ASSERT(p < neighQuery.results().size());
        env->atom_indices[i+1] = neighQuery.results()[p].index;
        env->points[i+1][0] = neighQuery.results()[p].delta.x();
        env->points[i+1][1] = neighQuery.results()[p].delta.y();
        env->points[i+1][2] = neighQuery.results()[p].delta.z();
    }

    // Build list of particle types for ordering identification.
    if(particleTypes) {
        env->numbers[0] = particleTypes[atom_index];
        for(int i = 0; i < numNeighbors; i++) {
            int p = env->correspondences[i+1] - 1;
            env->numbers[i+1] = particleTypes[neighQuery.results()[p].index];
        }
    }
    else {
        for(int i = 0; i < numNeighbors + 1; i++) {
            env->numbers[i] = 0;
        }
    }

    env->num = numNeighbors + 1;
    return numNeighbors + 1;
}


/******************************************************************************
* Identifies the local structure of the given particle and builds the list of
* nearest neighbors that form the structure.
******************************************************************************/
PTMAlgorithm::StructureType PTMAlgorithm::Kernel::identifyStructure(size_t particleIndex, const std::vector<uint64_t>& cachedNeighbors)
{
    OVITO_ASSERT(cachedNeighbors.size() == _algo.particleCount());

    // Validate input.
    if(particleIndex >= _algo.particleCount())
        throw Exception("Particle index is out of range.");

    // Make sure public constants remain consistent with internal ones from the PTM library.
    OVITO_STATIC_ASSERT(MAX_INPUT_NEIGHBORS == PTM_MAX_INPUT_POINTS - 1);
    OVITO_STATIC_ASSERT(MAX_OUTPUT_NEIGHBORS == PTM_MAX_NBRS);

    ptmnbrdata_t nbrdata;
    nbrdata.neighFinder = &_algo;
    nbrdata.particleTypes = _algo._identifyOrdering ? _algo._particleTypes : nullptr;
    nbrdata.cachedNeighbors = &cachedNeighbors;

    int32_t flags = 0;
    if(_algo._typesToIdentify[SC]) flags |= PTM_CHECK_SC;
    if(_algo._typesToIdentify[FCC]) flags |= PTM_CHECK_FCC;
    if(_algo._typesToIdentify[HCP]) flags |= PTM_CHECK_HCP;
    if(_algo._typesToIdentify[ICO]) flags |= PTM_CHECK_ICO;
    if(_algo._typesToIdentify[BCC]) flags |= PTM_CHECK_BCC;
    if(_algo._typesToIdentify[CUBIC_DIAMOND]) flags |= PTM_CHECK_DCUB;
    if(_algo._typesToIdentify[HEX_DIAMOND]) flags |= PTM_CHECK_DHEX;
    if(_algo._typesToIdentify[GRAPHENE]) flags |= PTM_CHECK_GRAPHENE;

    // Call PTM library to identify the local structure.
    ptm_result_t result;
    int errorCode = ptm_index(_handle,
            particleIndex, get_neighbours, (void*)&nbrdata,
            flags,
            _algo._calculateDefGradient,
            &result,
            &_env);

    int32_t type = result.structure_type;
    _orderingType = result.ordering_type;
    _scale = result.scale;
    _rmsd = result.rmsd;
    _interatomicDistance = result.interatomic_distance;
    _templateIndex = result.template_index;
    memcpy(_q, result.orientation, 4 * sizeof(double));
    if (_algo._calculateDefGradient) {
        memcpy(_F.elements(), result.F,  9 * sizeof(double));
    }

    OVITO_ASSERT(errorCode == PTM_NO_ERROR);

    // Convert PTM classification back to our own scheme.
    if(type == PTM_MATCH_NONE || (_algo._rmsdCutoff != 0 && _rmsd > _algo._rmsdCutoff)) {
        _structureType = OTHER;
        _orderingType = ORDERING_NONE;
        _rmsd = 0;
        _interatomicDistance = 0;
        _q[0] = _q[1] = _q[2] = _q[3] = 0;
        _scale = 0;
        _templateIndex = 0;
        _F.setZero();
    }
    else {
        _structureType = ptm_to_ovito_structure_type(type);
    }

    return _structureType;
}

int PTMAlgorithm::Kernel::cacheNeighbors(size_t particleIndex, uint64_t* res)
{
    // Validate input.
    OVITO_ASSERT(particleIndex < _algo.particleCount());

    // Make sure public constants remain consistent with internal ones from the PTM library.
    OVITO_STATIC_ASSERT(MAX_INPUT_NEIGHBORS == PTM_MAX_INPUT_POINTS - 1);
    OVITO_STATIC_ASSERT(MAX_OUTPUT_NEIGHBORS == PTM_MAX_NBRS);

    // Find nearest neighbors around the central particle.
    NeighborQuery::findNeighbors(particleIndex);
    int numNeighbors = NeighborQuery::results().size();

    double points[PTM_MAX_INPUT_POINTS - 1][3];
    for(int i = 0; i < numNeighbors; i++) {
        points[i][0] = NeighborQuery::results()[i].delta.x();
        points[i][1] = NeighborQuery::results()[i].delta.y();
        points[i][2] = NeighborQuery::results()[i].delta.z();
    }

    return ptm_preorder_neighbours(_handle, numNeighbors, points, res);
}

}   // End of namespace
