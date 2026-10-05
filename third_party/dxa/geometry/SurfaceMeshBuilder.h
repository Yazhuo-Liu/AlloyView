////////////////////////////////////////////////////////////////////////////////////////
//
//  Copyright 2023 OVITO GmbH, Germany
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
#include "SurfaceMeshTopology.h"

namespace Ovito::Mesh {

struct SurfaceMeshVertices { enum { PositionProperty = 1 }; };
struct SurfaceMeshFaces { enum { RegionProperty = 2 }; };

// Only the DXA topology and coordinate data are retained; Qt properties,
// visualization objects and serialization belong to the JavaScript layer.
class SurfaceMesh {
public:
    using size_type = SurfaceMeshTopology::size_type;
    using vertex_index = size_type;
    using edge_index = size_type;
    using face_index = size_type;
    using region_index = size_type;
    static constexpr size_type InvalidIndex = -1;
    SurfaceMeshTopology topo;
    std::vector<Point3> points;
    std::vector<region_index> faceRegions;
    struct Regions { int count = 0; void setElementCount(int n) { count = n; } } regions;
    const SimulationCellObject* domain = nullptr;
    region_index spaceFilling = InvalidIndex;
};

class SurfaceMeshBuilder {
public:
    using size_type = SurfaceMesh::size_type;
    using vertex_index = SurfaceMesh::vertex_index;
    using edge_index = SurfaceMesh::edge_index;
    using face_index = SurfaceMesh::face_index;
    using region_index = SurfaceMesh::region_index;
    static constexpr size_type InvalidIndex = -1;
    explicit SurfaceMeshBuilder(SurfaceMesh* mesh) : _mesh(mesh) {}
    SurfaceMesh* mesh() const { return _mesh; }
    SurfaceMesh* mutableMesh() { return _mesh; }
    SurfaceMeshTopology* mutableTopology() { return &_mesh->topo; }
    const SurfaceMeshTopology* topology() const { return &_mesh->topo; }
    SurfaceMesh::Regions* mutableRegions() { return &_mesh->regions; }
    int regionCount() const { return _mesh->regions.count; }
    void setSpaceFillingRegion(region_index v) { _mesh->spaceFilling = v; }
    region_index spaceFillingRegion() const { return _mesh->spaceFilling; }
    void setDomain(const SimulationCellObject* cell) { _mesh->domain = cell; }
    const SimulationCellObject* domain() const { return _mesh->domain; }
    Vector3 wrapVector(const Vector3& vector) const { return domain() ? domain()->wrapVector(vector) : vector; }
    Point3 wrapPoint(const Point3& point) const { return domain() ? domain()->wrapPoint(point) : point; }
    void setVertexPositions(std::vector<Point3> positions) { _mesh->points = std::move(positions); }
    void setFaceRegions(std::vector<region_index> regions) { _mesh->faceRegions = std::move(regions); }
    const PropertyObject* expectVertexProperty(int) const;
    const PropertyObject* expectFaceProperty(int) const;
    void clearMesh() { _mesh->topo.clear(); _mesh->points.clear(); _mesh->faceRegions.clear(); }
    int vertexCount() const { return _mesh->topo.vertexCount(); }
    int faceCount() const { return _mesh->topo.faceCount(); }
    int edgeCount() const { return _mesh->topo.edgeCount(); }
    vertex_index vertex1(edge_index e) const { return _mesh->topo.vertex1(e); }
    vertex_index vertex2(edge_index e) const { return _mesh->topo.vertex2(e); }
    edge_index firstVertexEdge(vertex_index v) const { return _mesh->topo.firstVertexEdge(v); }
    edge_index nextVertexEdge(edge_index e) const { return _mesh->topo.nextVertexEdge(e); }
    edge_index firstFaceEdge(face_index f) const { return _mesh->topo.firstFaceEdge(f); }
    edge_index nextFaceEdge(edge_index e) const { return _mesh->topo.nextFaceEdge(e); }
    edge_index prevFaceEdge(edge_index e) const { return _mesh->topo.prevFaceEdge(e); }
    edge_index oppositeEdge(edge_index e) const { return _mesh->topo.oppositeEdge(e); }
    face_index oppositeFace(face_index f) const { return _mesh->topo.oppositeFace(f); }
    edge_index nextManifoldEdge(edge_index e) const { return _mesh->topo.nextManifoldEdge(e); }
    face_index adjacentFace(edge_index e) const { return _mesh->topo.adjacentFace(e); }
    bool hasOppositeEdge(edge_index e) const { return _mesh->topo.hasOppositeEdge(e); }
    bool hasOppositeFace(face_index f) const { return _mesh->topo.hasOppositeFace(f); }
    edge_index findEdge(face_index f, vertex_index a, vertex_index b) const { return _mesh->topo.findEdge(f,a,b); }
    void linkOppositeEdges(edge_index a, edge_index b) { _mesh->topo.linkOppositeEdges(a,b); }
    void linkOppositeFaces(face_index a, face_index b) { _mesh->topo.linkOppositeFaces(a,b); }
    void setNextManifoldEdge(edge_index a, edge_index b) { _mesh->topo.setNextManifoldEdge(a,b); }
    bool connectOppositeHalfedges() { return _mesh->topo.connectOppositeHalfedges(); }
    int vertexEdgeCount(vertex_index v) const { return _mesh->topo.vertexEdgeCount(v); }
    int countManifolds(edge_index e) const { return _mesh->topo.countManifolds(e); }
    const std::vector<edge_index>& firstFaceEdges() const { return _mesh->topo.firstFaceEdges(); }
    int makeManifold();
    template<typename Range> vertex_index createVerticesRange(const Range& coords) {
        vertex_index first = vertexCount();
        for(const Point3& point : coords) { _mesh->topo.createVertex(); _mesh->points.push_back(point); }
        return first;
    }
    class VertexGrower {
        SurfaceMeshBuilder& builder;
    public:
        explicit VertexGrower(SurfaceMeshBuilder& b) : builder(b) {}
        vertex_index createVertex(const Point3& p) {
            vertex_index index = builder._mesh->topo.createVertex();
            builder._mesh->points.push_back(p); return index;
        }
        vertex_index copyVertex(vertex_index source) { Point3 p = builder._mesh->points[source]; return createVertex(p); }
        const Point3& vertexPosition(vertex_index v) const { return builder._mesh->points[v]; }
    };
    class FaceGrower {
        SurfaceMeshBuilder& builder;
    public:
        explicit FaceGrower(SurfaceMeshBuilder& b) : builder(b) {}
        template<typename Iterator> face_index createFace(Iterator begin, Iterator end, region_index region = InvalidIndex) {
            face_index index = builder._mesh->topo.createFaceAndEdges(begin,end);
            builder._mesh->faceRegions.push_back(region); return index;
        }
        face_index createFace(std::initializer_list<vertex_index> points, region_index region = InvalidIndex) {
            return createFace(points.begin(), points.end(), region);
        }
    };
private:
    SurfaceMesh* _mesh;
    mutable std::unique_ptr<PropertyObject> _positionProperty;
    mutable std::unique_ptr<PropertyObject> _faceRegionProperty;
};
}
