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

/**
 * \file
 * \brief Contains the definition of the Ovito::Point_3 class template.
 */

#pragma once


#include <ovito/core/Core.h>
#include "Vector3.h"

namespace Ovito {

/**
 * \brief A point in 3d space.
 *
 * Point_3 represents a point in three-dimensional space with three coordinates x,y, and z.
 * Note that there exists a corresponding class Vector_3, which represents a *vector* in three-dimensional space.
 *
 * The template parameter \a T specifies the data type of the points's components.
 * Two standard instantiations of Point_3 for floating-point and integer coordinates are predefined:
 *
 * \code
 *      typedef Point_3<FloatType>  Point3;
 *      typedef Point_3<int>        Point3I;
 * \endcode
 *
 * Point_3 derives from std::array<T,3>. Thus, the point coordinates can be accessed via indices, but also via names:
 *
 * \code
 *      p[1]  = 10.0;
 *      p.y() = 10.0;
 * \endcode
 *
 * Note that the default constructor does not initialize the components of the point for performance reasons.
 * The nested type Origin can be used to construct the point (0,0,0):
 *
 * \code
 *      Point3 p = Point3::Origin()
 * \endcode
 *
 * Origin can also be used to convert between points and vectors:
 *
 * \code
 *      Vector3 v0(1, 2, 3);
 *      Point3 p1 = Point3::Origin() + v0;   // Vector to point conversion
 *      Point3 p2 = p1 + v0;                 // Adding a vector to a point
 *      Vector3 delta = p2 - p1;             // Vector connecting two points
 *      Vector3 v1 = p2 - Point3::Origin();  // Point to vector conversion
 *      FloatType r = (p2 - p1).length();    // Distance between two points
 * \endcode
 *
 * Note that points and vectors behave differently under affine transformations:
 *
 * \code
 *      AffineTransformation tm = AffineTransformation::rotationZ(angle) * AffineTransformation::translation(t);
 *      Point3  p = tm *  Point3(1,2,3);    // Translates and rotates the point (1,2,3).
 *      Vector3 v = tm * Vector3(1,2,3);    // Only rotates the vector (1,2,3). Translation doesn't change a vector.
 * \endcode
 *
 * \sa Vector_3, Point_2
 */
template<typename T>
class Point_3 : public
#ifndef OVITO_USE_SYCL
    std::array<T, 3>
#else
    SYCL_NS::marray<T, 3>
#endif
{
private:

    using base_type =
#ifndef OVITO_USE_SYCL
        std::array<T, 3>;
#else
        SYCL_NS::marray<T, 3>;
#endif

public:

    /// An empty type that denotes the point (0,0,0).
    struct Origin {};

    using size_type = std::size_t;
    using difference_type = std::ptrdiff_t;
    using typename base_type::value_type;
    using typename base_type::iterator;
    using typename base_type::const_iterator;

    /////////////////////////////// Constructors /////////////////////////////////

    /// Constructs a point without initializing its components. The components will have an undefined value!
    Point_3() = default;

    /// Constructs a point with all three components initialized to the given value.
    Q_DECL_CONSTEXPR explicit Point_3(T val) :
#ifndef OVITO_USE_SYCL
        base_type{{val,val,val}} {}
#else
        base_type{val,val,val} {}
#endif

    /// Initializes the coordinates of the point with the given values.
    Q_DECL_CONSTEXPR Point_3(T x, T y, T z) :
#ifndef OVITO_USE_SYCL
        base_type{{x, y, z}} {}
#else
        base_type{x, y, z} {}
#endif

    /// Initializes the point to the origin. All coordinates are set to zero.
    Q_DECL_CONSTEXPR Point_3(Origin) :
#ifndef OVITO_USE_SYCL
        base_type{{T(0), T(0), T(0)}} {}
#else
        base_type{T(0), T(0), T(0)} {}
#endif

    /// Initializes the point from an array of three coordinates.
    Q_DECL_CONSTEXPR explicit Point_3(const base_type& a) : base_type(a) {}

    /// Casts the point to another coordinate type \a U.
    template<typename U>
    Q_DECL_CONSTEXPR auto toDataType() const -> std::conditional_t<!std::is_same_v<T,U>, Point_3<U>, const Point_3<T>&> {
        if constexpr(!std::is_same_v<T,U>)
            return Point_3<U>(static_cast<U>(x()), static_cast<U>(y()), static_cast<U>(z()));
        else
            return *this;  // When casting to the same type \a T, this method becomes a no-op.
    }

    ///////////////////////////// Assignment operators ///////////////////////////

    /// Adds a vector to this point.
    Q_DECL_CONSTEXPR Point_3& operator+=(const Vector_3<T>& v) { x() += v.x(); y() += v.y(); z() += v.z(); return *this; }

    /// Subtracts a vector from this point.
    Q_DECL_CONSTEXPR Point_3& operator-=(const Vector_3<T>& v) { x() -= v.x(); y() -= v.y(); z() -= v.z(); return *this; }

    /// Multiplies all coordinates of the point with a scalar value.
    Q_DECL_CONSTEXPR Point_3& operator*=(T s) { x() *= s; y() *= s; z() *= s; return *this; }

    /// Divides all coordinates of the point by a scalar value.
    Q_DECL_CONSTEXPR Point_3& operator/=(T s) { x() /= s; y() /= s; z() /= s; return *this; }

    /// Sets all coordinates of the point to zero.
    Q_DECL_CONSTEXPR Point_3& operator=(Origin) { z() = y() = x() = T(0); return *this; }

    /// Converts a point to a vector.
    Q_DECL_CONSTEXPR const Vector_3<T>& operator-(Origin) const {
        // Implement this as a simple cast to Vector3 for best performance.
        OVITO_STATIC_ASSERT(sizeof(Vector_3<T>) == sizeof(Point_3<T>));
        return reinterpret_cast<const Vector_3<T>&>(*this);
    }

    //////////////////////////// Component access //////////////////////////

    /// \brief Returns the value of the X coordinate of this point.
    Q_DECL_CONSTEXPR T x() const { return (*this)[0]; }

    /// \brief Returns the value of the Y coordinate of this point.
    Q_DECL_CONSTEXPR T y() const { return (*this)[1]; }

    /// \brief Returns the value of the Z coordinate of this point.
    Q_DECL_CONSTEXPR T z() const { return (*this)[2]; }

    /// \brief Returns a reference to the X coordinate of this point.
    Q_DECL_CONSTEXPR T& x() { return (*this)[0]; }

    /// \brief Returns a reference to the Y coordinate of this point.
    Q_DECL_CONSTEXPR T& y() { return (*this)[1]; }

    /// \brief Returns a reference to the Z coordinate of this point.
    Q_DECL_CONSTEXPR T& z() { return (*this)[2]; }

#ifdef OVITO_USE_SYCL
    // Workaround for missing data() method in SYCL's marray class template.
    Q_DECL_CONSTEXPR T* data() noexcept { return &(*this)[0]; }
    Q_DECL_CONSTEXPR const T* data() const noexcept { return &(*this)[0]; }
#endif

    ////////////////////////////////// Comparison ////////////////////////////////

    /// \brief Compares two points for exact equality.
    /// \return \c true if all coordinates are equal; \c false otherwise.
    Q_DECL_CONSTEXPR bool operator==(const Point_3& p) const { return (p.x()==x()) && (p.y()==y()) && (p.z()==z()); }

    /// \brief Compares two points for inequality.
    /// \return \c true if any of the coordinates is not equal; \c false if all are equal.
    Q_DECL_CONSTEXPR bool operator!=(const Point_3& p) const { return (p.x()!=x()) || (p.y()!=y()) || (p.z()!=z()); }

    /// \brief Tests whether this point is at the origin, i.e. all of its coordinates are zero.
    /// \return \c true if all of the coordinates are exactly zero; \c false otherwise.
    Q_DECL_CONSTEXPR bool operator==(Origin) const { return (x()==T(0)) && (y()==T(0)) && (z()==T(0)); }

    /// \brief Tests whether the point is not at the origin, i.e. any of the coordinates is nonzero.
    /// \return \c true if any of the coordinates is nonzero; \c false if this is the origin point.
    Q_DECL_CONSTEXPR bool operator!=(Origin) const { return (x()!=T(0)) || (y()!=T(0)) || (z()!=T(0)); }

    /// \brief Tests if two points are equal within a specified tolerance.
    /// \param p The second point.
    /// \param tolerance A non-negative threshold for the equality test. The two points are considered equal if
    ///        the absolute differences in their X, Y, and Z coordinates are all smaller than this tolerance.
    /// \return \c true if this point is equal to the second point within the specified tolerance; \c false otherwise.
    Q_DECL_CONSTEXPR bool equals(const Point_3& p, T tolerance = FloatTypeEpsilon<T>()) const {
        return std::abs(p.x() - x()) <= tolerance && std::abs(p.y() - y()) <= tolerance && std::abs(p.z() - z()) <= tolerance;
    }

    /// \brief Tests whether this point is at the origin within a specified tolerance.
    /// \param tolerance A non-negative threshold.
    /// \return \c true if the absolute values of the point's coordinates are all below \a tolerance.
    Q_DECL_CONSTEXPR bool isOrigin(T tolerance = FloatTypeEpsilon<T>()) const {
        return std::abs(x()) <= tolerance && std::abs(y()) <= tolerance && std::abs(z()) <= tolerance;
    }

    ///////////////////////////////// Utilities ////////////////////////////////

    /// \brief Returns the index of the coordinate with the maximum value.
    Q_DECL_CONSTEXPR inline size_type maxComponent() const {
        return ((x() >= y()) ? ((x() >= z()) ? 0 : 2) : ((y() >= z()) ? 1 : 2));
    }

    /// \brief Returns the index of the coordinate with the minimum value.
    Q_DECL_CONSTEXPR inline size_type minComponent() const {
        return ((x() <= y()) ? ((x() <= z()) ? 0 : 2) : ((y() <= z()) ? 1 : 2));
    }

    /// \brief Returns the midpoint that is located halfway between this point and another point.
    Q_DECL_CONSTEXPR inline Point_3 midpoint(const Point_3& other) const {
        return Point_3(T(0.5) * (x() + other.x()), T(0.5) * (y() + other.y()), T(0.5) * (z() + other.z()));
    }

    /// \brief Generates a string representation of this point of the form (x y z).
    QString toString() const {
        return QString("(%1 %2 %3)").arg(x()).arg(y()).arg(z());
    }

#ifdef OVITO_USE_SYCL
    // Workaround for missing swap() method in SYCL's marray class template.
    friend void swap(Point_3& a, Point_3& b) noexcept {
        using namespace std;
        for(size_type i = 0; i < 3; i++)
            swap(a[i], b[i]);
    }
#endif
};

/// \brief Computes the sum of a point and a vector.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Point_3<T> operator+(const Point_3<T>& a, const Vector_3<T>& b) {
    return Point_3<T>( a.x() + b.x(), a.y() + b.y(), a.z() + b.z() );
}

/// \brief Converts a vector to a point.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR const Point_3<T>& operator+(typename Point_3<T>::Origin, const Vector_3<T>& b) {
    // Use cast for best performance.
    OVITO_STATIC_ASSERT(sizeof(Vector_3<T>) == sizeof(Point_3<T>));
    return reinterpret_cast<const Point_3<T>&>(b);
}

/// \brief Computes the sum of a vector and a point.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Point_3<T> operator+(const Vector_3<T>& a, const Point_3<T>& b) {
    return b + a;
}

/// \brief Subtracts a vector from a point.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Point_3<T> operator-(const Point_3<T>& a, const Vector_3<T>& b) {
    return Point_3<T>( a.x() - b.x(), a.y() - b.y(), a.z() - b.z() );
}

/// \brief Computes the vector connecting to two points.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator-(const Point_3<T>& a, const Point_3<T>& b) {
    return Vector_3<T>( a.x() - b.x(), a.y() - b.y(), a.z() - b.z() );
}

/// \brief Computes the component-wise product of a point and a scalar value.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Point_3<T> operator*(const Point_3<T>& a, T s) {
    return Point_3<T>( a.x() * s, a.y() * s, a.z() * s );
}

/// \brief Computes the component-wise product of a point and a scalar value.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Point_3<T> operator*(T s, const Point_3<T>& a) {
    return Point_3<T>( a.x() * s, a.y() * s, a.z() * s );
}

/// \brief Computes the component-wise division of a point by a scalar value.
/// \relates Point_3
template<typename T>
Q_DECL_CONSTEXPR Point_3<T> operator/(const Point_3<T>& a, T s) {
    return Point_3<T>( a.x() / s, a.y() / s, a.z() / s );
}

/// \brief Writes a point to a text output stream.
/// \relates Point_3
template<typename T>
inline std::ostream& operator<<(std::ostream& os, const Point_3<T>& v) {
    return os << "(" << v.x() << ", " << v.y()  << ", " << v.z() << ")";
}

/// \brief Writes a point to a Qt debug stream.
/// \relates Point_3


/// \brief Writes a point to a binary output stream.
/// \relates Point_3


/// \brief Reads a point from a binary input stream.
/// \relates Point_3


/// \brief Writes a point to a Qt data stream.
/// \relates Point_3


/// \brief Reads a point from a Qt data stream.
/// \relates Point_3


/**
 * \brief Instantiation of the Point_3 class template with the default floating-point type (double precision).
 * \relates Point_3
 */
using Point3 = Point_3<FloatType>;

/**
 * \brief Instantiation of the Point_3 class template with the single-precision floating-point type.
 * \relates Point_3
 */
using Point3F = Point_3<float>;

/**
 * \brief Instantiation of the Point_3 class template with the low-precision floating-point type used for graphics data.
 * \relates Point_3
 */
using Point3G = Point_3<GraphicsFloatType>;

/**
 * \brief Instantiation of the Point_3 class template with the default integer type.
 * \relates Point_3
 */
using Point3I = Point_3<int>;

}   // End of namespace

// Specialize STL templates for Point_3.
template<typename T> struct std::tuple_size<Ovito::Point_3<T>> : std::integral_constant<std::size_t, 3> {};
template<std::size_t I, typename T> struct std::tuple_element<I, Ovito::Point_3<T>> { using type = T; };

