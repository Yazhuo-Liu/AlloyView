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

#include "CommonNeighborAnalysisModifier.h"
namespace Ovito {
int CommonNeighborAnalysisModifier::findCommonNeighbors(const NeighborBondArray& neighborArray, int neighborIndex, unsigned int& commonNeighbors)
{
    commonNeighbors = neighborArray.neighborArray[neighborIndex];
#ifndef Q_CC_MSVC
    // Count the number of bits set in neighbor bit-field.
    return __builtin_popcount(commonNeighbors);
#else
    // Count the number of bits set in neighbor bit-field.
    unsigned int v = commonNeighbors - ((commonNeighbors >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    return ((v + (v >> 4) & 0xF0F0F0F) * 0x1010101) >> 24;
#endif
}

/******************************************************************************
* Finds all bonds between common nearest neighbors.
******************************************************************************/
int CommonNeighborAnalysisModifier::findNeighborBonds(const NeighborBondArray& neighborArray, unsigned int commonNeighbors, int numNeighbors, CNAPairBond* neighborBonds)
{
    int numBonds = 0;

    unsigned int nib[32];
    int nibn = 0;
    unsigned int ni1b = 1;
    for(int ni1 = 0; ni1 < numNeighbors; ni1++, ni1b <<= 1) {
        if(commonNeighbors & ni1b) {
            unsigned int b = commonNeighbors & neighborArray.neighborArray[ni1];
            for(int n = 0; n < nibn; n++) {
                if(b & nib[n]) {
                    neighborBonds[numBonds++] = ni1b | nib[n];
                }
            }
            nib[nibn++] = ni1b;
        }
    }
    return numBonds;
}

/******************************************************************************
* Find all chains of bonds.
******************************************************************************/
static int getAdjacentBonds(unsigned int atom, CommonNeighborAnalysisModifier::CNAPairBond* bondsToProcess, int& numBonds, unsigned int& atomsToProcess, unsigned int& atomsProcessed)
{
    int adjacentBonds = 0;
    for(int b = numBonds - 1; b >= 0; b--) {
        if(atom & *bondsToProcess) {
            ++adjacentBonds;
            atomsToProcess |= *bondsToProcess & (~atomsProcessed);
            memmove(bondsToProcess, bondsToProcess + 1, sizeof(CommonNeighborAnalysisModifier::CNAPairBond) * b);
            numBonds--;
        }
        else ++bondsToProcess;
    }
    return adjacentBonds;
}

/******************************************************************************
* Find all chains of bonds between common neighbors and determine the length
* of the longest continuous chain.
******************************************************************************/
int CommonNeighborAnalysisModifier::calcMaxChainLength(CNAPairBond* neighborBonds, int numBonds)
{
    // Group the common bonds into clusters.
    int maxChainLength = 0;
    while(numBonds) {
        // Make a new cluster starting with the first remaining bond to be processed.
        numBonds--;
        unsigned int atomsToProcess = neighborBonds[numBonds];
        unsigned int atomsProcessed = 0;
        int clusterSize = 1;
        do {
#ifndef Q_CC_MSVC
            // Determine the number of trailing 0-bits in atomsToProcess, starting at the least significant bit position.
            int nextAtomIndex = __builtin_ctz(atomsToProcess);
#else
            unsigned long nextAtomIndex;
            _BitScanForward(&nextAtomIndex, atomsToProcess);
            OVITO_ASSERT(nextAtomIndex >= 0 && nextAtomIndex < 32);
#endif
            unsigned int nextAtom = 1 << nextAtomIndex;
            atomsProcessed |= nextAtom;
            atomsToProcess &= ~nextAtom;
            clusterSize += getAdjacentBonds(nextAtom, neighborBonds, numBonds, atomsToProcess, atomsProcessed);
        }
        while(atomsToProcess);
        if(clusterSize > maxChainLength)
            maxChainLength = clusterSize;
    }
    return maxChainLength;
}


}
