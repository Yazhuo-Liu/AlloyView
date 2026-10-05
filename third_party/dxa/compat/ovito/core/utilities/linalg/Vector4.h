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
 * \brief Contains the definition of the Ovito::Vector_4 class template.
 */

#pragma once


#include <ovito/core/Core.h>
#include "Vector3.h"

namespace Ovito {

/**
 * \brief A vector with four components.
 *
 * The template parameter \a T specifies the data type of the vector's components.
 * Two standard instantiations of Vector_4 for floating-point and integer vectors are predefined:
 *
 * \code
 *      typedef Vector_4<FloatType>  Vector4;
 *      typedef Vector_4<int>        Vector4I;
 * \endcode
 *
 * Note that the default constructor does not initialize the components of the vector for performance reasons.
 * The nested type Zero can be used to construct the vector (0,0,0,0):
 *
 * \code
 *      Vector4 v = Vector4::Zero()
 * \endcode
 *
 * Vector_4 derives from std::array<T,4>. Thus, the vector's components can be accessed via indices, but also via names:
 *
 * \code
 *      v[3]  = 10.0;
 *      v.w() = 10.0;
 * \endcode
 *
 * \sa Vector_2, Vector_3, Matrix_4
 */
template<typename T>
class Vector_4 : public std::array<T, 4>
{
public:

    /// An empty type that denotes the vector (0,0,0,0).
    struct Zero {};

    using typename std::array<T, 4>::size_type;
    using typename std::array<T, 4>::difference_type;
    using typename std::array<T, 4>::value_type;
    using typename std::array<T, 4>::iterator;
    using typename std::array<T, 4>::const_iterator;

    /////////////////////////////// Constructors /////////////////////////////////

    /// Constructs a vector without initializing its components. The components will have an undefined value!
    Vector_4() = default;

    /// Constructs a vector with all four components initialized to the given value.
    Q_DECL_CONSTEXPR explicit Vector_4(T val) : std::array<T, 4>{{val,val,val,val}} {}

        /// Initializes the components of the vector with the given values.
    Q_DECL_CONSTEXPR Vector_4(T x, T y, T z, T w) : std::array<T, 4>{{x, y, z, w}} {}

        /// Initializes the vector to the null vector. All components are set to zero.
    Q_DECL_CONSTEXPR Vector_4(Zero) : std::array<T, 4>{{T(0), T(0), T(0), T(0)}} {}

    /// Initializes the vector from an array.
    Q_DECL_CONSTEXPR explicit Vector_4(const std::array<T, 4>& a) : std::array<T, 4>(a) {}

    /// Initializes the 4-vector from a 3-vector.
    /// \param v Specifies the xyz components of the new vector.
    /// \param w The w component of the new vector.
    Q_DECL_CONSTEXPR explicit Vector_4(const Vector_3<T>& v, T w) : std::array<T, 4>{{v.x(), v.y(), v.z(), w}} {}

    /// Casts the vector to another component type \a U.
    template<typename U>
    Q_DECL_CONSTEXPR auto toDataType() const -> std::conditional_t<!std::is_same_v<T,U>, Vector_4<U>, const Vector_4<T>&> {
        if constexpr(!std::is_same_v<T,U>)
            return Vector_4<U>(static_cast<U>(x()), static_cast<U>(y()), static_cast<U>(z()), static_cast<U>(w()));
        else
            return *this;  // When casting to the same type \a T, this method becomes a no-op.
    }

    /////////////////////////////// Unary operators //////////////////////////////

    /// Returns the reverse vector (-x(), -y(), -z(), -w()).
    Q_DECL_CONSTEXPR Vector_4 operator-() const { return Vector_4{-x(), -y(), -z(), -w()}; }

    /// Conversion operator to a Qt vector.

    ///////////////////////////// Assignment operators ///////////////////////////

    /// Increments the components of this vector by the components of another vector.
    Q_DECL_CONSTEXPR Vector_4& operator+=(const Vector_4& v) { x() += v.x(); y() += v.y(); z() += v.z(); w() += v.w(); return *this; }

    /// Decrements the components of this vector by the components of another vector.
    Q_DECL_CONSTEXPR Vector_4& operator-=(const Vector_4& v) { x() -= v.x(); y() -= v.y(); z() -= v.z(); w() -= v.w(); return *this; }

    /// Multiplies each component of the vector with a scalar.
    Q_DECL_CONSTEXPR Vector_4& operator*=(T s) { x() *= s; y() *= s; z() *= s; w() *= s; return *this; }

    /// Divides each component of the vector by a scalar.
    Q_DECL_CONSTEXPR Vector_4& operator/=(T s) { x() /= s; y() /= s; z() /= s; w() /= s; return *this; }

    /// Sets all components of the vector to zero.
    Q_DECL_CONSTEXPR Vector_4& operator=(Zero) { setZero(); return *this; }

    /// Sets all components of the vector to zero.
    Q_DECL_CONSTEXPR void setZero() { this->fill(T(0)); }

    //////////////////////////// Component access //////////////////////////

    /// Returns the value of the X component of this vector.
    Q_DECL_CONSTEXPR T x() const { return (*this)[0]; }

    /// Returns the value of the Y component of this vector.
    Q_DECL_CONSTEXPR T y() const { return (*this)[1]; }

    /// Returns the value of the Z component of this vector.
    Q_DECL_CONSTEXPR T z() const { return (*this)[2]; }

    /// Returns the value of the W component of this vector.
    Q_DECL_CONSTEXPR T w() const { return (*this)[3]; }

    /// Returns a reference to the X component of this vector.
    Q_DECL_CONSTEXPR T& x() { return (*this)[0]; }

    /// Returns a reference to the Y component of this vector.
    Q_DECL_CONSTEXPR T& y() { return (*this)[1]; }

    /// Returns a reference to the Z component of this vector.
    Q_DECL_CONSTEXPR T& z() { return (*this)[2]; }

    /// Returns a reference to the W component of this vector.
    Q_DECL_CONSTEXPR T& w() { return (*this)[3]; }

    ////////////////////////////////// Comparison ////////////////////////////////

    /// \brief Compares two vectors for exact equality.
    /// \return \c true if all components are equal; \c false otherwise.
    Q_DECL_CONSTEXPR bool operator==(const Vector_4& v) const { return (v.x()==x()) && (v.y()==y()) && (v.z()==z()) && (v.w()==w()); }

    /// \brief Compares two vectors for inequality.
    /// \return \c true if any of the components are not equal; \c false if all are equal.
    Q_DECL_CONSTEXPR bool operator!=(const Vector_4& v) const { return (v.x()!=x()) || (v.y()!=y()) || (v.z()!=z()) || (v.w()!=w()); }

    /// \brief Tests if the vector is the null vector, i.e. if all components are zero.
    /// \return \c true if all components are exactly zero; \c false otherwise
    Q_DECL_CONSTEXPR bool operator==(Zero) const { return (x()==T(0)) && (y()==T(0)) && (z()==T(0)) && (w()==T(0)); }

    /// \brief Tests if the vector is not a null vector, i.e. if any of the components is nonzero.
    /// \return \c true if any component is nonzero; \c false if all components are exactly zero.
    Q_DECL_CONSTEXPR bool operator!=(Zero) const { return (x()!=T(0)) || (y()!=T(0)) || (z()!=T(0)) || (w()!=T(0)); }

    /// \brief Tests if two vectors are equal within a given tolerance.
    /// \param v The vector to compare to this vector.
    /// \param tolerance A non-negative threshold for the equality test. The two vectors are considered equal if
    ///        the differences in the four components are all less than this tolerance value.
    /// \return \c true if this vector is equal to \a v within the given tolerance; \c false otherwise.
    Q_DECL_CONSTEXPR bool equals(const Vector_4& v, T tolerance = FloatTypeEpsilon<T>()) const {
        return std::abs(v.x() - x()) <= tolerance && std::abs(v.y() - y()) <= tolerance && std::abs(v.z() - z()) <= tolerance && std::abs(v.w() - w()) <= tolerance;
    }

    /// \brief Test if the vector is zero within a given tolerance.
    /// \param tolerance A non-negative threshold.
    /// \return \c true if the absolute vector components are all smaller than \a tolerance.
    Q_DECL_CONSTEXPR bool isZero(T tolerance = FloatTypeEpsilon<T>()) const {
        return std::abs(x()) <= tolerance && std::abs(y()) <= tolerance && std::abs(z()) <= tolerance && std::abs(w()) <= tolerance;
    }

    ///////////////////////////////// Computations ////////////////////////////////

    /// Computes the inner dot product of this vector with the vector \a b.
    Q_DECL_CONSTEXPR T dot(const Vector_4& b) const { return x()*b.x() + y()*b.y() + z()*b.z() + w()*b.w(); }

    /// Computes the squared length of the vector.
    Q_DECL_CONSTEXPR T squaredLength() const { return x()*x() + y()*y() + z()*z() + w()*w(); }

    /// Computes the length of the vector.
    Q_DECL_CONSTEXPR T length() const { return static_cast<T>(sqrt(squaredLength())); }

    /// \brief Normalizes this vector by dividing it by its length, making it a unit vector.
    /// \warning Do not call this function if the vector has length zero to avoid division by zero.
    /// In debug builds, a zero vector will be detected and reported. In release builds, the behavior is undefined.
    /// \sa normalized(), normalizeSafely()
    Q_DECL_CONSTEXPR inline void normalize() {
        OVITO_ASSERT_MSG(*this != Zero(), "Vector4::normalize", "Cannot normalize a vector with zero length.");
        *this /= length();
    }

    /// \brief Returns a normalized version of this vector.
    /// \return The unit vector.
    /// \warning Do not call this function if the vector has length zero to avoid division by zero.
    /// In debug builds, a zero vector will be detected and reported. In release builds, the behavior is undefined.
    /// \sa normalize(), normalizeSafely()
    Q_DECL_CONSTEXPR inline Vector_4 normalized() const {
        OVITO_ASSERT_MSG(*this != Zero(), "Vector4::normalize", "Cannot normalize a vector with zero length.");
        return *this / length();
    }

    /// \brief Normalizes this vector to make it a unit vector (only if it is non-zero).
    /// \param epsilon The epsilon used to test if this vector is zero.
    /// This method rescales this vector to unit length if its original length is greater than \a epsilon.
    /// Otherwise it does nothing.
    /// \sa normalize(), normalized()
    Q_DECL_CONSTEXPR inline void normalizeSafely(T epsilon = FloatTypeEpsilon<T>()) {
        T l = length();
        if(l > epsilon)
            *this /= l;
    }

    ///////////////////////////////// Utilities ////////////////////////////////

    /// \brief Returns the index of the component with the maximum value.
    Q_DECL_CONSTEXPR inline size_type maxComponent() const {
        return std::distance(std::array<T, 4>::begin(), std::max_element(std::array<T, 4>::begin(), std::array<T, 4>::end()));
    }

    /// \brief Returns the index of the component with the minimum value.
    Q_DECL_CONSTEXPR inline size_type minComponent() const {
        return std::distance(std::array<T, 4>::begin(), std::min_element(std::array<T, 4>::begin(), std::array<T, 4>::end()));
    }

    /// \brief Produces a string representation of the vector of the form (x y z w).
    QString toString() const {
        return QString("(%1 %2 %3 %4)").arg(x()).arg(y()).arg(z()).arg(w());
    }
};

/// \brief Computes the sum of two vectors.
/// \relates Vector_4
template<typename T>
Q_DECL_CONSTEXPR Vector_4<T> operator+(const Vector_4<T>& a, const Vector_4<T>& b) {
    return Vector_4<T>( a.x() + b.x(), a.y() + b.y(), a.z() + b.z(), a.w() + b.w() );
}

/// \brief Computes the difference of two vectors.
/// \relates Vector_4
template<typename T>
Q_DECL_CONSTEXPR Vector_4<T> operator-(const Vector_4<T>& a, const Vector_4<T>& b) {
    return Vector_4<T>( a.x() - b.x(), a.y() - b.y(), a.z() - b.z(), a.w() - b.w() );
}

/// \brief Computes the product of a vector and a scalar value.
/// \relates Vector_4
template<typename T>
Q_DECL_CONSTEXPR Vector_4<T> operator*(const Vector_4<T>& a, T s) {
    return Vector_4<T>( a.x() * s, a.y() * s, a.z() * s, a.w() * s );
}

/// \brief Computes the product of a scalar value and a vector.
/// \relates Vector_4
template<typename T>
Q_DECL_CONSTEXPR Vector_4<T> operator*(T s, const Vector_4<T>& a) {
    return Vector_4<T>( a.x() * s, a.y() * s, a.z() * s, a.w() * s );
}

/// \brief Computes the division of a vector by a scalar value.
/// \relates Vector_4
template<typename T>
Q_DECL_CONSTEXPR Vector_4<T> operator/(const Vector_4<T>& a, T s) {
    return Vector_4<T>( a.x() / s, a.y() / s, a.z() / s, a.w() / s );
}

/// \brief Writes a vector to a text output stream.
/// \relates Vector_4
template<typename T>
inline std::ostream& operator<<(std::ostream& os, const Vector_4<T>& v) {
    return os << "(" << v.x() << ", " << v.y()  << ", " << v.z() << ", " << v.w() << ")";
}

/// \brief Writes a vector to a Qt debug stream.
/// \relates Vector_4


/// \brief Writes a vector to a binary output stream.
/// \relates Vector_4


/// \brief Reads a vector from a binary input stream.
/// \relates Vector_4


/// \brief Writes a vector to a Qt data stream.
/// \relates Vector_4


/// \brief Reads a vector from a Qt data stream.
/// \relates Vector_4


/**
 * \brief Instantiation of the Vector_4 class template with the default floating-point type (double precision).
 * \relates Vector_4
 */
using Vector4 = Vector_4<FloatType>;

/**
 * \brief Instantiation of the Vector_4 class template with the single-precision floating-point type.
 * \relates Vector_4
 */
using Vector4F = Vector_4<float>;

/**
 * \brief Instantiation of the Vector_4 class template with the default integer type.
 * \relates Vector_4
 */
using Vector4I = Vector_4<int>;

}   // End of namespace

// Specialize STL templates for Vector_4.
template<typename T> struct std::tuple_size<Ovito::Vector_4<T>> : std::integral_constant<std::size_t, 4> {};
template<std::size_t I, typename T> struct std::tuple_element<I, Ovito::Vector_4<T>> { using type = T; };

