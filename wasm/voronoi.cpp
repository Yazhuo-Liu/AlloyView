#include <algorithm>
#include <vector>
#include "cell.hh"

// Each analysis Worker retains one cell and its growing topology buffers.
// Voronoi cells are independent; parallel Workers never share this object.
static voro::voronoicell_neighbor cell;
static std::vector<double> areas;
static std::vector<int> orders, neighbors;
static std::vector<double> vertices;
static std::vector<int> face_vertices;

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

// A bisector can affect a convex cell only if it reaches a vertex. The
// bounding-sphere completeness search may contain many irrelevant planes
// beside a vacuum slab. Reject those before JavaScript sorts them; this test
// never changes Voro++'s traversal guess or topology and retains near-tangent
// planes conservatively. Internally pts stores doubled Cartesian vertices.
void alloy_voronoi_filter_planes(const double* planes, unsigned char* keep, int count) {
    for (int plane = 0; plane < count; ++plane) {
        const double* normal = planes + plane * 4;
        keep[plane] = 0;
        for (int vertex = 0; vertex < cell.p; ++vertex) {
            const double* point = cell.pts + vertex * 4;
            const double x = normal[0] * point[0], y = normal[1] * point[1], z = normal[2] * point[2];
            // Voro++ can reassign a near-coplanar face's neighbor within its
            // marginal band even when every vertex is geometrically inside.
            // Keep that complete native band as well as scale-dependent
            // floating-point cancellation error; volume alone cannot certify
            // that rejecting a near-tangent plane preserves face topology.
            const double tolerance = std::max(cell.big_tol,
                1e-10 * std::max(1.0, std::abs(x) + std::abs(y) + std::abs(z) + std::abs(normal[3])));
            if (x + y + z >= normal[3] - tolerance) { keep[plane] = 1; break; }
        }
    }
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

// Geometry is requested only for the selected atom. Retain these vectors like
// the statistical buffers, rather than allocating a mesh for every cell.
int alloy_voronoi_geometry_sizes(unsigned int* sizes) {
    cell.vertices(vertices);
    cell.face_vertices(face_vertices);
    cell.neighbors(neighbors);
    sizes[0] = static_cast<unsigned int>(vertices.size() / 3);
    sizes[1] = static_cast<unsigned int>(neighbors.size());
    sizes[2] = static_cast<unsigned int>(face_vertices.size() - neighbors.size());
    return static_cast<int>(neighbors.size());
}

int alloy_voronoi_geometry(double* output_vertices, unsigned int* output_offsets,
                          unsigned int* output_references, int* output_neighbors,
                          unsigned int vertex_capacity, unsigned int face_capacity,
                          unsigned int reference_capacity) {
    if (vertex_capacity < vertices.size() / 3 || face_capacity < neighbors.size()
        || reference_capacity < face_vertices.size() - neighbors.size()) return 0;
    std::copy(vertices.begin(), vertices.end(), output_vertices);
    std::copy(neighbors.begin(), neighbors.end(), output_neighbors);
    unsigned int offset = 0, cursor = 0;
    for (unsigned int face = 0; face < neighbors.size(); ++face) {
        output_offsets[face] = offset;
        unsigned int count = static_cast<unsigned int>(face_vertices[cursor++]);
        for (unsigned int vertex = 0; vertex < count; ++vertex) {
            output_references[offset++] = static_cast<unsigned int>(face_vertices[cursor++]);
        }
    }
    output_offsets[neighbors.size()] = offset;
    return static_cast<int>(neighbors.size());
}
}
