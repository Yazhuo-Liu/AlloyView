// Headless adapters for OVITO's MIT-licensed numerical DXA implementation.
#pragma once
#include <ovito/core/Core.h>
#include <ovito/core/utilities/linalg/AffineTransformation.h>
#ifdef __EMSCRIPTEN_PTHREADS__
#include <exception>
#include <mutex>
#include <thread>
#endif

namespace Ovito {
using Color = Vector3;
namespace StdObj {}
namespace Mesh { class SurfaceMesh; class SurfaceMeshBuilder; }

template<class T> class DataOORef {
public:
    DataOORef() = default;
    DataOORef(T* value) : _value(value) {}
    static DataOORef create() {
        DataOORef result;
        result._owner = std::make_shared<std::remove_const_t<T>>();
        result._value = result._owner.get();
        return result;
    }
    T* operator->() const { return _value; }
    T& operator*() const { return *_value; }
    T* get() const { return _value; }
    operator T*() const { return _value; }
private:
    std::shared_ptr<std::remove_const_t<T>> _owner;
    T* _value = nullptr;
};

class PropertyStorage {
public:
    PropertyStorage(size_t count, size_t componentSize, size_t componentCount = 1)
        : _count(count), _components(componentCount), _elementSize(componentSize * componentCount),
          _bytes(count * _elementSize), _data(_bytes.data()) {}
    PropertyStorage(void* pointer, size_t count, size_t componentCount = 1, size_t componentSize = sizeof(double))
        : _count(count), _components(componentCount), _elementSize(componentCount * componentSize), _data(pointer) {}
    size_t size() const { return _count; }
    size_t componentCount() const { return _components; }
    size_t stride() const { return _elementSize; }
    void* data() { return _data; }
    const void* data() const { return _data; }
private:
    size_t _count, _components, _elementSize;
    std::vector<unsigned char> _bytes;
    void* _data;
};
using PropertyObject = PropertyStorage;
using PropertyPtr = std::shared_ptr<PropertyStorage>;
using ConstPropertyPtr = std::shared_ptr<const PropertyStorage>;
using PropertyStoragePtr = PropertyPtr;
using ConstPropertyStoragePtr = ConstPropertyPtr;
using SelectionIntType = int32_t;
enum class access_mode { read, write, read_write, discard_write, discard_read_write };

template<class T> class BufferReadAccess {
public:
    BufferReadAccess() = default;
    BufferReadAccess(std::nullptr_t) {}
    BufferReadAccess(const PropertyStorage* property) : _property(property) {}
    template<class P> BufferReadAccess(const std::shared_ptr<P>& property)
        : _owner(property), _property(property.get()) {}
    const T* begin() const { return data(); }
    const T* end() const { return data() + size(); }
    const T* cbegin() const { return begin(); }
    const T* cend() const { return end(); }
    const T* data() const { return _property ? static_cast<const T*>(_property->data()) : nullptr; }
    const T& operator[](size_t index) const { assert(index < size()); return data()[index]; }
    const T& get(size_t index) const { return (*this)[index]; }
    const PropertyStorage* buffer() const { return _property; }
    size_t size() const { return _property ? _property->size() : 0; }
    explicit operator bool() const { return _property != nullptr; }
    void reset() { _owner.reset(); _property = nullptr; }
protected:
    ConstPropertyPtr _owner;
    const PropertyStorage* _property = nullptr;
};

template<class T, access_mode Mode = access_mode::read_write> class BufferWriteAccess : public BufferReadAccess<T> {
public:
    using BufferReadAccess<T>::BufferReadAccess;
    T* data() const { return const_cast<T*>(BufferReadAccess<T>::data()); }
    T* begin() const { return data(); }
    T* end() const { return data() + this->size(); }
    T& operator[](size_t index) const { assert(index < this->size()); return data()[index]; }
    T& get(size_t index) const { return (*this)[index]; }
};
template<class T> using BufferReadAccessAndRef = BufferReadAccess<T>;
template<class T> using ConstPropertyAccess = BufferReadAccess<T>;
template<class T> using PropertyAccess = BufferWriteAccess<T>;

struct DataBuffer { enum { Initialized = 0 }; };
namespace Particles {
class NearestNeighborFinder;
struct ParticlesObject {
    enum { ClusterProperty = 1 };
    struct MetaClass {
        PropertyPtr createStandardProperty(int, size_t count, int) const {
            return std::make_shared<PropertyStorage>(count, sizeof(int64_t));
        }
    };
    static const MetaClass& OOClass() { static MetaClass type; return type; }
};
}

class SimulationCellObject {
public:
    explicit SimulationCellObject(const AffineTransformation& cell, std::array<bool, 3> pbc = {true, true, true})
        : _cell(cell), _inverse(cell.inverse()), _pbc(pbc) {}
    SimulationCellObject(const AffineTransformation& cell, bool x, bool y, bool z)
        : SimulationCellObject(cell, {x, y, z}) {}
    const AffineTransformation& cellMatrix() const { return _cell; }
    const AffineTransformation& matrix() const { return _cell; }
    const AffineTransformation& reciprocalCellMatrix() const { return _inverse; }
    const AffineTransformation& inverseMatrix() const { return _inverse; }
    bool hasPbc(size_t axis) const { return _pbc[axis]; }
    bool hasPbc() const { return _pbc[0] || _pbc[1] || _pbc[2]; }
    bool hasPbcCorrected(size_t axis) const { return hasPbc(axis); }
    bool hasPbcCorrected() const { return hasPbc(); }
    bool is2D() const { return false; }
    FloatType volume3D() const { return std::abs(_cell.determinant()); }
    bool isDegenerate() const {
        if(volume3D() <= FLOATTYPE_EPSILON) return true;
        for(int row = 0; row < 3; ++row) for(int col = 0; col < 4; ++col)
            if(!std::isfinite(_cell(row, col))) return true;
        return false;
    }
    bool isAxisAligned() const {
        for(int row = 0; row < 3; ++row) for(int col = 0; col < 3; ++col)
            if(row != col && _cell(row, col) != 0) return false;
        return true;
    }
    Point3 reducedToAbsolute(const Point3& point) const { return _cell * point; }
    Vector3 reducedToAbsolute(const Vector3& vector) const { return _cell * vector; }
    Point3 absoluteToReduced(const Point3& point) const { return _inverse * point; }
    Vector3 absoluteToReduced(const Vector3& vector) const { return _inverse * vector; }
    Point3 wrapPoint(const Point3& point) const {
        Point3 result = point;
        for(size_t axis = 0; axis < 3; ++axis) if(hasPbc(axis))
            result -= std::floor(_inverse.prodrow(point, axis)) * _cell.column(axis);
        return result;
    }
    Vector3 wrapVector(const Vector3& vector) const {
        Vector3 result = vector;
        for(size_t axis = 0; axis < 3; ++axis) if(hasPbc(axis))
            result -= std::floor(_inverse.prodrow(vector, axis) + 0.5) * _cell.column(axis);
        return result;
    }
    bool isWrappedVector(const Vector3& vector) const {
        for(size_t axis = 0; axis < 3; ++axis)
            if(hasPbc(axis) && std::abs(_inverse.prodrow(vector, axis)) >= 0.5) return true;
        return false;
    }
    Vector3 cellNormalVector(size_t axis) const {
        Vector3 normal = _cell.column((axis + 1) % 3).cross(_cell.column((axis + 2) % 3));
        if(normal.dot(_cell.column(axis)) < 0) normal = -normal;
        return normal.safelyNormalized();
    }
private:
    AffineTransformation _cell, _inverse;
    std::array<bool, 3> _pbc;
};

struct Box3 {
    Point3 minc, maxc;
    Box3() : minc(Point3::Origin()), maxc(Point3::Origin()) {}
    Box3(Point3 minimum, Point3 maximum) : minc(minimum), maxc(maximum), _empty(false) {}
    FloatType size(size_t axis) const { return maxc[axis] - minc[axis]; }
    Vector3 size() const { return maxc - minc; }
    void addPoints(const Point3* points, size_t count) {
        if(!count) return;
        size_t first = 0;
        if(_empty) { minc = maxc = points[0]; _empty = false; first = 1; }
        for(size_t index = first; index < count; ++index) for(size_t axis = 0; axis < 3; ++axis) {
            minc[axis] = std::min(minc[axis], points[index][axis]);
            maxc[axis] = std::max(maxc[axis], points[index][axis]);
        }
    }
    Point3 operator[](size_t corner) const {
        return Point3(corner & 1 ? maxc.x() : minc.x(),
                      corner & 2 ? maxc.y() : minc.y(),
                      corner & 4 ? maxc.z() : minc.z());
    }
    Box3 transformed(const AffineTransformation& transformation) const {
        if(_empty) return Box3();
        std::array<Point3, 8> corners;
        for(size_t corner = 0; corner < 8; ++corner) corners[corner] = transformation * (*this)[corner];
        Box3 result;
        result.addPoints(corners.data(), corners.size());
        return result;
    }
    void padBox(FloatType padding) {
        if(_empty) return;
        minc -= Vector3(padding);
        maxc += Vector3(padding);
    }
    int classifyPoint(const Point3& point) const {
        if(_empty) return -1;
        for(size_t axis = 0; axis < 3; ++axis)
            if(point[axis] < minc[axis] - FLOATTYPE_EPSILON || point[axis] > maxc[axis] + FLOATTYPE_EPSILON) return -1;
        return 1;
    }
private:
    bool _empty = true;
};

// JavaScript may request cancellation while the coordinating Worker is inside
// a synchronous Wasm call. The word lives in the shared heap for the lifetime
// of the module, and every local task observes it without a message roundtrip.
inline std::atomic<int32_t>& dxaCancellationWord() {
    static std::atomic<int32_t> canceled{0};
    return canceled;
}
class Task {
public:
    virtual ~Task() = default;
    bool isCanceled() const {
        return _canceled.load(std::memory_order_relaxed) ||
            dxaCancellationWord().load(std::memory_order_relaxed) != 0;
    }
    bool isProgressingTask() const { return true; }
    static Task* current();
    void cancel() { _canceled.store(true, std::memory_order_relaxed); }
    void resetCancellation() { _canceled.store(false, std::memory_order_relaxed); }
protected:
    std::atomic<bool> _canceled{false};
};
class ProgressingTask : public Task {
public:
    void setProgressMaximum(size_t value) { _maximum.store(value, std::memory_order_relaxed); }
    void setProgressMaximum(size_t value, bool) { setProgressMaximum(value); }
    bool setProgressValue(size_t value) { _value.store(value, std::memory_order_relaxed); return !isCanceled(); }
    bool incrementProgressValue(size_t value = 1) {
        _value.fetch_add(value, std::memory_order_relaxed);
        return !isCanceled();
    }
    bool setProgressValueIntermittent(size_t value) { return setProgressValue(value); }
    void setProgressText(const QString&) {}
    void beginProgressSubSteps(size_t) {}
    template<class T> void beginProgressSubStepsWithWeights(const T&) {}
    void beginProgressSubStepsWithWeights(std::initializer_list<int>) {}
    void nextProgressSubStep() {}
    void endProgressSubSteps() {}
private:
    std::atomic<size_t> _maximum{0}, _value{0};
};
inline Task* Task::current() { static ProgressingTask task; return &task; }

// The same adapter is compiled into the static-hosting serial binary and an
// optional shared-memory binary. Configure it only between complete analyses.
inline std::atomic<int>& dxaRequestedThreads() {
    static std::atomic<int> count{1};
    return count;
}
inline void configureDxaThreads(int count) {
#ifdef __EMSCRIPTEN_PTHREADS__
    dxaRequestedThreads().store(std::max(1, count), std::memory_order_relaxed);
#else
    (void)count;
    dxaRequestedThreads().store(1, std::memory_order_relaxed);
#endif
}
inline int dxaThreadCount() { return dxaRequestedThreads().load(std::memory_order_relaxed); }

template<class Function> bool dxaParallelFor(size_t count, Function& function, bool checkCancellation) {
    Task* const task = Task::current();
#ifdef __EMSCRIPTEN_PTHREADS__
    // Neighbor matching has irregular per-atom work. Small dynamic chunks avoid
    // leaving one worker with a costly boundary/defect region. The coordinator
    // runs the same loop, so N threads need only N-1 preloaded pthread Workers.
    const size_t threadCount = count < 2048 ? 1 : std::min<size_t>(dxaThreadCount(), count / 256);
    if(threadCount > 1) {
        constexpr size_t chunkSize = 32;
        std::atomic<size_t> next{0};
        std::atomic<bool> failed{false};
        std::exception_ptr error;
        std::mutex errorMutex;
        auto run = [&] {
            try {
                while(!failed.load(std::memory_order_relaxed) &&
                        !(checkCancellation && task->isCanceled())) {
                    const size_t first = next.fetch_add(chunkSize, std::memory_order_relaxed);
                    if(first >= count) break;
                    const size_t last = std::min(first + chunkSize, count);
                    for(size_t index = first; index < last; ++index) {
                        if(failed.load(std::memory_order_relaxed) ||
                                (checkCancellation && task->isCanceled())) break;
                        function(index);
                    }
                }
            }
            catch(...) {
                // Preserve the original scientific error (for example a cell
                // too thin for the selected neighbor shell) and join every
                // worker before its captured objects leave scope.
                std::lock_guard<std::mutex> lock(errorMutex);
                if(!error) error = std::current_exception();
                failed.store(true, std::memory_order_relaxed);
            }
        };
        std::vector<std::thread> workers;
        workers.reserve(threadCount - 1);
        try {
            for(size_t index = 1; index < threadCount; ++index) workers.emplace_back(run);
            run();
        }
        catch(...) {
            failed.store(true, std::memory_order_relaxed);
            for(auto& worker : workers) worker.join();
            throw;
        }
        for(auto& worker : workers) worker.join();
        if(error) std::rethrow_exception(error);
        return !(checkCancellation && task->isCanceled());
    }
#endif
    for(size_t index = 0; index < count; ++index) {
        if(checkCancellation && task->isCanceled()) return false;
        function(index);
    }
    return true;
}
template<class Function> bool parallelForWithProgress(size_t count, Function function) {
    return dxaParallelFor(count, function, true);
}
template<class Function> void parallelFor(size_t count, Function function) {
    dxaParallelFor(count, function, false);
}

namespace CrystalAnalysis {
    using namespace Ovito::Particles;
    using namespace Ovito::Mesh;
    class ClusterGraph;
    class DislocationNetwork;
    struct DislocationNode;
    struct DislocationSegment;
}
}
