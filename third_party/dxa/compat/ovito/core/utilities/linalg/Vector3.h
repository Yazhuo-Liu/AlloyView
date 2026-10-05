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
 * \brief Contains the definition of the Ovito::Vector_3 class template.
 */

#pragma once


#include <ovito/core/Core.h>

namespace Ovito {

/**
 * \brief A vector with three components.
 *
 * Vector_3 represents a vector in three-dimensional space. Note that there exists a corresponding
 * class Point_3, which represents a *point* in three-dimensional space.
 *
 * The template parameter \a T specifies the data type of the vector's components.
 * Two standard instantiations of Vector_3 for floating-point and integer vectors are predefined:
 *
 * \code
 *      typedef Vector_3<FloatType>  Vector3;
 *      typedef Vector_3<int>        Vector3I;
 * \endcode
 *
 * Note that the default constructor does not initialize the components of the vector for performance reasons.
 * The nested type Zero can be used to construct the vector (0,0,0):
 *
 * \code
 *      Vector3 v = Vector3::Zero()
 * \endcode
 *
 * Vector_3 derives from std::array<T,3>. Thus, the vector's components can be accessed via indices, but also via names:
 *
 * \code
 *      v[1]  = 10.0;
 *      v.y() = 10.0;
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
 * \sa Point_3, Vector_2, Vector_4
 */
template<typename T>
class Vector_3 : public
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

    /// An empty type denoting the vector (0,0,0).
    struct Zero {};

    using size_type = std::size_t;
    using difference_type = std::ptrdiff_t;
    using typename base_type::value_type;
    using typename base_type::iterator;
    using typename base_type::const_iterator;

    /////////////////////////////// Constructors /////////////////////////////////

    /// Constructs a vector without initializing its components. The components will have an undefined value!
    Vector_3() = default;

    /// Constructs a vector with all three components initialized to the given value.
    Q_DECL_CONSTEXPR explicit Vector_3(T val) :
#ifndef OVITO_USE_SYCL
        base_type{{val,val,val}} {}
#else
        base_type{val,val,val} {}
#endif

    /// Initializes the components of the vector with the given values.
    Q_DECL_CONSTEXPR Vector_3(T x, T y, T z) :
#ifndef OVITO_USE_SYCL
        base_type{{x, y, z}} {}
#else
        base_type{x, y, z} {}
#endif

    /// Initializes the vector to the null vector. All components are set to zero.
    Q_DECL_CONSTEXPR Vector_3(Zero) :
#ifndef OVITO_USE_SYCL
        base_type{{T(0), T(0), T(0)}} {}
#else
        base_type{T(0), T(0), T(0)} {}
#endif

    /// Initializes the vector from an array.
    Q_DECL_CONSTEXPR explicit Vector_3(const base_type& a) : base_type(a) {}

    /// Casts the vector to another component type \a U.
    template<typename U>
    Q_DECL_CONSTEXPR auto toDataType() const -> std::conditional_t<!std::is_same_v<T,U>, Vector_3<U>, const Vector_3<T>&> {
        if constexpr(!std::is_same_v<T,U>)
            return Vector_3<U>(static_cast<U>(x()), static_cast<U>(y()), static_cast<U>(z()));
        else
            return *this;  // When casting to the same type \a T, this method becomes a no-op.
    }

    /////////////////////////////// Unary operators //////////////////////////////

    /// Returns the reverse vector (-x(), -y(), -z()).
    Q_DECL_CONSTEXPR Vector_3 operator-() const { return Vector_3(-x(), -y(), -z()); }

    /// Conversion operator to a Qt vector.

    ///////////////////////////// Assignment operators ///////////////////////////

    /// Increments the components of this vector by the components of another vector.
    Q_DECL_CONSTEXPR Vector_3& operator+=(const Vector_3& v) { x() += v.x(); y() += v.y(); z() += v.z(); return *this; }

    /// Decrements the components of this vector by the components of another vector.
    Q_DECL_CONSTEXPR Vector_3& operator-=(const Vector_3& v) { x() -= v.x(); y() -= v.y(); z() -= v.z(); return *this; }

    /// Multiplies each component of the vector with a scalar.
    Q_DECL_CONSTEXPR Vector_3& operator*=(T s) { x() *= s; y() *= s; z() *= s; return *this; }

    /// Divides each component of the vector by a scalar.
    Q_DECL_CONSTEXPR Vector_3& operator/=(T s) { x() /= s; y() /= s; z() /= s; return *this; }

    /// Sets all components of the vector to zero.
    Q_DECL_CONSTEXPR Vector_3& operator=(Zero) { setZero(); return *this; }

    /// Sets all components of the vector to zero.
    Q_DECL_CONSTEXPR void setZero() {
#ifndef OVITO_USE_SYCL
        this->fill(T(0));
#else
        std::fill(this->begin(), this->end(), T(0));
#endif
    }

    //////////////////////////// Component access //////////////////////////

    /// Returns the value of the X component of this vector.
    Q_DECL_CONSTEXPR T x() const { return (*this)[0]; }

    /// Returns the value of the Y component of this vector.
    Q_DECL_CONSTEXPR T y() const { return (*this)[1]; }

    /// Returns the value of the Z component of this vector.
    Q_DECL_CONSTEXPR T z() const { return (*this)[2]; }

    /// Returns a reference to the X component of this vector.
    Q_DECL_CONSTEXPR T& x() { return (*this)[0]; }

    /// Returns a reference to the Y component of this vector.
    Q_DECL_CONSTEXPR T& y() { return (*this)[1]; }

    /// Returns a reference to the Z component of this vector.
    Q_DECL_CONSTEXPR T& z() { return (*this)[2]; }

#ifdef OVITO_USE_SYCL
    // Workaround for missing data() method in SYCL's marray class template.
    Q_DECL_CONSTEXPR T* data() noexcept { return &(*this)[0]; }
    Q_DECL_CONSTEXPR const T* data() const noexcept { return &(*this)[0]; }
#endif

    ////////////////////////////////// Comparison ////////////////////////////////

    /// \brief Compares two vectors for exact equality.
    /// \return \c true if all components are equal; \c false otherwise.
    Q_DECL_CONSTEXPR bool operator==(const Vector_3& v) const { return (v.x()==x()) && (v.y()==y()) && (v.z()==z()); }

    /// \brief Compares two vectors for inequality.
    /// \return \c true if any of the components are not equal; \c false if all are equal.
    Q_DECL_CONSTEXPR bool operator!=(const Vector_3& v) const { return (v.x()!=x()) || (v.y()!=y()) || (v.z()!=z()); }

    /// \brief Tests if the vector is the null vector, i.e. if all components are zero.
    /// \return \c true if all components are exactly zero; \c false otherwise
    Q_DECL_CONSTEXPR bool operator==(Zero) const { return (x()==T(0)) && (y()==T(0)) && (z()==T(0)); }

    /// \brief Tests if the vector is not a null vector, i.e. if any of the components is nonzero.
    /// \return \c true if any component is nonzero; \c false if all components are exactly zero.
    Q_DECL_CONSTEXPR bool operator!=(Zero) const { return (x()!=T(0)) || (y()!=T(0)) || (z()!=T(0)); }

    /// \brief Tests if two vectors are equal within a given tolerance.
    /// \param v The vector to compare to this vector.
    /// \param tolerance A non-negative threshold for the equality test. The two vectors are considered equal if
    ///        the differences in the three components are all less than this tolerance value.
    /// \return \c true if this vector is equal to \a v within the given tolerance; \c false otherwise.
    Q_DECL_CONSTEXPR bool equals(const Vector_3& v, T tolerance = FloatTypeEpsilon<T>()) const {
        return std::abs(v.x() - x()) <= tolerance && std::abs(v.y() - y()) <= tolerance && std::abs(v.z() - z()) <= tolerance;
    }

    /// \brief Test if the vector is zero within a given tolerance.
    /// \param tolerance A non-negative threshold.
    /// \return \c true if the absolute vector components are all smaller than \a tolerance.
    Q_DECL_CONSTEXPR bool isZero(T tolerance = FloatTypeEpsilon<T>()) const {
        return std::abs(x()) <= tolerance && std::abs(y()) <= tolerance && std::abs(z()) <= tolerance;
    }

    ///////////////////////////////// Computations ////////////////////////////////

    /// Computes the inner dot product of this vector with the vector \a b.
    Q_DECL_CONSTEXPR T dot(const Vector_3& b) const { return x()*b.x() + y()*b.y() + z()*b.z(); }

    /// Computes the cross product of this vector with the vector \a b.
    Q_DECL_CONSTEXPR Vector_3 cross(const Vector_3& b) const {
        return Vector_3(y() * b.z() - z() * b.y(),
                        z() * b.x() - x() * b.z(),
                        x() * b.y() - y() * b.x());
    }

    /// Computes the squared length of the vector.
    Q_DECL_CONSTEXPR T squaredLength() const { return x()*x() + y()*y() + z()*z(); }

    /// Computes the length of the vector.
    Q_DECL_CONSTEXPR T length() const { return static_cast<T>(sqrt(squaredLength())); }

    /// \brief Normalizes this vector by dividing it by its length, making it a unit vector.
    /// \warning Do not call this function if the vector has length zero to avoid division by zero.
    /// In debug builds, a zero vector will be detected and reported. In release builds, the behavior is undefined.
    /// \sa normalized(), normalizeSafely(), resize()
    Q_DECL_CONSTEXPR inline void normalize() {
        OVITO_ASSERT_MSG(*this != Zero(), "Vector3::normalize", "Cannot normalize a vector of length zero.");
        *this /= length();
    }

    /// \brief Returns a normalized version of this vector.
    /// \return The unit vector.
    /// \warning Do not call this function if the vector has length zero to avoid division by zero.
    /// In debug builds, a zero vector will be detected and reported. In release builds, the behavior is undefined.
    /// \sa normalize(), normalizeSafely()
    Q_DECL_CONSTEXPR inline Vector_3 normalized() const {
        OVITO_ASSERT_MSG(*this != Zero(), "Vector3::normalize", "Cannot normalize a vector of length zero.");
        return *this / length();
    }

    /// \brief Returns a normalized version of this vector (unless it is the null vector).
    /// \param epsilon The epsilon used to test if this vector is zero.
    /// \return The normalized vector.
    /// \sa normalized(), normalizeSafely()
    Q_DECL_CONSTEXPR inline Vector_3 safelyNormalized(T epsilon = FloatTypeEpsilon<T>()) const {
        T l = length();
        if(l > epsilon)
            return *this / l;
        else
            return Vector_3::Zero();
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

    /// \brief Rescales this vector to the given length.
    /// \param len The new length of the vector.
    /// \warning Do not call this function if the vector has length zero to avoid division by zero.
    /// In debug builds, a zero vector will be detected and reported. In release builds, the behavior is undefined.
    /// \sa resized(), normalize(), normalized()
    Q_DECL_CONSTEXPR inline void resize(T len) {
        OVITO_ASSERT_MSG(*this != Zero(), "Vector3::resize", "Cannot resize a vector of length zero.");
        *this *= (len / length());
    }

    /// \brief Returns a copy of this vector having the given length.
    /// \param len The length of the vector to return. May be negative.
    /// \return The rescaled vector.
    /// \warning Do not call this function if the vector has length zero to avoid division by zero.
    /// In debug builds, a zero vector will be detected and reported. In release builds, the behavior is undefined.
    /// \sa resize(), normalized()
    Q_DECL_CONSTEXPR inline Vector_3 resized(T len) const {
        OVITO_ASSERT_MSG(*this != Zero(), "Vector3::resized", "Cannot resize a vector of length zero.");
        return *this * (len / length());
    }

    ///////////////////////////////// Utilities ////////////////////////////////

    /// \brief Returns the index of the component with the maximum value.
    Q_DECL_CONSTEXPR inline size_type maxComponent() const {
        return ((x() >= y()) ? ((x() >= z()) ? 0 : 2) : ((y() >= z()) ? 1 : 2));
    }

    /// \brief Returns the index of the component with the minimum value.
    Q_DECL_CONSTEXPR inline size_type minComponent() const {
        return ((x() <= y()) ? ((x() <= z()) ? 0 : 2) : ((y() <= z()) ? 1 : 2));
    }

    /// \brief Produces a string representation of the vector of the form (x y z).
    QString toString() const {
        return QString("(%1 %2 %3)").arg(x()).arg(y()).arg(z());
    }

#ifdef OVITO_USE_SYCL
    // Workaround for missing swap() method in SYCL's marray class template.
    friend void swap(Vector_3& a, Vector_3& b) noexcept {
        for(size_type i = 0; i < 3; i++)
            std::swap(a[i], b[i]);
    }
#endif
};

/// \brief Computes the sum of two vectors.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator+(const Vector_3<T>& a, const Vector_3<T>& b) {
    return Vector_3<T>( a.x() + b.x(), a.y() + b.y(), a.z() + b.z() );
}

/// \brief Computes the difference of two vectors.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator-(const Vector_3<T>& a, const Vector_3<T>& b) {
    return Vector_3<T>( a.x() - b.x(), a.y() - b.y(), a.z() - b.z() );
}

/// \brief Computes the product of a vector and a scalar value.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator*(const Vector_3<T>& a, float s) {
    return Vector_3<T>( a.x() * (T)s, a.y() * (T)s, a.z() * (T)s );
}

/// \brief Computes the product of a vector and a scalar value.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator*(const Vector_3<T>& a, double s) {
    return Vector_3<T>( a.x() * (T)s, a.y() * (T)s, a.z() * (T)s );
}

/// \brief Computes the product of a vector and a scalar value.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator*(const Vector_3<T>& a, int s) {
    return Vector_3<T>( a.x() * s, a.y() * s, a.z() * s );
}

/// \brief Computes the product of a scalar value and a vector.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator*(float s, const Vector_3<T>& a) {
    return Vector_3<T>( a.x() * (T)s, a.y() * (T)s, a.z() * (T)s );
}

/// \brief Computes the product of a scalar value and a vector.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator*(double s, const Vector_3<T>& a) {
    return Vector_3<T>( a.x() * (T)s, a.y() * (T)s, a.z() * (T)s );
}

/// \brief Computes the product of a scalar value and a vector.
/// \relates Vector_3
template<typename T>
Q_DECL_CONSTEXPR Vector_3<T> operator*(int s, const Vector_3<T>& a) {
    return Vector_3<T>( a.x() * s, a.y() * s, a.z() * s );
}

/// \brief Computes the division of a vector by a scalar value.
/// \relates Vector_3
template<typename T, typename S>
Q_DECL_CONSTEXPR Vector_3<T> operator/(const Vector_3<T>& a, S s) {
    return Vector_3<T>( a.x() / s, a.y() / s, a.z() / s );
}

/// \brief Writes a vector to a text output stream.
/// \relates Vector_3
template<typename T>
inline std::ostream& operator<<(std::ostream& os, const Vector_3<T>& v) {
    return os << "(" << v.x() << ", " << v.y()  << ", " << v.z() << ")";
}

/// \brief Writes a vector to a Qt debug stream.
/// \relates Vector_3


/// \brief Writes a vector to a binary output stream.
/// \relates Vector_3


/// \brief Reads a vector from a binary input stream.
/// \relates Vector_3


/// \brief Writes a vector to a Qt data stream.
/// \relates Vector_3


/// \brief Reads a vector from a Qt data stream.
/// \relates Vector_3


/**
 * \brief Instantiation of the Vector_3 class template with the default floating-point type (double precision).
 * \relates Vector_3
 */
using Vector3 = Vector_3<FloatType>;

/**
 * \brief Instantiation of the Vector_3 class template with the single-precision floating-point type.
 * \relates Vector_3
 */
using Vector3F = Vector_3<float>;

/**
 * \brief Instantiation of the Vector_3 class template with the low-precision floating-point type used for graphics data.
 * \relates Vector_3
 */
using Vector3G = Vector_3<GraphicsFloatType>;

/**
 * \brief Instantiation of the Vector_3 class template with the default integer type.
 * \relates Vector_3
*/
using Vector3I = Vector_3<int32_t>;

}   // End of namespace

// Specialize STL templates for Vector_3.
template<typename T> struct std::tuple_size<Ovito::Vector_3<T>> : std::integral_constant<std::size_t, 3> {};
template<std::size_t I, typename T> struct std::tuple_element<I, Ovito::Vector_3<T>> { using type = T; };

