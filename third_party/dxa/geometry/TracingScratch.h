// Bounded temporary storage for the headless DXA Burgers-circuit search.
#pragma once

#include <algorithm>
#include <cstddef>
#include <memory>
#include <type_traits>
#include <vector>

namespace Ovito::CrystalAnalysis {

/**
 * Search records keep stable addresses while the FIFO grows. A new search
 * reuses already constructed records; its caller must assign every field
 * before publishing the record and clear all external pointers before reset().
 * Keep a bounded number of pages between searches, without limiting a search.
 * This storage belongs to one findPrimarySegments() call, not the warm heap.
 */
template<class T, std::size_t PageSize = 1024, std::size_t RetainedBytes = 1024 * 1024>
class TracingScratch
{
    static_assert(PageSize > 0);
    static_assert(std::is_trivially_default_constructible_v<T>);
    static_assert(std::is_trivially_destructible_v<T>);

public:
    static constexpr std::size_t pageSize = PageSize;
    static constexpr std::size_t retainedPages = std::max(std::size_t{1}, RetainedBytes / (sizeof(T) * PageSize));

    struct Statistics {
        std::size_t pageAllocations = 0;
        std::size_t pageReuses = 0;
        std::size_t releasedPages = 0;
        std::size_t searches = 0;
        std::size_t peakRecords = 0;
        std::size_t peakBytes = 0;
        std::size_t peakRetainedBytes = 0;
    };

    explicit TracingScratch(bool collectStatistics = false) : _collectStatistics(collectStatistics) {}

    T* construct() {
        if(_next == _end) {
            if(_page == _pages.size()) {
                // Own the allocation before growing the pointer vector, so
                // either allocation can fail without leaking a record page.
                std::unique_ptr<T[]> page(new T[PageSize]);
                _pages.push_back(std::move(page));
                if(_collectStatistics) ++_statistics.pageAllocations;
            }
            else if(_collectStatistics) ++_statistics.pageReuses;
            _next = _pages[_page++].get();
            _end = _next + PageSize;
        }
        return _next++;
    }

    void reset() {
        if(_collectStatistics) {
            ++_statistics.searches;
            _statistics.peakRecords = std::max(_statistics.peakRecords, size());
            _statistics.peakBytes = std::max(_statistics.peakBytes, memoryUsage());
            _statistics.peakRetainedBytes = std::max(_statistics.peakRetainedBytes,
                std::min(_pages.size(), retainedPages) * PageSize * sizeof(T));
            if(_pages.size() > retainedPages) _statistics.releasedPages += _pages.size() - retainedPages;
        }
        if(_pages.size() > retainedPages) _pages.resize(retainedPages);
        _page = 0;
        _next = _end = nullptr;
    }

    // Diagnostics are read outside the inner traversal loop.
    std::size_t size() const {
        return _page ? (_page - 1) * PageSize + std::size_t(_next - _pages[_page - 1].get()) : 0;
    }
    std::size_t memoryUsage() const { return _pages.size() * PageSize * sizeof(T); }
    const Statistics& statistics() const { return _statistics; }

private:
    std::vector<std::unique_ptr<T[]>> _pages;
    T* _next = nullptr;
    T* _end = nullptr;
    std::size_t _page = 0;
    const bool _collectStatistics;
    Statistics _statistics;
};

} // namespace Ovito::CrystalAnalysis
