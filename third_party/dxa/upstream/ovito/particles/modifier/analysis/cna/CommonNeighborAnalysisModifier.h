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
namespace Ovito {
class CommonNeighborAnalysisModifier {
public:
    /// Pair of neighbor atoms that form a bond (bit-wise storage).
    typedef unsigned int CNAPairBond;

    /**
     * A bit-flag array indicating which pairs of neighbors are bonded
     * and which are not.
     */
    struct NeighborBondArray
    {
        /// Two-dimensional bit array that stores the bonds between neighbors.
        unsigned int neighborArray[32];

        /// Resets all bits.
        NeighborBondArray() {
            memset(neighborArray, 0, sizeof(neighborArray));
        }

        /// Returns whether two nearest neighbors have a bond between them.
        inline bool neighborBond(int neighborIndex1, int neighborIndex2) const {
            OVITO_ASSERT(neighborIndex1 < 32);
            OVITO_ASSERT(neighborIndex2 < 32);
            return (neighborArray[neighborIndex1] & (1<<neighborIndex2));
        }

        /// Sets whether two nearest neighbors have a bond between them.
        inline void setNeighborBond(int neighborIndex1, int neighborIndex2, bool bonded) {
            OVITO_ASSERT(neighborIndex1 < 32);
            OVITO_ASSERT(neighborIndex2 < 32);
            if(bonded) {
                neighborArray[neighborIndex1] |= (1<<neighborIndex2);
                neighborArray[neighborIndex2] |= (1<<neighborIndex1);
            }
            else {
                neighborArray[neighborIndex1] &= ~(1<<neighborIndex2);
                neighborArray[neighborIndex2] &= ~(1<<neighborIndex1);
            }
        }
    };

    static int findCommonNeighbors(const NeighborBondArray&, int, unsigned int&);
    static int findNeighborBonds(const NeighborBondArray&, unsigned int, int, CNAPairBond*);
    static int calcMaxChainLength(CNAPairBond*, int);
};
}
