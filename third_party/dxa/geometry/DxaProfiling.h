// Optional, bounded diagnostics for AlloyView's retained DXA session.
// The scientific output and normal execution do not depend on these values.
#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <cstring>

namespace Ovito::DxaProfiling {

struct Value {
    const char* name = nullptr; // Callers pass string literals, never temporary text.
    double value = 0;
};

struct Profile {
    bool enabled = false;
    bool overflow = false;
    std::array<Value, 2048> timings{};
    std::array<Value, 4096> counters{};
    std::size_t timingCount = 0, counterCount = 0;

    template<std::size_t Capacity>
    Value* find(std::array<Value, Capacity>& values, std::size_t& count, const char* name) {
        for(std::size_t index = 0; index < count; ++index)
            if(std::strcmp(values[index].name, name) == 0) return &values[index];
        if(count == values.size()) { overflow = true; return nullptr; }
        values[count].name = name;
        return &values[count++];
    }
};

// Shared geometry can also serve Surface analyses. Attach a profile only for
// a DXA entry call, and never inherit it in a pthread's independent work.
inline thread_local Profile* active = nullptr;

class Attach {
public:
    explicit Attach(Profile& profile) : _previous(active) {
        active = profile.enabled ? &profile : nullptr;
    }
    ~Attach() { active = _previous; }
    Attach(const Attach&) = delete;
    Attach& operator=(const Attach&) = delete;
private:
    Profile* _previous;
};

inline bool enabled() { return active != nullptr; }

class Scope {
public:
    explicit Scope(const char* name) : _profile(active), _name(name) {
        if(_profile) _start = Clock::now();
    }
    ~Scope() { stop(); }
    void stop() {
        if(!_profile) return;
        const double elapsed = std::chrono::duration<double, std::milli>(Clock::now() - _start).count();
        if(auto* value = _profile->find(_profile->timings, _profile->timingCount, _name)) value->value += elapsed;
        _profile = nullptr;
    }
    Scope(const Scope&) = delete;
    Scope& operator=(const Scope&) = delete;
private:
    using Clock = std::chrono::steady_clock;
    Profile* _profile;
    const char* _name;
    Clock::time_point _start;
};

inline void add(const char* name, double amount) {
    if(active)
        if(auto* value = active->find(active->counters, active->counterCount, name)) value->value += amount;
}
// Aggregate elapsed time collected in private workers after they have joined.
// Such values are summed worker time, not a coordinator wall-clock interval.
inline void addTiming(const char* name, double milliseconds) {
    if(active)
        if(auto* value = active->find(active->timings, active->timingCount, name))
            value->value += milliseconds;
}
inline void set(const char* name, double amount) {
    if(active)
        if(auto* value = active->find(active->counters, active->counterCount, name)) value->value = amount;
}
inline void maximum(const char* name, double amount) {
    if(active)
        if(auto* value = active->find(active->counters, active->counterCount, name))
            if(amount > value->value) value->value = amount;
}

} // namespace Ovito::DxaProfiling
