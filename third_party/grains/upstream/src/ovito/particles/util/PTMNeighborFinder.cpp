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

#include <ovito/particles/Particles.h>
#include <ovito/core/utilities/concurrent/Task.h>
#include <ovito/particles/modifier/analysis/ptm/PTMAlgorithm.h>
#include "PTMNeighborFinder.h"

namespace Ovito::Particles {

/******************************************************************************
* Creates the neighbor finder.
******************************************************************************/
PTMNeighborFinder::PTMNeighborFinder(bool all_properties) : NearestNeighborFinder(PTMAlgorithm::MAX_INPUT_NEIGHBORS)
{
    ptm_initialize_global();

    // scripting interface should always set this to true;
    _all_properties = all_properties;
}

/******************************************************************************
* Prepares the neighbor finder.
******************************************************************************/
bool PTMNeighborFinder::prepare(BufferReadAccess<Point3> positions, const SimulationCellObject* cell, BufferReadAccess<SelectionIntType> selection,
                                ConstDataBufferPtr structuresArray,
                                ConstDataBufferPtr orientationsArray,
                                ConstDataBufferPtr correspondencesArray)
{
    // Initialize the internal NearestNeighborFinder.
    if(!NearestNeighborFinder::prepare(std::move(positions), cell, std::move(selection)))
        return false;

    OVITO_ASSERT(structuresArray);
    OVITO_ASSERT(orientationsArray);
    OVITO_ASSERT(correspondencesArray);

    _structuresArray = std::move(structuresArray);
    _orientationsArray = std::move(orientationsArray);
    _correspondencesArray = std::move(correspondencesArray);

    return true;
}

/******************************************************************************
* Computes the ordered list of neighbor particles.
******************************************************************************/
void PTMNeighborFinder::Query::findNeighbors(size_t particleIndex, std::optional<Quaternion> targetOrientation)
{
    BufferReadAccess<PTMAlgorithm::StructureType> structuresArray(_finder._structuresArray);
    BufferReadAccess<QuaternionG> orientationsArray(_finder._orientationsArray);

    _structureType = structuresArray[particleIndex];
    _orientation = orientationsArray[particleIndex].toDataType<FloatType>();
    _rmsd = std::numeric_limits<FloatType>::infinity();

    int ptm_type = PTMAlgorithm::ovito_to_ptm_structure_type(_structureType);
    getNeighbors(particleIndex, ptm_type);

    int8_t remap_permutation[PTM_MAX_INPUT_POINTS];
    std::iota(std::begin(remap_permutation), std::end(remap_permutation), 0);

    if(_structureType != PTMAlgorithm::OTHER && targetOrientation) {
        //arrange orientation in PTM format
        double qtarget[4] = {targetOrientation->w(),
                                targetOrientation->x(),
                                targetOrientation->y(),
                                targetOrientation->z()};
        double qptm[4] = {_orientation.w(),
                            _orientation.x(),
                            _orientation.y(),
                            _orientation.z()};
        double dummy = 0;
        _templateIndex = ptm_remap_template(ptm_type, _templateIndex,
                                            qtarget, qptm,
                                            remap_permutation);
        //arrange orientation in OVITO format
        _orientation.w() = qptm[0];
        _orientation.x() = qptm[1];
        _orientation.y() = qptm[2];
        _orientation.z() = qptm[3];
    }

    const double (*ptmTemplate)[3] = PTMAlgorithm::get_template(_structureType, _templateIndex);
#if 0
    const int8_t (*scaledTemplate)[3] = PTMAlgorithm::get_scaled_template(_structureType, _templateIndex);
#endif
    for(int i = 0; i < _list.size(); i++) {
        Neighbor& n = _list[i];
        int index = remap_permutation[i + 1];
        n.index = _env.atom_indices[index];
        const double* p = _env.points[index];
        n.delta = Vector3(p[0], p[1], p[2]);
        n.distanceSq = n.delta.squaredLength();

        if(_structureType == PTMAlgorithm::OTHER) {
            n.idealVector = Vector_3<double>(0, 0, 0);
        }
        else {
            const double* q = ptmTemplate[i + 1];
            n.idealVector = Vector3(q[0], q[1], q[2]);
        }

#if 0
        if(scaledTemplate == nullptr) {
            n.scaledVector.setZero();
        }
        else {
            const int8_t* q = scaledTemplate[i + 1];
            n.scaledVector.x() = q[0];
            n.scaledVector.y() = q[1];
            n.scaledVector.z() = q[2];
        }
#endif

        if(_finder._all_properties && _structureType != PTMAlgorithm::OTHER) {
            n.disorientation = PTMAlgorithm::calculate_disorientation(_structureType,
                                                                        structuresArray[n.index],
                                                                        _orientation,
                                                                        orientationsArray[n.index]);
        }
        else {
            n.disorientation = std::numeric_limits<FloatType>::max();
        }
    }

    if (_structureType != PTMAlgorithm::OTHER)
        calculateRMSDScale();
}

void PTMNeighborFinder::Query::getNeighbors(size_t particleIndex, int ptm_type)
{
    BufferReadAccess<int64_t> correspondencesArray(_finder._correspondencesArray);

    // Let the internal NearestNeighborFinder determine the list of nearest particles.
    NeighborQuery neighborQuery(_finder);
    neighborQuery.findNeighbors(particleIndex);
    int numNeighbors = neighborQuery.results().size();
    _templateIndex = 0;

    int num_inner = ptm_num_nbrs[ptm_type];
    int num_outer = 0;
    if(ptm_type == PTM_MATCH_NONE) {
        for(int i = 0; i < PTM_MAX_INPUT_POINTS; i++) {
            _env.correspondences[i] = i;
        }

        num_inner = numNeighbors;
    }
    else {
        OVITO_ASSERT(numNeighbors >= ptm_num_nbrs[ptm_type]);
        numNeighbors = ptm_num_nbrs[ptm_type];

        ptm_decode_correspondences(ptm_type,
                                    correspondencesArray[particleIndex],
                                    _env.correspondences,
                                    &_templateIndex);
    }

    _env.num = numNeighbors + 1;
    _list.resize(numNeighbors);

    if(ptm_type == PTM_MATCH_DCUB || ptm_type == PTM_MATCH_DHEX) {
        num_inner = 4;
        num_outer = 3;
    }
    else if(ptm_type == PTM_MATCH_GRAPHENE) {
        num_inner = 3;
        num_outer = 2;
    }

    fillNeighbors(neighborQuery, particleIndex, 0, num_inner, _env.points[0]);
    if(num_outer != 0) {
        for(int i = 0; i < num_inner; i++) {
            neighborQuery.findNeighbors(_env.atom_indices[1 + i]);
            fillNeighbors(neighborQuery,
                            _env.atom_indices[1 + i],
                            num_inner + i * num_outer,
                            num_outer,
                            _env.points[i + 1]);
        }
    }
}

void PTMNeighborFinder::Query::fillNeighbors(const NeighborQuery& neighborQuery, size_t particleIndex, int offset, int num, const double* delta)
{
    int numNeighbors = neighborQuery.results().size();

    if(numNeighbors < num)
        return;

    if(offset == 0) {
        _env.atom_indices[0] = particleIndex;
        _env.points[0][0] = 0;
        _env.points[0][1] = 0;
        _env.points[0][2] = 0;
    }

    for(int i = 0; i < num; i++) {
        int p = _env.correspondences[i + 1 + offset] - 1;
        _env.atom_indices[i + 1 + offset] = neighborQuery.results()[p].index;
        _env.points[i + 1 + offset][0] = neighborQuery.results()[p].delta.x() + delta[0];
        _env.points[i + 1 + offset][1] = neighborQuery.results()[p].delta.y() + delta[1];
        _env.points[i + 1 + offset][2] = neighborQuery.results()[p].delta.z() + delta[2];
    }
}

void PTMNeighborFinder::Query::calculateRMSDScale()
{
    // Get neighbor points.
    QVarLengthArray<Vector3, PTM_MAX_INPUT_POINTS> centered;
    QVarLengthArray<Vector3, PTM_MAX_INPUT_POINTS> rotatedTemplate;
    centered.push_back(Vector3::Zero());
    rotatedTemplate.push_back(Vector3::Zero());
    Vector3 barycenter = Vector3::Zero();

    for(const Neighbor& nbr : _list) {
        rotatedTemplate.push_back(_orientation * nbr.idealVector);
        centered.push_back(nbr.delta);
        barycenter += nbr.delta;
    }

    barycenter /= centered.size();
    for(Vector3& c : centered)
        c -= barycenter;

    // calculate scale
    // (s.a - b)^2 = s^2.a^2 - 2.s.a.b + b^2
    // d/ds (s^2.a^2 - 2.s.a.b + b^2) = 2.s.a^2 - 2.a.b
    // s.a^2 = a.b
    // s = a.b / (a.a)
    FloatType numerator = 0, denominator = 0;
    for(int i = 0; i < centered.size(); i++) {
        numerator += centered[i].dot(rotatedTemplate[i]);
        denominator += centered[i].squaredLength();
    }
    FloatType scale = numerator / denominator;

    // calculate interatomic distance
    _interatomicDistance = _list[1].idealVector.length() / scale;

    // calculate RMSD
    _rmsd = 0;
    for(int i = 0; i < centered.size(); i++) {
        auto delta = scale * centered[i] - rotatedTemplate[i];
        _rmsd += delta.squaredLength();
    }
    _rmsd = sqrt(_rmsd / centered.size());
}

}   // End of namespace
