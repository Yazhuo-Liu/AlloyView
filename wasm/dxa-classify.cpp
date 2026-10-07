// Private CPU Worker adapter for OVITO 3.9.4 DXA tetrahedron classification.
// The predicates and operation order mirror DelaunayTessellation::alphaTest
// and ElasticMapping::isElasticMappingCompatible in the pinned MIT sources.
#include <ovito/crystalanalysis/data/ClusterVector.h>
#include <ovito/core/utilities/concurrent/Task.h>
#include <cstring>
#include <optional>
#include <stdexcept>

using namespace Ovito;
using namespace Ovito::CrystalAnalysis;

namespace {
std::string classificationError;
constexpr uint32_t reverseEdge = uint32_t(1) << 31;
constexpr uint32_t missingTransition = std::numeric_limits<uint32_t>::max();

double determinant(double a00, double a01, double a02, double a10, double a11,
        double a12, double a20, double a21, double a22) {
    double m02 = a00*a21 - a20*a01;
    double m01 = a00*a11 - a10*a01;
    double m12 = a10*a21 - a20*a11;
    return m01*a22 - m02*a12 + m12*a02;
}

struct CpuClassification {
    const double* vertices;
    const uint32_t* tetrahedra;
    const uint32_t* edges;
    const double* transitions;
    size_t vertexCount, tetCount, edgeCount, transitionCount;
    double alpha;

    const uint32_t* tet(size_t index) const {
        if(index >= tetCount) throw std::runtime_error("CPU DXA classification references an invalid tetrahedron.");
        return tetrahedra + index * 16;
    }
    const double* vertex(uint32_t index) const {
        if(index >= vertexCount) throw std::runtime_error("CPU DXA classification references an invalid vertex.");
        return vertices + size_t(index) * 3;
    }
    std::optional<bool> alphaTest(size_t index) const {
        const auto row = tet(index);
        if(row[14] != 1) return false;
        const auto v0 = vertex(row[0]), v1 = vertex(row[1]);
        const auto v2 = vertex(row[2]), v3 = vertex(row[3]);
        const auto qpx = v1[0]-v0[0], qpy = v1[1]-v0[1], qpz = v1[2]-v0[2];
        const auto qp2 = qpx*qpx + qpy*qpy + qpz*qpz;
        const auto rpx = v2[0]-v0[0], rpy = v2[1]-v0[1], rpz = v2[2]-v0[2];
        const auto rp2 = rpx*rpx + rpy*rpy + rpz*rpz;
        const auto spx = v3[0]-v0[0], spy = v3[1]-v0[1], spz = v3[2]-v0[2];
        const auto sp2 = spx*spx + spy*spy + spz*spz;
        const auto num_x = determinant(qpy,qpz,qp2,rpy,rpz,rp2,spy,spz,sp2);
        const auto num_y = determinant(qpx,qpz,qp2,rpx,rpz,rp2,spx,spz,sp2);
        const auto num_z = determinant(qpx,qpy,qp2,rpx,rpy,rp2,spx,spy,sp2);
        const auto den = determinant(qpx,qpy,qpz,rpx,rpy,rpz,spx,spy,spz);
        const double nomin = num_x*num_x + num_y*num_y + num_z*num_z;
        const double denom = 4 * den * den;
        if(std::abs(denom) < 1e-9 && std::abs(nomin) < 1e-9) return {};
        return (nomin / denom) < alpha;
    }
    bool filled(size_t index) const {
        const auto row = tet(index);
        if(row[14] != 1) return false;
        if(const auto test = alphaTest(index)) return *test;
        // A sliver is filled only if every neighboring finite cell passes or
        // is itself inconclusive, exactly as the native manifold builder.
        for(int face = 0; face < 4; ++face) {
            const auto adjacent = row[4 + face];
            if(tet(adjacent)[14] != 1) return false;
            if(const auto test = alphaTest(adjacent); test && !*test) return false;
        }
        return true;
    }
    Matrix3 matrix(uint32_t transition, bool reverse) const {
        Matrix3 result;
        std::memcpy(result.elements(), transitions + size_t(transition)*20 + (reverse ? 9 : 0), 9*sizeof(double));
        return result;
    }
    bool compatible(size_t index) const {
        const auto row = tet(index);
        Vector3 vectors[6];
        uint32_t transitionIds[6];
        bool reversed[6], self[6];
        for(int edge = 0; edge < 6; ++edge) {
            const auto oriented = row[8 + edge], id = oriented & ~reverseEdge;
            if(id >= edgeCount) throw std::runtime_error("CPU DXA classification references an invalid edge.");
            const auto data = edges + size_t(id)*8;
            const auto transition = data[6];
            if(transition == missingTransition) return false;
            if(transition >= transitionCount) throw std::runtime_error("CPU DXA classification references an invalid crystal transition.");
            std::memcpy(vectors[edge].data(), data, 3*sizeof(double));
            reversed[edge] = bool(oriented & reverseEdge);
            transitionIds[edge] = transition;
            self[edge] = transitions[size_t(transition)*20 + 18] == 1;
            if(reversed[edge]) {
                vectors[edge] = -vectors[edge];
                if(!self[edge]) vectors[edge] = matrix(transition, false) * vectors[edge];
            }
        }
        constexpr int circuits[4][3] = {{0,4,2},{1,5,2},{0,3,1},{3,5,4}};
        for(int face = 0; face < 4; ++face) {
            const int first = circuits[face][0], second = circuits[face][1], third = circuits[face][2];
            Vector3 burgers = vectors[first];
            burgers += self[first] ? vectors[second] : matrix(transitionIds[first], !reversed[first]) * vectors[second];
            burgers -= vectors[third];
            if(!burgers.isZero(CA_LATTICE_VECTOR_EPSILON)) return false;
        }
        for(int face = 0; face < 4; ++face) {
            const int first = circuits[face][0], second = circuits[face][1], third = circuits[face][2];
            if(!self[first] || !self[second] || !self[third]) {
                const Matrix3 frank = matrix(transitionIds[third], !reversed[third]) *
                    matrix(transitionIds[second], reversed[second]) * matrix(transitionIds[first], reversed[first]);
                if(!frank.equals(Matrix3::Identity(), CA_TRANSITION_MATRIX_EPSILON)) return false;
            }
        }
        return true;
    }
};
}

extern "C" {
const char* alloy_dxa_classify_error() { return classificationError.c_str(); }
int alloy_dxa_classify_range(const double* vertices, int vertexCount,
        const uint32_t* tetrahedra, int tetCount, const uint32_t* edges, int edgeCount,
        const double* transitions, int transitionCount, double alpha,
        int start, int end, int32_t* output) {
    classificationError.clear();
    try {
        if(!vertices || !tetrahedra || !edges || !transitions || !output || vertexCount < 1 ||
                tetCount < 1 || edgeCount < 1 || transitionCount < 1 ||
                start < 0 || end < start || end > tetCount || !std::isfinite(alpha) || alpha < 0)
            throw std::runtime_error("Invalid CPU DXA tetrahedron classification input.");
        const CpuClassification data {vertices, tetrahedra, edges, transitions,
            size_t(vertexCount), size_t(tetCount), size_t(edgeCount), size_t(transitionCount), alpha};
        for(int index = start; index < end; ++index) {
            if((index & 1023) == 0 && Task::current()->isCanceled())
                throw std::runtime_error("CPU DXA tetrahedron classification was canceled.");
            output[index - start] = data.filled(index) && data.compatible(index) ? 0 : -1;
        }
        return 1;
    } catch(const std::exception& error) { classificationError = error.what(); }
    catch(...) { classificationError = "CPU DXA tetrahedron classification failed."; }
    return 0;
}
}
