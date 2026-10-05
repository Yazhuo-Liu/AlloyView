// Headless compatibility definitions for the MIT-licensed OVITO DXA port.
#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <optional>
#include <ostream>
#include <queue>
#include <random>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#define Q_DECL_CONSTEXPR constexpr
#define OVITO_ASSERT(condition) assert(condition)
#define OVITO_ASSERT_MSG(condition, context, message) assert(condition)
#define OVITO_STATIC_ASSERT(condition) static_assert(condition)
#define OVITO_CRYSTALANALYSIS_EXPORT
#define OVITO_PARTICLES_EXPORT
#define OVITO_CORE_EXPORT
#define OVITO_DELAUNAY_EXPORT
#define OVITO_MESH_EXPORT
#define QStringLiteral(value) QString(value)
using qint64 = int64_t;
using quint64 = uint64_t;

class QString {
public:
    QString() = default;
    QString(const char* value) : _value(value) {}
    QString(std::string value) : _value(std::move(value)) {}
    template<class T> QString arg(const T& value) const {
        std::ostringstream stream;
        stream << value;
        std::string result = _value;
        size_t position = std::string::npos;
        for(int index = 1; index <= 9; ++index) {
            position = result.find("%" + std::to_string(index));
            if(position != std::string::npos) break;
        }
        if(position != std::string::npos) result.replace(position, 2, stream.str());
        return QString(std::move(result));
    }
    const std::string& toStdString() const { return _value; }
    friend std::ostream& operator<<(std::ostream& stream, const QString& value) {
        return stream << value._value;
    }
private:
    std::string _value;
};

template<class T> constexpr T qBound(T minimum, T value, T maximum) {
    return std::max(minimum, std::min(value, maximum));
}

namespace Ovito {
using FloatType = double;
using GraphicsFloatType = float;
constexpr FloatType FLOATTYPE_EPSILON = 1e-12;
constexpr FloatType FLOATTYPE_MAX = std::numeric_limits<FloatType>::max();
constexpr FloatType FLOATTYPE_PI = 3.141592653589793238462643383279502884;
template<class T> constexpr T FloatTypeEpsilon() { return T{}; }
template<> constexpr float FloatTypeEpsilon<float>() { return 1e-6f; }
template<> constexpr double FloatTypeEpsilon<double>() { return 1e-12f; }
class Exception : public std::runtime_error {
public:
    explicit Exception(const char* value) : std::runtime_error(value) {}
    explicit Exception(const std::string& value) : std::runtime_error(value) {}
    explicit Exception(const QString& value) : std::runtime_error(value.toStdString()) {}
};
}

// DXA only needs the basic checked bitset operations; avoid a Boost runtime.
namespace boost {
template<class Block = uint64_t, class Allocator = std::allocator<Block>>
class dynamic_bitset {
public:
    explicit dynamic_bitset(size_t count = 0) : _count(count), _words((count + 63) / 64) {}
    void resize(size_t count) { _count = count; _words.resize((count + 63) / 64); }
    bool test(size_t index) const { assert(index < _count); return (_words[index / 64] >> (index % 64)) & 1; }
    void set(size_t index, bool value = true) {
        assert(index < _count);
        uint64_t mask = uint64_t(1) << (index % 64);
        if(value) _words[index / 64] |= mask;
        else _words[index / 64] &= ~mask;
    }
    void reset(size_t index) { set(index, false); }
    void reset() { std::fill(_words.begin(), _words.end(), 0); }
private:
    size_t _count;
    std::vector<uint64_t> _words;
};
}
