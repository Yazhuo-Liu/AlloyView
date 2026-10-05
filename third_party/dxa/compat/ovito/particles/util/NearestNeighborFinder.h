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
#include <ovito/stdobj/simcell/SimulationCellObject.h>
#include <ovito/stdobj/properties/PropertyObject.h>
#include <ovito/core/utilities/BoundedPriorityQueue.h>
#include <ovito/core/utilities/MemoryPool.h>

namespace Ovito::Particles {

/**
 * \brief This utility class finds the *k* nearest neighbors of a particle or around some point in space.
 *        *k* is a positive integer.
 *
 * OVITO provides two facilities for finding the neighbors of particles: The CutoffNeighborFinder class, which
 * finds all neighbors within a certain cutoff radius, and the NearestNeighborFinder class, which finds
 * the *k* nearest neighbor of a particle, where *k* is some positive integer. Note that the cutoff-based neighbor finder
 * can return an unknown number of neighbor particles, while the nearest neighbor finder will return exactly
 * the requested number of nearest neighbors (ordered by increasing distance from the central particle).
 * Whether CutoffNeighborFinder or NearestNeighborFinder is the right choice depends on the application.
 *
 * The NearestNeighborFinder class must be initialized by a call to prepare(). This function sorts all input particles
 * in a binary search for fast nearest neighbor queries.
 *
 * After the NearestNeighborFinder has been initialized, one can find the nearest neighbors of some central
 * particle by constructing an instance of the NearestNeighborFinder::Query class. This is a light-weight class generates
 * the sorted list of nearest neighbors of a particle.
 *
 * The NearestNeighborFinder class takes into account periodic boundary conditions. With periodic boundary conditions,
 * a particle can be appear multiple times in the neighbor list of another particle. Note, however, that a different neighbor *vector* is
 * reported for each periodic image of a neighbor.
 */
class OVITO_PARTICLES_EXPORT NearestNeighborFinder
{
private:

    // Internal data structure for each input particle.
    struct NeighborListAtom {
        /// The next atom in the linked list used for binning.
        NeighborListAtom* nextInBin;
        /// The wrapped position of the atom.
        Point3 pos;
    };

    struct OVITO_PARTICLES_EXPORT TreeNode
    {
        /// Constructor.
        TreeNode() : atoms(nullptr), numAtoms(0) {}

        /// Returns true this is a leaf node.
        bool isLeaf() const { return splitDim == -1; }

        /// Converts the min/max corner vertices of this node and all its children to absolute coordinates.
        void convertToAbsoluteCoordinates(const AffineTransformation& cellMatrix) {
            bounds.minc = cellMatrix * bounds.minc;
            bounds.maxc = cellMatrix * bounds.maxc;
            if(!isLeaf()) {
                children[0]->convertToAbsoluteCoordinates(cellMatrix);
                children[1]->convertToAbsoluteCoordinates(cellMatrix);
            }
        }

        /// The splitting direction (or -1 if this is a leaf node).
        int splitDim = -1;
        union {
            struct {
                /// The two child nodes (if this is not a leaf node).
                TreeNode* children[2];
                /// The position of the split plane.
                FloatType splitPos;
            };
            struct {
                /// The linked list of atoms (if this is a leaf node).
                NeighborListAtom* atoms;
                /// Number of atoms in this leaf node.
                int numAtoms;
            };
        };
        /// The bounding box of the node.
        Box3 bounds;
    };

public:

    /// Constructor that builds the binary search tree.
    NearestNeighborFinder(int _numNeighbors = 16) : numNeighbors(_numNeighbors) {
        bucketSize = std::max(_numNeighbors / 2, 8);
    }

    /// \brief Prepares the tree data structure.
    /// \param posProperty The positions of the particles.
    /// \param cellData The simulation cell data.
    /// \param selectionProperty Determines which particles are included in the neighbor search (optional).
    /// \return \c false when the operation has been canceled by the user;
    ///         \c true on success.
    /// \throw Exception on error.
    bool prepare(BufferReadAccess<Point3> posProperty, const SimulationCellObject* cellData, BufferReadAccess<SelectionIntType> selectionProperty);

    /// Returns the maximum number of neighbors this class will find.
    int maxNeighbors() const { return numNeighbors; }

    /// Returns the number of input particles in the system for which the NearestNeighborFinder was created.
    size_t particleCount() const {
        return atoms.size();
    }

    /// Returns the coordinates of the i-th input particle.
    const Point3& particlePos(size_t index) const {
        OVITO_ASSERT(index >= 0 && index < atoms.size());
        return atoms[index].pos;
    }

    /// Returns the index of the particle closest to the given point.
    size_t findClosestParticle(const Point3& query_point, FloatType& closestDistanceSq, bool includeSelf = true) const {
        size_t closestIndex = std::numeric_limits<size_t>::max();
        closestDistanceSq = FLOATTYPE_MAX;
        auto visitor = [&closestIndex, &closestDistanceSq](const Neighbor& n, FloatType& mrs) {
            if(n.distanceSq < closestDistanceSq) {
                mrs = closestDistanceSq = n.distanceSq;
                closestIndex = n.index;
            }
        };
        visitNeighbors(query_point, visitor, includeSelf);
        return closestIndex;
    }

    /// Information associated with each neighbor of the current center particle.
    struct Neighbor
    {
        Vector3 delta;
        FloatType distanceSq;
        size_t index;

        /// For ordering the neighbors by distance.
        bool operator<(const Neighbor& other) const { return distanceSq < other.distanceSq; }
    };

    /// Iterator over the nearest neighbors of a central particle.
    template<int MAX_NEIGHBORS_LIMIT>
    class Query
    {
    public:

        /// Constructor.
        Query(const NearestNeighborFinder& finder) : t(finder), queue(finder.numNeighbors), inverseCellMatrix(finder.inverseCellMatrix) {}

        /// Builds the sorted list of neighbors around the given particle.
        void findNeighbors(size_t particleIndex) {
            findNeighbors(t.particlePos(particleIndex), false);
        }

        /// Builds the sorted list of neighbors around the given point.
        void findNeighbors(const Point3& query_point, bool includeSelf) {
            queue.clear();
            for(const Vector3& pbcShift : t.pbcImages) {
                q = query_point - pbcShift;
                if(!queue.full() || queue.top().distanceSq > t.minimumDistance(t.root, q)) {
                    qr = inverseCellMatrix * q;
                    visitNode(t.root, includeSelf);
                }
            }
            queue.sort();
        }

        /// Returns the neighbor list.
        const BoundedPriorityQueue<Neighbor, std::less<Neighbor>, MAX_NEIGHBORS_LIMIT>& results() const { return queue; }

    private:

        /// Inserts all particles of the given leaf node into the priority queue.
        void visitNode(TreeNode* node, bool includeSelf) {
            if(node->isLeaf()) {
                for(NeighborListAtom* atom = node->atoms; atom != nullptr; atom = atom->nextInBin) {
                    Neighbor n;
                    n.delta = atom->pos - q;
                    n.distanceSq = n.delta.squaredLength();
                    if(includeSelf || n.distanceSq != 0) {
                        n.index = atom - t.atoms.data();
                        queue.insert(n);
                    }
                }
            }
            else {
                TreeNode* cnear;
                TreeNode* cfar;
                if(qr[node->splitDim] < node->splitPos) {
                    cnear = node->children[0];
                    cfar  = node->children[1];
                }
                else {
                    cnear = node->children[1];
                    cfar  = node->children[0];
                }
                visitNode(cnear, includeSelf);
                if(!queue.full() || queue.top().distanceSq > t.minimumDistance(cfar, q))
                    visitNode(cfar, includeSelf);
            }
        }

    protected:
        const NearestNeighborFinder& t;
        Point3 q, qr;
        BoundedPriorityQueue<Neighbor, std::less<Neighbor>, MAX_NEIGHBORS_LIMIT> queue;
        const AffineTransformation inverseCellMatrix;
    };

    template<class Visitor>
    void visitNeighbors(const Point3& query_point, Visitor& v, bool includeSelf = false) const {
        FloatType mrs = FLOATTYPE_MAX;
        for(const Vector3& pbcShift : pbcImages) {
            Point3 q = query_point - pbcShift;
            if(mrs > minimumDistance(root, q)) {
                visitNode(root, q, inverseCellMatrix * q, v, mrs, includeSelf);
            }
        }
    }

private:

    /// Inserts a particle into the binary tree.
    void insertParticle(NeighborListAtom* atom, const Point3& p, TreeNode* node, int depth);

    /// Splits a leaf node into two new leaf nodes and redistributes the atoms to the child nodes.
    void splitLeafNode(TreeNode* node, int splitDim);

    /// Determines in which direction to split the given leaf node.
    int determineSplitDirection(TreeNode* node);

    /// Computes the minimum distance from the query point to the bounding box of the given node.
    FloatType minimumDistance(TreeNode* node, const Point3& query_point) const {
        Vector3 p1 = node->bounds.minc - query_point;
        Vector3 p2 = query_point - node->bounds.maxc;
        FloatType minDistance = 0;
        for(size_t dim = 0; dim < 3; dim++) {
            FloatType t_min = planeNormals[dim].dot(p1);
            if(t_min > minDistance) minDistance = t_min;
            FloatType t_max = planeNormals[dim].dot(p2);
            if(t_max > minDistance) minDistance = t_max;
        }
        return minDistance * minDistance;
    }

    template<class Visitor>
    void visitNode(TreeNode* node, const Point3& q, const Point3& qr, Visitor& v, FloatType& mrs, bool includeSelf) const {
        if(node->isLeaf()) {
            for(NeighborListAtom* atom = node->atoms; atom != nullptr; atom = atom->nextInBin) {
                Neighbor n;
                n.delta = atom->pos - q;
                n.distanceSq = n.delta.squaredLength();
                if(includeSelf || n.distanceSq != 0) {
                    n.index = atom - atoms.data();
                    v(n, mrs);
                }
            }
        }
        else {
            TreeNode* cnear;
            TreeNode* cfar;
            if(qr[node->splitDim] < node->splitPos) {
                cnear = node->children[0];
                cfar  = node->children[1];
            }
            else {
                cnear = node->children[1];
                cfar  = node->children[0];
            }
            visitNode(cnear, q, qr, v, mrs, includeSelf);
            if(mrs > minimumDistance(cfar, q))
                visitNode(cfar, q, qr, v, mrs, includeSelf);
        }
    }

private:

    /// The internal list of atoms.
    std::vector<NeighborListAtom> atoms;

    /// Simulation cell.
    DataOORef<const SimulationCellObject> simCell;

    /// Simulation cell matrix.
    AffineTransformation cellMatrix;

    /// Reciprocal simulation cell matrix.
    AffineTransformation inverseCellMatrix;

    /// The squared lengths of the simulation cell vectors.
    FloatType cellVectorLengthsSquared[3];

    /// The normal vectors of the three cell planes.
    Vector3 planeNormals[3];

    /// Used to allocate instances of TreeNode.
    MemoryPool<TreeNode> nodePool;

    /// The root node of the binary tree.
    TreeNode* root;

    /// The number of neighbors to finds for each atom.
    int numNeighbors;

    /// The maximum number of particles per leaf node.
    int bucketSize;

    /// List of pbc image shift vectors.
    std::vector<Vector3> pbcImages;

    /// The number of leaf nodes in the tree.
    int numLeafNodes = 0;

    /// The maximum depth of this binary tree.
    int maxTreeDepth = 1;
};

}   // End of namespace
