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
#include <ovito/stdobj/simcell/SimulationCellObject.h>
#include <ovito/crystalanalysis/modifier/dxa/InterfaceMesh.h>
#include <ovito/crystalanalysis/modifier/dxa/BurgersCircuit.h>
#include "ClusterVector.h"

namespace Ovito::CrystalAnalysis {

/**
 * Every dislocation segment is delimited by two dislocation nodes.
 */
struct OVITO_CRYSTALANALYSIS_EXPORT DislocationNode
{
    /// The dislocation segment delimited by this node.
    DislocationSegment* segment;

    /// The opposite node of the dislocation segment.
    DislocationNode* oppositeNode;

    /// Pointer to the next node in linked list of nodes that form a junction.
    /// If this node is not part of a junction, then this pointer points to the node itself.
    DislocationNode* junctionRing;

    /// The Burgers circuit associated with this node.
    /// This field is only used during dislocation line tracing.
    BurgersCircuit* circuit = nullptr;

    /// Constructor.
    DislocationNode() {
        junctionRing = this;
    }

    /// Returns the (signed) Burgers vector of the node.
    /// This is the Burgers vector of the segment if this node is a forward node,
    /// or the negative Burgers vector if this node is a backward node.
    inline ClusterVector burgersVector() const;

    /// Returns the position of the node by looking up the coordinates of the
    /// start or end point of the dislocation segment to which the node belongs.
    inline const Point3& position() const;

    /// Returns true if this node is the forward node of its segment, that is,
    /// when it is at the end of the associated dislocation segment.
    inline bool isForwardNode() const;

    /// Returns true if this node is the backward node of its segment, that is,
    /// when it is at the beginning of the associated dislocation segment.
    inline bool isBackwardNode() const;

    /// Determines whether the given node forms a junction with the given node.
    bool formsJunctionWith(DislocationNode* other) const {
        DislocationNode* n = this->junctionRing;
        do {
            if(other == n) return true;
            n = n->junctionRing;
        }
        while(n != this->junctionRing);
        return false;
    }

    /// Makes two nodes part of a junction.
    /// If any of the two nodes were already part of a junction, then
    /// a single junction is created that encompasses all nodes.
    void connectNodes(DislocationNode* other) {
        OVITO_ASSERT(!other->formsJunctionWith(this));
        OVITO_ASSERT(!this->formsJunctionWith(other));

        DislocationNode* tempStorage = junctionRing;
        junctionRing = other->junctionRing;
        other->junctionRing = tempStorage;

        OVITO_ASSERT(other->formsJunctionWith(this));
        OVITO_ASSERT(this->formsJunctionWith(other));
    }

    /// If this node is part of a junction, dissolves the junction.
    /// The nodes of all junction arms will become dangling nodes.
    void dissolveJunction() {
        DislocationNode* n = this->junctionRing;
        while(n != this) {
            DislocationNode* next = n->junctionRing;
            n->junctionRing = n;
            n = next;
        }
        this->junctionRing = this;
    }

    /// Counts the number of arms belonging to the junction.
    int countJunctionArms() const {
        int armCount = 1;
        for(DislocationNode* armNode = this->junctionRing; armNode != this; armNode = armNode->junctionRing)
            armCount++;
        return armCount;
    }

    /// Return whether the end of a segment, represented by this node, does not merge into a junction.
    bool isDangling() const {
        return (junctionRing == this);
    }
};

/**
 * A dislocation segment.
 *
 * Each segment has a Burgers vector and consists of a piecewise-linear curve in space.
 *
 * Two dislocation nodes delimit the segment.
 */
struct DislocationSegment
{
    /// The unique identifier of the dislocation segment.
    int id;

    /// The piecewise linear curve in space.
    std::deque<Point3> line;

    /// Stores the circumference of the dislocation core at every sampling point along the line.
    /// This information is used to coarsen the sampling point array adaptively since a large
    /// core size leads to a high sampling rate.
    std::deque<int> coreSize;

    /// The Burgers vector of the dislocation segment. It is expressed in the coordinate system of
    /// the crystal cluster which the segment is embedded in.
    ClusterVector burgersVector;

    /// The two nodes that delimit the segment.
    DislocationNode* nodes[2];

    /// The segment that replaces this discarded segment if the two have been merged into one segment.
    DislocationSegment* replacedWith = nullptr;

    /// A user-defined color assigned to the dislocation segment.
    Color customColor = Color(-1, -1, -1);

    /// Constructs a new dislocation segment with the given Burgers vector
    /// and connecting the two dislocation nodes.
    DislocationSegment(const ClusterVector& b, DislocationNode* forwardNode, DislocationNode* backwardNode) : burgersVector(b) {
        OVITO_ASSERT(b.localVec() != Vector3::Zero());
        nodes[0] = forwardNode;
        nodes[1] = backwardNode;
        forwardNode->segment = this;
        backwardNode->segment = this;
        forwardNode->oppositeNode = backwardNode;
        backwardNode->oppositeNode = forwardNode;
    }

    /// Returns the forward-pointing node at the end of the dislocation segment.
    DislocationNode& forwardNode() const { return *nodes[0]; }

    /// Returns the backward-pointing node at the start of the dislocation segment.
    DislocationNode& backwardNode() const { return *nodes[1]; }

    /// Returns true if this segment forms a closed loop, that is, when its two nodes form a single 2-junction.
    /// Note that an infinite dislocation line, passing through a periodic boundary, is also considered a loop.
    bool isClosedLoop() const {
        OVITO_ASSERT(nodes[0] && nodes[1]);
        return (nodes[0]->junctionRing == nodes[1]) && (nodes[1]->junctionRing == nodes[0]);
    }

    /// Returns true if this segment is an infinite dislocation line passing through a periodic boundary.
    /// A segment is considered infinite if it is a closed loop but its start and end points do not coincide.
    bool isInfiniteLine() const {
        return isClosedLoop() && line.back().equals(line.front(), CA_ATOM_VECTOR_EPSILON) == false;
    }

    /// Calculates the line length of the segment.
    FloatType calculateLength() const {
        OVITO_ASSERT(!isDegenerate());

        FloatType length = 0;
        auto i1 = line.begin();
        for(;;) {
            auto i2 = i1 + 1;
            if(i2 == line.end()) break;
            length += (*i1 - *i2).length();
            i1 = i2;
        }
        return length;
    }

    /// Returns true if this segment's curve consists of less than two points.
    bool isDegenerate() const { return line.size() <= 1; }

    /// Reverses the direction of the segment.
    /// This flips both the line sense and the segment's Burgers vector.
    void flipOrientation() {
        burgersVector = -burgersVector;
        std::swap(nodes[0], nodes[1]);
        std::reverse(line.begin(), line.end());
        std::reverse(coreSize.begin(), coreSize.end());
    }

    /// Computes the location of a point along the segment line.
    Point3 getPointOnLine(FloatType t) const;
};

/// Returns true if this node is the forward node of its segment, that is,
/// when it is at the end of the associated dislocation segment.
inline bool DislocationNode::isForwardNode() const
{
    return &segment->forwardNode() == this;
}

/// Returns true if this node is the backward node of its segment, that is,
/// when it is at the beginning of the associated dislocation segment.
inline bool DislocationNode::isBackwardNode() const
{
    return &segment->backwardNode() == this;
}

/// Returns the (signed) Burgers vector of the node.
/// This is the Burgers vector of the segment if this node is a forward node,
/// or the negative Burgers vector if this node is a backward node.
inline ClusterVector DislocationNode::burgersVector() const
{
    if(isForwardNode())
        return segment->burgersVector;
    else
        return -segment->burgersVector;
}

/// Returns the position of the node by looking up the coordinates of the
/// start or end point of the dislocation segment to which the node belongs.
inline const Point3& DislocationNode::position() const
{
    if(isForwardNode())
        return segment->line.back();
    else
        return segment->line.front();
}

/**
 * This class holds the entire network of dislocation segments.
 */
class OVITO_CRYSTALANALYSIS_EXPORT DislocationNetwork
{
public:

    /// Constructor that creates an empty dislocation network.
    explicit DislocationNetwork(std::shared_ptr<ClusterGraph> clusterGraph) : _clusterGraph(std::move(clusterGraph)) {}

    /// Copy constructor.
    DislocationNetwork(const DislocationNetwork& other);

    /// Returns a const-reference to the cluster graph.
    const std::shared_ptr<ClusterGraph>& clusterGraph() const { return _clusterGraph; }

    /// Returns the list of dislocation segments.
    const std::vector<DislocationSegment*>& segments() const { return _segments; }

    /// Allocates a new dislocation segment terminated by two nodes.
    DislocationSegment* createSegment(const ClusterVector& burgersVector);

    /// Removes a segment from the global list of segments.
    void discardSegment(DislocationSegment* segment);

    /// Smoothens and coarsens the dislocation lines.
    bool smoothDislocationLines(int lineSmoothingLevel, FloatType linePointInterval, ProgressingTask& operation);

private:

    /// Smoothes the sampling points of a dislocation line.
    static void smoothDislocationLine(int smoothingLevel, std::deque<Point3>& line, bool isLoop);

    /// Removes some of the sampling points from a dislocation line.
    static void coarsenDislocationLine(FloatType linePointInterval, const std::deque<Point3>& input, const std::deque<int>& coreSize, std::deque<Point3>& output, std::deque<int>& outputCoreSize, bool isClosedLoop, bool isInfiniteLine);

    /// The associated cluster graph.
    const std::shared_ptr<ClusterGraph> _clusterGraph;

    // Used to allocate memory for DislocationNode instances.
    MemoryPool<DislocationNode> _nodePool;

    /// The list of dislocation segments.
    std::vector<DislocationSegment*> _segments;

    /// Used to allocate memory for DislocationSegment objects.
    MemoryPool<DislocationSegment> _segmentPool;
};

}   // End of namespace
