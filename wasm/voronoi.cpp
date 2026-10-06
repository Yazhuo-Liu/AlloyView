#include <algorithm>
#include <vector>
#include "cell.hh"

// Each analysis Worker retains one cell and its growing topology buffers.
// Voronoi cells are independent; parallel Workers never share this object.
static voro::voronoicell_neighbor cell;
static std::vector<double> areas;
static std::vector<int> orders, neighbors;

extern "C" {
void alloy_voronoi_init(double radius) {
    cell.init(-radius, radius, -radius, radius, -radius, radius);
}

// Voro++ uses n.x <= rsq / 2, and internally stores doubled vertices.
int alloy_voronoi_clip(const double* planes, const int* ids, int count) {
    for (int i = 0; i < count; ++i) {
        const double* p = planes + i * 4;
        if (!cell.nplane(p[0], p[1], p[2], p[3], ids[i])) return 0;
    }
    return 1;
}

double alloy_voronoi_radius_squared() { return cell.max_radius_squared() * 0.25; }

int alloy_voronoi_summary(double* output) {
    cell.face_areas(areas);
    cell.face_orders(orders);
    cell.neighbors(neighbors);
    if (areas.size() != orders.size() || areas.size() != neighbors.size()) return -1;
    output[0] = cell.volume();
    output[1] = cell.surface_area();
    return static_cast<int>(areas.size());
}

int alloy_voronoi_faces(double* output_areas, unsigned int* output_orders,
                       int* output_neighbors, int capacity) {
    if (capacity < static_cast<int>(areas.size())) return 0;
    std::copy(areas.begin(), areas.end(), output_areas);
    std::copy(orders.begin(), orders.end(), output_orders);
    std::copy(neighbors.begin(), neighbors.end(), output_neighbors);
    return static_cast<int>(areas.size());
}
}
