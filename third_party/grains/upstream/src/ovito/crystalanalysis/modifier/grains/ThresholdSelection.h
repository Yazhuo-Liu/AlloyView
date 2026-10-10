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

namespace {

FloatType calculate_median(std::vector< FloatType >& data)
{
    size_t n = data.size();
    std::sort(data.begin(), data.end());
    FloatType median = data[n / 2];
    if (n % 2 == 0) {
        median += data[n / 2 - 1];
        median /= 2;
    }

    return median;
}

void weighted_linear_regression(std::vector< FloatType >& weights, std::vector< FloatType >& xs, std::vector< FloatType >& ys,
                                FloatType& gradient, FloatType& intercept)
{
    // Normalize weights
    FloatType wsum = 0;
    for (auto w: weights) {
        wsum += w;
    }

    for (size_t i=0;i<weights.size();i++) {
        weights[i] /= wsum;
    }

    // Calculate means
    FloatType xmean = 0, ymean = 0;
    for (size_t i=0;i<weights.size();i++) {
        xmean += weights[i] * xs[i];
        ymean += weights[i] * ys[i];
    }

    // Calculate relevant covariance elements
    FloatType sum_xx = 0, sum_xy = 0;
    for (size_t i=0;i<weights.size();i++) {
        sum_xx += weights[i] * (xs[i] - xmean) * (xs[i] - xmean);
        sum_xy += weights[i] * (xs[i] - xmean) * (ys[i] - ymean);
    }

    // Calculate gradient and intercept
    gradient = sum_xy / sum_xx;
    intercept = ymean - gradient * xmean;
}

std::vector< FloatType > least_absolute_deviations(std::vector< FloatType >& weights, std::vector< FloatType >& xs, std::vector< FloatType >& ys,
                                                     FloatType& gradient, FloatType& intercept)
{
    std::vector< FloatType > residuals(weights.size());
    std::vector< FloatType > w(weights);

    // Iteratively-reweighted least squares
    for (int it=0;it<100;it++) {
        weighted_linear_regression(w, xs, ys, gradient, intercept);

        // Update residuals and weights
        for (size_t i=0;i<xs.size();i++) {
            FloatType prediction = gradient * xs[i] + intercept;
            FloatType r = std::abs(ys[i] - prediction);
            residuals[i] = r;
            w[i] = weights[i] / std::max(1E-4, r);
        }
    }

    return residuals;
}

} // End of anonymous namespace


/******************************************************************************
* Calculate a threshold suggestion
******************************************************************************/
namespace ThresholdSelection {

class Regressor
{
public:

    FloatType gradient = 0, intercept = 0;
    FloatType mean_absolute_deviation = 0;
    std::vector< FloatType > residuals;
    std::vector< FloatType > xs;
    std::vector< FloatType > ys;
    std::vector< FloatType > weights;

    Regressor(std::vector<GrainSegmentationEngine1::DendrogramNode>& dendrogram)
    {
        if (dendrogram.size() == 0)
            return;

        for (auto node: dendrogram) {
            weights.push_back(node.merge_size);
            xs.push_back(log(node.merge_size));
            ys.push_back(log(node.distance));
        }

        residuals = least_absolute_deviations(weights, xs, ys, gradient, intercept);
        mean_absolute_deviation = calculate_median(residuals);
    }

    FloatType calculate_threshold(std::vector<GrainSegmentationEngine1::DendrogramNode>& dendrogram, FloatType cutoff)
    {
        // Select the threshold as the inlier with the largest distance.
        FloatType threshold = 0;
        for(auto node : dendrogram) {
            FloatType x = log(node.merge_size);
            FloatType y = log(node.distance);

            FloatType prediction = x * gradient + intercept;
            FloatType residual = y - prediction;
            if (residual < cutoff * mean_absolute_deviation) {
                threshold = std::max(threshold, y);
            }
        }

        return threshold;
    }
};

}   // End of namespace
}   // End of namespace
