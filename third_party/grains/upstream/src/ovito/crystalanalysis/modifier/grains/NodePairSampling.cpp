////////////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2023 OVITO GmbH, Germany
//  Copyright 2020 Peter Mahler Larsen
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

#include <ovito/crystalanalysis/CrystalAnalysis.h>
#include "GrainSegmentationEngine.h"

namespace Ovito::CrystalAnalysis {

/******************************************************************************
* Clustering using pair sampling algorithm.
******************************************************************************/
bool GrainSegmentationEngine1::node_pair_sampling_clustering(GrainSegmentationEngine1::Graph& graph, std::vector<Quaternion>& qsum)
{
    FloatType totalWeight = 1;

    size_t progress = 0;
    std::vector<size_t> chain;
    while(graph.num_nodes()) {

        // nearest-neighbor chain
        size_t node = graph.next_node();
        OVITO_ASSERT(node != std::numeric_limits<size_t>::max());

        chain.push_back(node);
        while(!chain.empty()) {

            size_t a = chain.back();
            chain.pop_back();
            OVITO_ASSERT(a != std::numeric_limits<size_t>::max());

            auto [d, b] = graph.nearest_neighbor(a);
            if(b == std::numeric_limits<size_t>::max()) {
                OVITO_ASSERT(chain.size() == 0);
                // Remove the connected component
                graph.remove_node(a);
            }
            else if(!chain.empty()) {
                size_t c = chain.back();
                chain.pop_back();

                if(b == c) {
                    size_t parent = graph.contract_edge(a, b);
                    size_t child = (parent == a) ? b : a;

                    FloatType disorientation = calculate_disorientation(_adjustedStructureTypes[parent], qsum[parent], qsum[child]);
                    _dendrogram.emplace_back(parent, child, d / totalWeight, disorientation, 1, qsum[parent]);

                    // Update progress indicator.
                    if((progress++ % 1024) == 0) {
                        if(!incrementProgressValue(1024))
                            return false;
                    }
                }
                else {
                    OVITO_ASSERT(a != std::numeric_limits<size_t>::max());
                    OVITO_ASSERT(b != std::numeric_limits<size_t>::max());
                    OVITO_ASSERT(c != std::numeric_limits<size_t>::max());
                    chain.push_back(c);
                    chain.push_back(a);
                    chain.push_back(b);
                }
            }
            else {
                OVITO_ASSERT(a != std::numeric_limits<size_t>::max());
                OVITO_ASSERT(b != std::numeric_limits<size_t>::max());
                chain.push_back(a);
                chain.push_back(b);
            }
        }
    }

    return true;
}

}   // End of namespace
