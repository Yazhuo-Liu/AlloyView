# OVITO grain segmentation: reference sources

AlloyView's grain segmentation is a JavaScript port of the grain segmentation
modifier of **OVITO v3.9.4**, official repository
`https://gitlab.com/stuko/ovito.git`, commit
`939f5d909ea3b0fd0dd6695494da8f8d03821c2e`.

The OVITO files retain their original copyright and dual GPLv3-or-MIT notices.
AlloyView uses the **MIT option**, with the complete license included in
`LICENSE.MIT.txt`. `LICENSE.GPL.txt` is retained for recipients choosing that
option.

`upstream/` holds the unmodified files the port was written from, at their
original paths. They are not compiled or shipped; they let a reader compare
the port with its source line by line.

| Upstream file | Ported to |
| --- | --- |
| `crystalanalysis/modifier/grains/GrainSegmentationEngine.{h,cpp}` | `src/analysis/grains.js`: neighbor bonds, coherent-interface handling, disorientation of every bond, the cluster graph, the minimum spanning tree, merge sizes, cutting the merge sequence, minimum grain size, numbering and orphan adoption |
| `crystalanalysis/modifier/grains/NodePairSampling.cpp` | `nodePairSamplingClustering` in `src/analysis/grains.js` |
| `crystalanalysis/modifier/grains/ThresholdSelection.h` | `fitMergeDistances` and `suggestMergeThreshold` in `src/analysis/grains.js` |
| `core/utilities/DisjointSet.h` | `DisjointSet` in `src/analysis/grains.js` |
| `crystalanalysis/modifier/grains/GrainSegmentationModifier.{h,cpp}` | defaults, outputs and the thin-cell conditions; the panel is `src/grain-tools.js` |
| `particles/modifier/analysis/ptm/PTMAlgorithm.{h,cpp}` | `latticeDisorientation` and `interfacialDisorientation` in `src/analysis/disorientation.js`; the neighbor environment exported by `wasm/ptm.cpp` |
| `particles/util/PTMNeighborFinder.{h,cpp}` | the neighbor lists returned by `calculatePtm(..., { neighborLists: true })` in `src/analysis/ptm.js` |

The quaternion routines these files call (`ptm_quat.cpp`,
`ptm_map_templates.cpp`) belong to the PTM library in `third_party/ptm`, which
is byte-identical to the copy in OVITO v3.9.4. Their JavaScript port is
`src/analysis/disorientation.js`.

The port keeps the upstream arithmetic and operand order. Every place where it
fixes an order that upstream leaves to thread scheduling, an unstable sort, a
hash set or a heap, and every other difference, is listed in
`docs/features/grains.md`, together with the comparison against the PyPI
package `ovito==3.9.4`. `scripts/research/ovito-grains-oracle.py` and
`scripts/research/ovito-grains-compare.mjs` repeat that comparison.

`SHA256SUMS` verifies every file in this directory:

```sh
cd third_party/grains && sha256sum --check --quiet SHA256SUMS
```
