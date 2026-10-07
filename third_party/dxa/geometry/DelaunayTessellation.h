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


#include "compat/compat.h"

#include "geogram/Delaunay_psm.h"
#include <iterator>

namespace Ovito::Delaunay {



/**
 * Generates a Delaunay tessellation of a particle system.
 */
class OVITO_DELAUNAY_EXPORT DelaunayTessellation
{
public:

    typedef GEO::index_t size_type;
    typedef GEO::index_t CellHandle;
    typedef GEO::index_t VertexHandle;
    class CellIterator {
        size_type value_;
    public:
        using iterator_category = std::forward_iterator_tag;
        using value_type = size_type;
        using difference_type = std::ptrdiff_t;
        using pointer = const size_type*;
        using reference = size_type;
        explicit CellIterator(size_type value = 0) : value_(value) {}
        size_type operator*() const { return value_; }
        CellIterator& operator++() { ++value_; return *this; }
        bool operator!=(const CellIterator& other) const { return value_ != other.value_; }
        bool operator==(const CellIterator& other) const { return value_ == other.value_; }
    };

    /// Data structure attached to each tessellation cell.
    struct CellInfo {
        bool isGhost;   // Indicates whether this is a ghost tetrahedron.
        int userField;  // An additional field that can be used by client code.
        qint64 index;   // An index assigned to the cell.
    };

    typedef std::pair<CellHandle, int> Facet;

    class FacetCirculator {
    public:
        FacetCirculator(const DelaunayTessellation& tess, CellHandle cell, int s, int t, CellHandle start, int f) :
            _tess(tess), _s(tess.cellVertex(cell, s)), _t(tess.cellVertex(cell, t)) {
            int i = tess.index(start, _s);
            int j = tess.index(start, _t);

            OVITO_ASSERT( f!=i && f!=j );

            if(f == next_around_edge(i,j))
                _pos = start;
            else
                _pos = tess.cellAdjacent(start, f); // other cell with same facet
        }
        FacetCirculator& operator--() {
            _pos = _tess.cellAdjacent(_pos, next_around_edge(_tess.index(_pos, _t), _tess.index(_pos, _s)));
            return *this;
        }
        FacetCirculator operator--(int) {
            FacetCirculator tmp(*this);
            --(*this);
            return tmp;
        }
        FacetCirculator & operator++() {
            _pos = _tess.cellAdjacent(_pos, next_around_edge(_tess.index(_pos, _s), _tess.index(_pos, _t)));
            return *this;
        }
        FacetCirculator operator++(int) {
            FacetCirculator tmp(*this);
            ++(*this);
            return tmp;
        }
        Facet operator*() const {
            return Facet(_pos, next_around_edge(_tess.index(_pos, _s), _tess.index(_pos, _t)));
        }
        Facet operator->() const {
            return Facet(_pos, next_around_edge(_tess.index(_pos, _s), _tess.index(_pos, _t)));
        }
        bool operator==(const FacetCirculator& ccir) const
        {
            return _pos == ccir._pos && _s == ccir._s && _t == ccir._t;
        }
        bool operator!=(const FacetCirculator& ccir) const
        {
            return ! (*this == ccir);
        }

    private:
        const DelaunayTessellation& _tess;
        VertexHandle _s;
        VertexHandle _t;
        CellHandle _pos;
        static int next_around_edge(int i, int j) {
            static const int tab_next_around_edge[4][4] = {
                  {5, 2, 3, 1},
                  {3, 5, 0, 2},
                  {1, 3, 5, 0},
                  {2, 0, 1, 5} };
            return tab_next_around_edge[i][j];
        }
    };

    /// Generates the Delaunay tessellation.
    bool generateTessellation(const SimulationCellObject* simCell, const Point3* positions, size_t numPoints, FloatType ghostLayerSize, bool coverDomainWithFiniteTets, const SelectionIntType* selectedPoints, ProgressingTask& operation);

    // Immutable geometry exported to private CPU stage Workers. Imported labels
    // are owned by the enclosing DXA session and borrowed only while meshing.
    size_type workerVertexCount() const { return _dt->nb_vertices(); }
    void setWorkerRegions(const int32_t* values, size_t count) {
        if(values && count != numberOfTetrahedra())
            throw Exception("CPU DXA classification has an inconsistent tetrahedron count.");
        _workerRegions = values;
    }
    const int32_t* workerRegions() const { return _workerRegions; }

    /// Returns the total number of tetrahedra in the tessellation.
    size_type numberOfTetrahedra() const { return _dt->nb_cells(); }

    /// Returns the number of finite cells in the primary image of the simulation cell.
    size_type numberOfPrimaryTetrahedra() const { return _numPrimaryTetrahedra; }

    CellIterator begin_cells() const { return CellIterator(0); }
    CellIterator end_cells() const { return CellIterator(_dt->nb_cells()); }

    void setCellIndex(CellHandle cell, qint64 value) {
        _cellInfo[cell].index = value;
    }

    qint64 getCellIndex(CellHandle cell) const {
        return _cellInfo[cell].index;
    }

    void setUserField(CellHandle cell, int value) {
        _cellInfo[cell].userField = value;
    }

    int getUserField(CellHandle cell) const {
        return _cellInfo[cell].userField;
    }

    /// Returns whether the given tessellation cell connects four physical vertices.
    /// Returns false if one of the four vertices is the infinite vertex.
    bool isFiniteCell(CellHandle cell) const {
        return _dt->cell_is_finite(cell);
    }

    bool isGhostCell(CellHandle cell) const {
        return _cellInfo[cell].isGhost;
    }

    bool isGhostVertex(VertexHandle vertex) const {
        return vertex >= _primaryVertexCount;
    }

    VertexHandle cellVertex(CellHandle cell, size_type localIndex) const {
        return _dt->cell_vertex(cell, localIndex);
    }

#ifndef FLOATTYPE_FLOAT
    const Point3& vertexPosition(VertexHandle vertex) const {
        return *reinterpret_cast<const Point3*>(_dt->vertex_ptr(vertex));
    }
#else
    Point3 vertexPosition(VertexHandle vertex) const {
        const double* xyz = _dt->vertex_ptr(vertex);
        return Point3((FloatType)xyz[0], (FloatType)xyz[1], (FloatType)xyz[2]);
    }
#endif

    std::optional<bool> alphaTest(CellHandle cell, FloatType alpha) const;

    size_t vertexIndex(VertexHandle vertex) const {
        OVITO_ASSERT(vertex < _particleIndices.size());
        return _particleIndices[vertex];
    }

    Facet mirrorFacet(CellHandle cell, int face) const {
        CellHandle adjacentCell = cellAdjacent(cell, face);
        OVITO_ASSERT(adjacentCell >= 0);
        return Facet(adjacentCell, adjacentIndex(adjacentCell, cell));
    }

    Facet mirrorFacet(const Facet& facet) const {
        return mirrorFacet(facet.first, facet.second);
    }

    /// Retreives a local vertex index from cell index and global vertex index.
    int index(CellHandle cell, VertexHandle vertex) const {
        for(int iv = 0; iv < 4; iv++) {
            if(cellVertex(cell, iv) == vertex) {
                return iv;
            }
        }
        OVITO_ASSERT(false);
        return -1;
    }

    /// Gets an adjacent cell index by cell index and local facet index.
    CellHandle cellAdjacent(CellHandle cell, int localFace) const {
        return _dt->cell_adjacent(cell, localFace);
    }

    /// Retreives a local facet index from two adacent cell global indices.
    int adjacentIndex(CellHandle c1, CellHandle c2) const {
        for(int f = 0; f < 4; f++) {
            if(cellAdjacent(c1, f) == c2) {
                return f;
            }
        }
        OVITO_ASSERT(false);
        return -1;
    }

    /// Returns the cell vertex for the given triangle vertex of the given cell facet.
    static inline int cellFacetVertexIndex(int cellFacetIndex, int facetVertexIndex) {
        static const int tab_vertex_triple_index[4][3] = {
            {1, 3, 2},
            {0, 2, 3},
            {0, 3, 1},
            {0, 1, 2}
        };
        OVITO_ASSERT(cellFacetIndex >= 0 && cellFacetIndex < 4);
        OVITO_ASSERT(facetVertexIndex >= 0 && facetVertexIndex < 3);
        return tab_vertex_triple_index[cellFacetIndex][facetVertexIndex];
    }

    FacetCirculator incident_facets(CellHandle cell, int i, int j, CellHandle start, int f) const {
        return FacetCirculator(*this, cell, i, j, start, f);
    }

    CellHandle locate(const Point3& p, CellHandle hint) const {
        return _dt->locate_point(p.data(), hint);
    }

    /// Returns the simulation cell geometry.
    const SimulationCellObject* simCell() const { return _simCell; }

private:

    /// Determines whether the given tetrahedral cell is a ghost cell (or an invalid cell).
    bool classifyGhostCell(CellHandle cell) const;

    const int32_t* _workerRegions = nullptr;

    /// The internal Delaunay generator object.
    GEO::Delaunay_var _dt;

    /// Stores the coordinates of the input points.
    std::vector<Point_3<double>> _pointData;

    /// Stores per-cell auxiliary data.
    std::vector<CellInfo> _cellInfo;

    /// Mapping of Delaunay points to input particles.
    std::vector<size_t> _particleIndices;

    /// The number of primary (non-ghost) vertices.
    size_type _primaryVertexCount;

    /// The number of finite cells in the primary image of the simulation cell.
    size_type _numPrimaryTetrahedra = 0;

    /// The simulation cell geometry.
    const SimulationCellObject* _simCell = nullptr;
};

}   // End of namespace
