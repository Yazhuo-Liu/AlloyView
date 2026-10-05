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

#include "compat/compat.h"
#include "DelaunayTessellation.h"

#include <random>
#include <cstdlib>

namespace Ovito::Delaunay {

/******************************************************************************
* Generates the tessellation.
******************************************************************************/
bool DelaunayTessellation::generateTessellation(const SimulationCellObject* simCell, const Point3* positions, size_t numPoints, FloatType ghostLayerSize, bool coverDomainWithFiniteTets, const SelectionIntType* selectedPoints, ProgressingTask& operation)
{
    operation.setProgressMaximum(0);

    // Initialize the Geogram library.
    GEO::initialize(GEO::GEOGRAM_NO_HANDLER);
    GEO::set_assert_mode(GEO::ASSERT_ABORT);

    // Make the magnitude of the randomly perturbed particle positions dependent on the size of the system.
    double lengthScale;
    if(simCell) {
        lengthScale = (simCell->matrix().column(0) + simCell->matrix().column(1) + simCell->matrix().column(2)).length();
    }
    else {
        Box3 bbox;
        bbox.addPoints(positions, numPoints);
        lengthScale = bbox.size().length();
    }
    double epsilon = 1e-10 * lengthScale;

    // Set up random number generator to generate random perturbations.
    std::mt19937 rng;
    std::uniform_real_distribution<double> displacement(-epsilon, epsilon);
    // Use fixed seed value for the sake of reproducibility.
    rng.seed(4);

    _simCell = simCell;

    // Build the list of input points.
    _particleIndices.clear();
    _pointData.clear();

    for(size_t i = 0; i < numPoints; i++, ++positions) {

        // Skip points which are not included.
        if(selectedPoints && !*selectedPoints++)
            continue;

        // Add a small random perturbation to the particle positions to make the Delaunay triangulation more robust
        // against singular input data, e.g. all particles positioned on ideal crystal lattice sites.
        Point3 wp = simCell ? simCell->wrapPoint(*positions) : *positions;
        _pointData.emplace_back(
            (double)wp.x() + displacement(rng),
            (double)wp.y() + displacement(rng),
            (double)wp.z() + displacement(rng));

        _particleIndices.push_back(i);

        if(operation.isCanceled())
            return false;
    }
    _primaryVertexCount = _particleIndices.size();

    if(simCell) {
        // Determine how many periodic copies of the input particles are needed in each cell direction
        // to ensure a consistent periodic topology in the border region.
        Vector3I stencilCount;
        FloatType cuts[3][2];
        Vector3 cellNormals[3];
        for(size_t dim = 0; dim < 3; dim++) {
            cellNormals[dim] = simCell->cellNormalVector(dim);
            cuts[dim][0] = cellNormals[dim].dot(simCell->reducedToAbsolute(Point3(0,0,0)) - Point3::Origin());
            cuts[dim][1] = cellNormals[dim].dot(simCell->reducedToAbsolute(Point3(1,1,1)) - Point3::Origin());

            if(simCell->hasPbc(dim)) {
                stencilCount[dim] = (int)ceil(ghostLayerSize / simCell->matrix().column(dim).dot(cellNormals[dim]));
                cuts[dim][0] -= ghostLayerSize;
                cuts[dim][1] += ghostLayerSize;
            }
            else {
                stencilCount[dim] = 0;
                cuts[dim][0] -= ghostLayerSize;
                cuts[dim][1] += ghostLayerSize;
            }
        }

        // Create ghost images of input vertices.
        for(int ix = -stencilCount[0]; ix <= +stencilCount[0]; ix++) {
            for(int iy = -stencilCount[1]; iy <= +stencilCount[1]; iy++) {
                for(int iz = -stencilCount[2]; iz <= +stencilCount[2]; iz++) {
                    if(ix == 0 && iy == 0 && iz == 0) continue;

                    Vector3 shift = simCell->reducedToAbsolute(Vector3(ix,iy,iz));
                    for(size_t vertexIndex = 0; vertexIndex < _primaryVertexCount; vertexIndex++) {
                        if(operation.isCanceled())
                            return false;

                        Point3 pimage = _pointData[vertexIndex] + shift;
                        bool isClipped = false;
                        for(size_t dim = 0; dim < 3; dim++) {
                            if(simCell->hasPbc(dim)) {
                                FloatType d = cellNormals[dim].dot(pimage - Point3::Origin());
                                if(d < cuts[dim][0] || d > cuts[dim][1]) {
                                    isClipped = true;
                                    break;
                                }
                            }
                        }
                        if(!isClipped) {
                            _pointData.push_back(pimage);
                            _particleIndices.push_back(_particleIndices[vertexIndex]);
                        }
                    }
                }
            }
        }
    }

    // In order to cover the simulation box completely with finite tetrahedra, add 8 extra input points to the Delaunay tessellation,
    // far away from the simulation cell and real particles. These 8 points form a convex hull, whose interior will get completely tessellated.
    if(coverDomainWithFiniteTets) {
        OVITO_ASSERT(simCell);

        // Compute bounding box of input points and simulation cell.
        Box3 bb = Box3(Point3(0), Point3(1)).transformed(simCell->matrix());
        bb.addPoints(_pointData.data(), _pointData.size());
        // Add extra padding.
        bb.padBox(ghostLayerSize);
        // Create 8 helper points at the corners of the bounding box.
        for(size_t i = 0; i < 8; i++) {
            Point3 corner = bb[i];
            _pointData.push_back(corner);
            _particleIndices.push_back(std::numeric_limits<size_t>::max());
        }
    }

    // Create the internal Delaunay generator object.
    _dt = GEO::Delaunay::create(3, "BDEL");
    _dt->set_keeps_infinite(true);
    _dt->set_reorder(true);

    // The internal compute_BRIO_order() routine of Geogram uses std::random_shuffle() to randomize the
    // input points. This results in unstable ordering of the Delaunay cell list, unless we fix the seed number:
    std::srand(1);
    GEO::Numeric::random_reset();

    // Construct Delaunay tessellation.
    bool result = _dt->set_vertices(_pointData.size(), reinterpret_cast<const double*>(_pointData.data()), [&operation](size_t value, size_t maxProgress) {
        operation.setProgressMaximum(maxProgress, false);
        return operation.setProgressValueIntermittent(value);
    });
    if(!result) return false;

    // Classify tessellation cells as ghost or local cells.
    _numPrimaryTetrahedra = 0;
    _cellInfo.resize(_dt->nb_cells());
    for(CellIterator cellIter = begin_cells(); cellIter != end_cells(); ++cellIter) {
        CellHandle cell = *cellIter;
        if(classifyGhostCell(cell)) {
            _cellInfo[cell].isGhost = true;
            _cellInfo[cell].index = -1;
        }
        else {
            _cellInfo[cell].isGhost = false;
            _cellInfo[cell].index = _numPrimaryTetrahedra++;
        }
    }

    return true;
}

/******************************************************************************
* Determines whether the given tetrahedral cell is a ghost cell (or an invalid cell).
******************************************************************************/
bool DelaunayTessellation::classifyGhostCell(CellHandle cell) const
{
    if(!isFiniteCell(cell))
        return true;

    // Find head vertex with the lowest index.
    VertexHandle headVertex = cellVertex(cell, 0);
    size_t headVertexIndex = vertexIndex(headVertex);
    for(int v = 1; v < 4; v++) {
        VertexHandle p = cellVertex(cell, v);
        size_t vindex = vertexIndex(p);
        if(vindex < headVertexIndex) {
            headVertex = p;
            headVertexIndex = vindex;
        }
    }

    return isGhostVertex(headVertex);
}

/******************************************************************************
* Computes the dterminant of a 3x3 matrix.
******************************************************************************/
static inline double determinant(double a00, double a01, double a02,
                                 double a10, double a11, double a12,
                                 double a20, double a21, double a22)
{
    double m02 = a00*a21 - a20*a01;
    double m01 = a00*a11 - a10*a01;
    double m12 = a10*a21 - a20*a11;
    double m012 = m01*a22 - m02*a12 + m12*a02;
    return m012;
}

/******************************************************************************
* Alpha test routine.
******************************************************************************/
std::optional<bool> DelaunayTessellation::alphaTest(CellHandle cell, FloatType alpha) const
{
    auto v0 = _dt->vertex_ptr(cellVertex(cell, 0));
    auto v1 = _dt->vertex_ptr(cellVertex(cell, 1));
    auto v2 = _dt->vertex_ptr(cellVertex(cell, 2));
    auto v3 = _dt->vertex_ptr(cellVertex(cell, 3));

    auto qpx = v1[0]-v0[0];
    auto qpy = v1[1]-v0[1];
    auto qpz = v1[2]-v0[2];
    auto qp2 = qpx*qpx + qpy*qpy + qpz*qpz;
    auto rpx = v2[0]-v0[0];
    auto rpy = v2[1]-v0[1];
    auto rpz = v2[2]-v0[2];
    auto rp2 = rpx*rpx + rpy*rpy + rpz*rpz;
    auto spx = v3[0]-v0[0];
    auto spy = v3[1]-v0[1];
    auto spz = v3[2]-v0[2];
    auto sp2 = spx*spx + spy*spy + spz*spz;

    auto num_x = determinant(qpy,qpz,qp2,rpy,rpz,rp2,spy,spz,sp2);
    auto num_y = determinant(qpx,qpz,qp2,rpx,rpz,rp2,spx,spz,sp2);
    auto num_z = determinant(qpx,qpy,qp2,rpx,rpy,rp2,spx,spy,sp2);
    auto den   = determinant(qpx,qpy,qpz,rpx,rpy,rpz,spx,spy,spz);

    FloatType nomin = (num_x*num_x + num_y*num_y + num_z*num_z);
    FloatType denom = (4 * den * den);

#if 0
    // Code is only used for debugging purposes:
    std::array<int,4> searchVertexIds1 = {180620, 458358, 474869, 1603607};
    std::array<int,4> vertexIds;
    for(int v = 0; v < 4; v++)
        vertexIds[v] = cellVertex(cell, v);
    std::sort(vertexIds.begin(), vertexIds.end());
    if(vertexIds == searchVertexIds1)
        qInfo() << "Found element 1 " << "nomin=" << nomin << "denom=" << denom << "(nomin / denom)=" << (nomin / denom) << "alpha=" << alpha;
#endif

    // Detect degnerate sliver elements, for which we cannot compute a reliable alpha value.
    if(std::abs(denom) < 1e-9 && std::abs(nomin) < 1e-9) {
        return {}; // Indeterminate result
    }

    return (nomin / denom) < alpha;
}

}   // End of namespace
