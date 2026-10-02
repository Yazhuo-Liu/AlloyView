#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <emscripten.h>
#include "ptm_functions.h"

// All neighbor searching stays in the shared browser kernel. PTM can request
// neighbors of neighbors for diamond/graphene without storing an N×18 graph.
EM_JS(int, fetch_neighbors, (int atom, int count, double* points, uint32_t* indices), {
    return Module.fetchNeighbors(atom, count, points, indices);
});

static ptm_local_handle_t handle = nullptr;

static int get_neighbors(void*, size_t, size_t atom, int requested, ptm_atomicenv_t* env) {
    double points[PTM_MAX_INPUT_POINTS - 1][3];
    uint32_t indices[PTM_MAX_INPUT_POINTS - 1];
    int count = fetch_neighbors(atom, std::min(requested - 1, PTM_MAX_INPUT_POINTS - 1), &points[0][0], indices);
    std::memset(env, 0, sizeof(*env));
    env->num = count + 1;
    env->atom_indices[0] = atom;
    for (int i = 0; i < PTM_MAX_INPUT_POINTS; ++i) env->correspondences[i] = i;
    if (count > 0) {
        uint64_t ordering = 0;
        if (ptm_preorder_neighbours(handle, count, points, &ordering) != 0) {
            env->num = 1;
            return 1;
        }
        int unused_template = 0;
        ptm_decode_correspondences(PTM_MATCH_FCC, ordering, env->correspondences, &unused_template);
        for (int i = 0; i < count; ++i) {
            int source = env->correspondences[i + 1] - 1;
            env->atom_indices[i + 1] = indices[source];
            std::memcpy(env->points[i + 1], points[source], 3 * sizeof(double));
        }
    }
    return env->num;
}

extern "C" {
int alloy_ptm_init() {
    int error = ptm_initialize_global();
    if (!error && !handle) handle = ptm_initialize_local();
    return error;
}

// Packed output: type, RMSD, inverse scale, nearest distance, F[9].
// Unmatched environments carry NaN numerical outputs, never invented zeros.
int alloy_ptm_atom(int atom, int flags, double* output) {
    ptm_result_t result;
    int error = ptm_index(handle, atom, get_neighbors, nullptr, flags, true, &result, nullptr);
    output[0] = result.structure_type;
    for (int i = 1; i < 13; ++i) output[i] = NAN;
    if (result.structure_type) {
        output[1] = result.rmsd;
        output[2] = result.scale;
        output[3] = result.interatomic_distance;
        for (int i = 0; i < 9; ++i) output[4 + i] = result.F[i];
    }
    return error;
}
}
