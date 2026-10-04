# Statistics and radial distribution

## Coordination distribution

The coordination distribution bins completed coordination counts into a population histogram and reports their mean. When bonds are calculated it uses bond-cutoff coordination, including qualifying periodic images; otherwise it uses the original Coordination result. It reports original source atoms, including atoms hidden or sliced in the display. Run coordination or bonds first to obtain these values.

## Radial distribution g(r)

Choose the maximum distance, the number of bins and optional center/neighbor element selections. The calculation requires periodic boundaries along all three cell axes. The maximum distance must be at most half the shortest cell face height; 1–4,096 bins are supported.

For a radial bin with edges `r₀` and `r₁`, the shell volume is `4π(r₁³ − r₀³)/3`. The algorithm counts directed selected neighbor pairs, excludes self pairs, and reports the bin-center radius. Its normalization is

`g(r) = count × cell volume / (selected pair population × shell volume)`.

For all atoms the selected pair population is `N(N − 1)`. For partial selections it is `N(center) × N(target) − overlap`, removing atoms included in both populations from self-pair counts. This finite-population correction avoids a systematic small-system bias. The half-face-height limit prevents repeated atom images within the search radius.

Non-periodic cells require a surface correction that is not implemented, so the normalized RDF rejects those cells. Changing display visibility, slicing or replication does not alter the statistical input.

## Implementation

[RDF counts and normalization](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/analysis/rdf.js), [statistics integration](https://github.com/Yazhuo-Liu/AlloyView/blob/main/src/atomeye-tools.js).
