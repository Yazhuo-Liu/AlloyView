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

#pragma once


#include <ovito/crystalanalysis/CrystalAnalysis.h>
#include <ovito/particles/objects/BondsVis.h>
#include <ovito/core/dataset/pipeline/AsynchronousModifier.h>

namespace Ovito::CrystalAnalysis {

class GrainSegmentationEngine;  // defined in GrainSegmentationEngine.h

/*
 * Decomposes a polycrystalline microstructure into individual grains.
 */
class OVITO_CRYSTALANALYSIS_EXPORT GrainSegmentationModifier : public AsynchronousModifier
{
    /// Give this modifier class its own metaclass.
    class OVITO_CRYSTALANALYSIS_EXPORT GrainSegmentationModifierClass : public AsynchronousModifier::OOMetaClass
    {
    public:

        /// Inherit constructor from base metaclass.
        using AsynchronousModifier::OOMetaClass::OOMetaClass;

        /// Asks the metaclass whether the modifier can be applied to the given input data.
        virtual bool isApplicableTo(const DataCollection& input) const override;
    };

    OVITO_CLASS_META(GrainSegmentationModifier, GrainSegmentationModifierClass)

    Q_CLASSINFO("DisplayName", "Grain segmentation (experimental)");
#ifndef OVITO_QML_GUI
    Q_CLASSINFO("ModifierCategory", "Analysis");
#else
    Q_CLASSINFO("ModifierCategory", "-");
#endif

public:

    enum MergeAlgorithm {
        GraphClusteringAutomatic,   ///< Use graph clustering algorithm to build merge sequence and choose threshold adaptively.
        GraphClusteringManual,      ///< Use graph clustering algorithm to build merge sequence and let user choose merge threshold.
        MinimumSpanningTree,        ///< Use minimum spanning tree algorithm to build merge sequence.
    };
    Q_ENUM(MergeAlgorithm);

    /// Constructor.
    Q_INVOKABLE GrainSegmentationModifier(ObjectInitializationFlags flags);

protected:

    /// Is called when the value of a property of this object has changed.
    virtual void propertyChanged(const PropertyFieldDescriptor* field) override;

    /// Creates a computation engine that will compute the modifier's results.
    virtual Future<EnginePtr> createEngine(const ModifierEvaluationRequest& request, const PipelineFlowState& input) override;

private:

    /// The merging algorithm to use.
    DECLARE_MODIFIABLE_PROPERTY_FIELD(MergeAlgorithm, mergeAlgorithm, setMergeAlgorithm);

    /// Controls whether to handle coherent crystal interfaces.
    DECLARE_MODIFIABLE_PROPERTY_FIELD(bool, handleCoherentInterfaces, setHandleCoherentInterfaces);

    /// Controls the amount of noise allowed inside a grain.
    DECLARE_MODIFIABLE_PROPERTY_FIELD(FloatType, mergingThreshold, setMergingThreshold);

    /// The minimum number of crystalline atoms per grain.
    DECLARE_MODIFIABLE_PROPERTY_FIELD(int, minGrainAtomCount, setMinGrainAtomCount);

    /// Controls whether to adopt orphan atoms
    DECLARE_MODIFIABLE_PROPERTY_FIELD_FLAGS(bool, orphanAdoption, setOrphanAdoption, PROPERTY_FIELD_MEMORIZE);

    /// The visual element for rendering the bonds created by the modifier.
    DECLARE_MODIFIABLE_REFERENCE_FIELD_FLAGS(OORef<BondsVis>, bondsVis, setBondsVis, PROPERTY_FIELD_DONT_PROPAGATE_MESSAGES | PROPERTY_FIELD_MEMORIZE);

    /// Controls the output of bonds by the modifier.
    DECLARE_MODIFIABLE_PROPERTY_FIELD(bool, outputBonds, setOutputBonds);

    /// Controls the coloring of particles by the modifier.
    DECLARE_MODIFIABLE_PROPERTY_FIELD_FLAGS(bool, colorParticlesByGrain, setColorParticlesByGrain, PROPERTY_FIELD_MEMORIZE);
};

}   // End of namespace
