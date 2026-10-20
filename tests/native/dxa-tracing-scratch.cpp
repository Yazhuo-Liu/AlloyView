// Run with:
// c++ -std=c++17 -O2 tests/native/dxa-tracing-scratch.cpp -o /tmp/dxa-tracing-scratch
// /tmp/dxa-tracing-scratch
#include "../../third_party/dxa/geometry/TracingScratch.h"

#include <cassert>
#include <cstdlib>
#include <iostream>
#include <new>

namespace {
int allocationsUntilFailure = -1;
std::size_t liveAllocations = 0;
}

void* operator new(std::size_t bytes) {
    if(allocationsUntilFailure == 0) {
        allocationsUntilFailure = -1;
        throw std::bad_alloc();
    }
    if(allocationsUntilFailure > 0) --allocationsUntilFailure;
    if(void* pointer = std::malloc(bytes ? bytes : 1)) {
        ++liveAllocations;
        return pointer;
    }
    throw std::bad_alloc();
}
void* operator new[](std::size_t bytes) { return ::operator new(bytes); }
void operator delete(void* pointer) noexcept {
    if(pointer) {
        --liveAllocations;
        std::free(pointer);
    }
}
void operator delete[](void* pointer) noexcept { ::operator delete(pointer); }
void operator delete(void* pointer, std::size_t) noexcept { ::operator delete(pointer); }
void operator delete[](void* pointer, std::size_t) noexcept { ::operator delete(pointer); }

struct Record {
    std::size_t identity;
    Record* parent;
    Record* next;
};

using Scratch = Ovito::CrystalAnalysis::TracingScratch<Record, 4, 8 * sizeof(Record)>;

static void fill(Record* record, std::size_t identity, Record* parent) {
    record->identity = identity;
    record->parent = parent;
    record->next = nullptr;
    if(parent) parent->next = record;
}

int main() {
    static_assert(Scratch::retainedPages == 2);
    const std::size_t before = liveAllocations;
    {
        Scratch scratch(true);
        assert(scratch.size() == 0 && scratch.memoryUsage() == 0);
        Record* first = nullptr;
        for(unsigned pass = 0; pass < 100; ++pass) {
            Record* previous = nullptr;
            for(std::size_t i = 0; i < 8; ++i) {
                Record* record = scratch.construct();
                fill(record, i, previous);
                if(i == 0) {
                    if(first) assert(record == first);
                    first = record;
                }
                previous = record;
            }
            assert(scratch.size() == 8);
            assert(scratch.statistics().pageAllocations == 2);
            for(std::size_t i = 8; i-- > 0;) {
                assert(previous->identity == i);
                if(previous->parent) assert(previous->parent->next == previous);
                previous = previous->parent;
            }
            assert(previous == nullptr);
            scratch.reset();
            assert(scratch.size() == 0);
            assert(scratch.memoryUsage() == 8 * sizeof(Record));
        }

        // A large traversal is never truncated by the retained-memory cap.
        Record* previous = nullptr;
        for(std::size_t i = 0; i < 101; ++i) {
            Record* record = scratch.construct();
            fill(record, i, previous);
            previous = record;
        }
        assert(scratch.size() == 101 && scratch.statistics().pageAllocations == 26);
        Record* record = first;
        for(std::size_t i = 0; i < 101; ++i, record = record->next) assert(record->identity == i);
        assert(record == nullptr);
        scratch.reset();
        assert(scratch.memoryUsage() == 8 * sizeof(Record));
        assert(scratch.statistics().searches == 101);
        assert(scratch.statistics().peakRecords == 101);
        assert(scratch.statistics().peakBytes == 104 * sizeof(Record));
        assert(scratch.statistics().peakRetainedBytes == 8 * sizeof(Record));
        assert(scratch.statistics().releasedPages == 24);

        // Failure while acquiring another page does not disturb old pointers
        // or advance the cursor, and unwinding releases every owned page.
        for(std::size_t i = 0; i < 8; ++i) fill(scratch.construct(), i, nullptr);
        allocationsUntilFailure = 0;
        try {
            scratch.construct();
            assert(false);
        } catch(const std::bad_alloc&) {}
        assert(scratch.size() == 8 && scratch.statistics().pageAllocations == 26);
        assert(first->identity == 0);
        Record* recovered = scratch.construct();
        fill(recovered, 8, first);
        assert(scratch.size() == 9 && recovered->parent == first);
    }
    assert(liveAllocations == before);
    {
        Scratch scratch(true);
        // The record page succeeds but growing its ownership vector fails.
        allocationsUntilFailure = 1;
        try {
            scratch.construct();
            assert(false);
        } catch(const std::bad_alloc&) {}
        assert(scratch.size() == 0 && scratch.memoryUsage() == 0);
        assert(scratch.statistics().pageAllocations == 0);
        assert(liveAllocations == before);
        fill(scratch.construct(), 1, nullptr);
        assert(scratch.size() == 1 && scratch.statistics().pageAllocations == 1);
    }
    assert(liveAllocations == before);
    {
        Scratch scratch;
        for(std::size_t i = 0; i < 8; ++i) fill(scratch.construct(), i, nullptr);
        scratch.reset();
        assert(scratch.statistics().pageAllocations == 0 && scratch.statistics().searches == 0);
    }
    assert(liveAllocations == before);
    std::cout << "Scratch reuse, stable FIFO links, retention cap, allocation failure and destruction pass.\n";
}
