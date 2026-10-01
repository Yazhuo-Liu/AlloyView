// SPDX-License-Identifier: MIT
// Independent browser ABI for AlloyView. No AtomEye source is copied here.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <vector>

namespace {

double determinant(const double* h) {
  return h[0] * (h[4] * h[8] - h[5] * h[7])
       - h[1] * (h[3] * h[8] - h[5] * h[6])
       + h[2] * (h[3] * h[7] - h[4] * h[6]);
}

double cross_length(const double* left, const double* right) {
  const double x = left[1] * right[2] - left[2] * right[1];
  const double y = left[2] * right[0] - left[0] * right[2];
  const double z = left[0] * right[1] - left[1] * right[0];
  return std::sqrt(x * x + y * y + z * z);
}

int flatten(int x, int y, int z, const int* dimensions) {
  return (x * dimensions[1] + y) * dimensions[2] + z;
}

int neighbor_index(int value, int count, bool periodic) {
  if (!periodic) return value >= 0 && value < count ? value : -1;
  value %= count;
  return value < 0 ? value + count : value;
}

bool inside_cutoff(const float* fractional, int first, int second,
                   const double* h, const uint8_t* pbc,
                   const double* fractional_bounds, double cutoff_squared) {
  double difference[3];
  int minimum[3];
  int maximum[3];
  for (int dimension = 0; dimension < 3; ++dimension) {
    difference[dimension] = static_cast<double>(fractional[3 * second + dimension])
                          - static_cast<double>(fractional[3 * first + dimension]);
    if (pbc[dimension]) {
      minimum[dimension] = static_cast<int>(std::ceil(difference[dimension] - fractional_bounds[dimension]));
      maximum[dimension] = static_cast<int>(std::floor(difference[dimension] + fractional_bounds[dimension]));
      if (minimum[dimension] > maximum[dimension]) return false;
    } else {
      if (std::abs(difference[dimension]) > fractional_bounds[dimension]) return false;
      minimum[dimension] = maximum[dimension] = 0;
    }
  }

  for (int image_a = minimum[0]; image_a <= maximum[0]; ++image_a) {
    const double a = difference[0] - image_a;
    for (int image_b = minimum[1]; image_b <= maximum[1]; ++image_b) {
      const double b = difference[1] - image_b;
      for (int image_c = minimum[2]; image_c <= maximum[2]; ++image_c) {
        const double c = difference[2] - image_c;
        const double x = a * h[0] + b * h[3] + c * h[6];
        const double y = a * h[1] + b * h[4] + c * h[7];
        const double z = a * h[2] + b * h[5] + c * h[8];
        if (x * x + y * y + z * z <= cutoff_squared) return true;
      }
    }
  }
  return false;
}

}  // namespace

extern "C" {

// Returns 0 on success, -1 for invalid input, and -2 for a singular cell.
// Cell vectors are three row vectors, matching AtomEye CFG's x = s * H.
int alloy_coordination(int atom_count, const float* fractional, const double* h,
                       const uint8_t* pbc, double cutoff, uint32_t* output) {
  if (atom_count <= 0 || !fractional || !h || !pbc || !output
      || !std::isfinite(cutoff) || cutoff <= 0.0) return -1;

  const double volume = std::abs(determinant(h));
  if (!(volume > 1e-12)) return -2;
  const double heights[3] = {
    volume / cross_length(h + 3, h + 6),
    volume / cross_length(h + 6, h),
    volume / cross_length(h, h + 3),
  };
  int dimensions[3];
  for (int dimension = 0; dimension < 3; ++dimension) {
    dimensions[dimension] = std::max(1, std::min(256, static_cast<int>(std::floor(heights[dimension] / cutoff))));
  }
  const int target_bins = std::max(1, std::min(2000000, atom_count * 4));
  while (static_cast<int64_t>(dimensions[0]) * dimensions[1] * dimensions[2] > target_bins) {
    int largest = dimensions[1] > dimensions[0] ? 1 : 0;
    if (dimensions[2] > dimensions[largest]) largest = 2;
    dimensions[largest] = std::max(1, dimensions[largest] / 2);
  }
  const int total_bins = dimensions[0] * dimensions[1] * dimensions[2];
  std::vector<int> heads(total_bins, -1);
  std::vector<int> next(atom_count, -1);
  std::vector<int> atom_bins(atom_count, 0);
  std::fill(output, output + atom_count, 0u);

  for (int atom = 0; atom < atom_count; ++atom) {
    int indices[3];
    for (int dimension = 0; dimension < 3; ++dimension) {
      double value = fractional[3 * atom + dimension];
      if (!std::isfinite(value)) return -1;
      if (pbc[dimension]) value -= std::floor(value);
      else value = std::max(0.0, std::min(std::nextafter(1.0, 0.0), value));
      indices[dimension] = std::min(dimensions[dimension] - 1,
        static_cast<int>(std::floor(value * dimensions[dimension])));
    }
    const int bin = flatten(indices[0], indices[1], indices[2], dimensions);
    atom_bins[atom] = bin;
    next[atom] = heads[bin];
    heads[bin] = atom;
  }

  const double fractional_bounds[3] = {
    cutoff / heights[0] + 1e-12,
    cutoff / heights[1] + 1e-12,
    cutoff / heights[2] + 1e-12,
  };
  const double cutoff_squared = cutoff * cutoff;
  for (int atom = 0; atom < atom_count; ++atom) {
    const int bin = atom_bins[atom];
    const int bin_x = bin / (dimensions[1] * dimensions[2]);
    const int remainder = bin - bin_x * dimensions[1] * dimensions[2];
    const int bin_y = remainder / dimensions[2];
    const int bin_z = remainder % dimensions[2];
    int neighbor_bins[27];
    int neighbor_count = 0;
    for (int dx = -1; dx <= 1; ++dx) {
      const int x = neighbor_index(bin_x + dx, dimensions[0], pbc[0]);
      if (x < 0) continue;
      for (int dy = -1; dy <= 1; ++dy) {
        const int y = neighbor_index(bin_y + dy, dimensions[1], pbc[1]);
        if (y < 0) continue;
        for (int dz = -1; dz <= 1; ++dz) {
          const int z = neighbor_index(bin_z + dz, dimensions[2], pbc[2]);
          if (z < 0) continue;
          const int candidate = flatten(x, y, z, dimensions);
          bool duplicate = false;
          for (int seen = 0; seen < neighbor_count; ++seen) {
            if (neighbor_bins[seen] == candidate) { duplicate = true; break; }
          }
          if (!duplicate) neighbor_bins[neighbor_count++] = candidate;
        }
      }
    }
    for (int neighbor_bin = 0; neighbor_bin < neighbor_count; ++neighbor_bin) {
      for (int other = heads[neighbor_bins[neighbor_bin]]; other >= 0; other = next[other]) {
        if (other <= atom) continue;
        if (inside_cutoff(fractional, atom, other, h, pbc, fractional_bounds, cutoff_squared)) {
          ++output[atom];
          ++output[other];
        }
      }
    }
  }
  return 0;
}

}  // extern "C"
