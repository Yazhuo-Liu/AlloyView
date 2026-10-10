# Replicate

## Controls

Set total copy counts along lattice vectors **a**, **b**, and **c**. Each count includes the original cell; `2 × 3 × 1` produces six cells. Non-periodic axes remain at one. **Apply** updates the counts and **Original cell** restores `1 × 1 × 1`. At most 4,096 cells can be requested.

**Replicate atoms for analysis** is off by default. Off creates display copies that reuse the original analysis. On enlarges the cell and creates physical atom copies for every analysis. It increases atom count, memory use and calculation work; enabled analyses recalculate for the enlarged structure. Counts and the mode are saved in JSON configurations, with display-only mode as the default for older configurations.

## Algorithm

For image indices `(i, j, k)`, the renderer translates source positions by `i a + j b + k c`. The actual cell vectors are used, so tilted and rotated triclinic cells remain geometrically correct. The cell outline and camera bounds expand to contain the resulting supercell.

In the default display mode, GPU atom buffers and property arrays are reused, analyses still use source atoms, and selecting a copy reports its original atom ID. Every copy inherits coloring and visibility; each copy is tested separately against Cartesian slicing planes. Exported figures include the displayed copies.

The structure summary and classification counts report source atoms in display mode. Rendering and picking work increase with the copy count even when analysis cost stays constant.

## Physical atom replication

When Replicate atoms is enabled, the new cell vectors are `nₐ a`, `nᵦ b` and `n𝚌 c`. A copy translated by `i a + j b + k c` has fractional coordinates `((sₐ + i) / nₐ, (sᵦ + j) / nᵦ, (s𝚌 + k) / n𝚌)` in that enlarged cell. This preserves Cartesian positions and triclinic geometry rather than repeating along fixed Cartesian axes.

Each copy has its own atom ID and copied source properties. The summary, crystal counts, coordination, RDF, strain and other analyses use the physical atom count and enlarged cell. Selection groups can therefore select and color physical copies independently. Turning the option off restores analysis of the source atoms, with the requested copies shown by the renderer. The original local files remain unchanged.

### Trajectories and periodic images

When a frame has image flags or unwrapped coordinates, the copies are placed from those continuous coordinates and rewrapped in the enlarged cell. An atom that crosses a face of the source cell then moves continuously in every copy.

A frame that stores only wrapped coordinates cannot be made continuous. Each copy repeats the wrap of its source atom, which is a jump of one source cell vector: only `1/n` of the enlarged cell vector along a direction with `n` copies. The enlarged cell's own periodic images cannot remove that jump. [Displacement](displacement.md) and [Frame strain](reference-strain.md), the analyses that follow atoms between two frames, therefore resolve periodic images of such frames against the lattice of the source cell, on CPU and GPU. That lattice is still a symmetry of the replicated structure, so every copy receives the result of its source atom.

The limit is the one that applies without replication: between the two frames, motion must stay within the nearest image of the source lattice, which is less than half a source cell vector along each direction of an orthogonal cell. Replicating a wrapped trajectory does not extend that range; a file with image flags or unwrapped coordinates does, up to the nearest image of the enlarged cell. If only one of the two frames has image data, the source lattice is used. Image flags that do not record the wraps of their atoms are taken at face value and leave the jumps in place.

Physical copies are built in a reusable Worker, in bounded batches that report progress and can be cancelled without recreating the Worker; building 1,000,000 atoms on the page thread took about 0.9 s. The result has the same IDs, coordinates and properties as direct replication. During playback, the next frame is replicated in that Worker while the current one is shown. The Worker holds one permit of the shared CPU budget while it runs.

## Implementation

[Display replication geometry](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/replication.js), [physical atom replication](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/replicate.js) and [its Worker](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/workers/replication-worker.js), [source-lattice images for wrapped trajectories](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/data/model.js), [instanced rendering](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/render/webgl-renderer.js).
