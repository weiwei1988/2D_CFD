#include <emscripten/emscripten.h>
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace {
constexpr float gamma_g = 1.4f;
constexpr float prandtl = 0.72f;

int nx = 0;
int ny = 0;
int cell_count = 0;
float mach_inf = 0.9f;
float reynolds = 50000.0f;
float cfl = 0.38f;
float min_cell_scale = 1.0e-4f;
double sim_time = 0.0;
int iteration = 0;
float residual = 0.0f;

std::vector<float> rho, mx, my, energy;
std::vector<float> next_rho, next_mx, next_my, next_energy;
std::vector<float> vorticity, mach_field, schlieren;
std::vector<float> cell_x, cell_y, cell_area, cell_scale;
std::vector<float> u_field, v_field, p_field, a_field;
std::vector<float> xi_nx, xi_ny, xi_len, eta_nx, eta_ny, eta_len;
std::vector<float> wall_nx, wall_ny, wall_len, wall_x, wall_y;

inline float clampf(float value, float lo, float hi) {
  return std::max(lo, std::min(hi, value));
}

inline int index_of(int i, int j) {
  i %= nx;
  if (i < 0) i += nx;
  return i + j * nx;
}

inline void primitive_at(int k, float& r, float& u, float& v, float& p, float& a) {
  r = std::max(rho[k], 0.12f);
  u = mx[k] / r;
  v = my[k] / r;
  p = std::max((gamma_g - 1.0f) * (energy[k] - 0.5f * r * (u * u + v * v)), 0.035f);
  a = std::sqrt(gamma_g * p / r);
}

inline void add_internal_face(int left, int right, float normal_x, float normal_y,
                              float length, float dt) {
  const float r_l = rho[left];
  const float r_r = rho[right];
  const float u_l = u_field[left];
  const float v_l = v_field[left];
  const float u_r = u_field[right];
  const float v_r = v_field[right];
  const float p_l = p_field[left];
  const float p_r = p_field[right];
  const float e_l = energy[left];
  const float e_r = energy[right];
  const float un_l = u_l * normal_x + v_l * normal_y;
  const float un_r = u_r * normal_x + v_r * normal_y;
  const float s_l = std::min(un_l - a_field[left], un_r - a_field[right]);
  const float s_r = std::max(un_l + a_field[left], un_r + a_field[right]);

  float f0, f1, f2, f3;
  if (s_l >= 0.0f) {
    f0 = r_l * un_l;
    f1 = mx[left] * un_l + p_l * normal_x;
    f2 = my[left] * un_l + p_l * normal_y;
    f3 = (e_l + p_l) * un_l;
  } else if (s_r <= 0.0f) {
    f0 = r_r * un_r;
    f1 = mx[right] * un_r + p_r * normal_x;
    f2 = my[right] * un_r + p_r * normal_y;
    f3 = (e_r + p_r) * un_r;
  } else {
    const float inv = 1.0f / std::max(s_r - s_l, 1.0e-9f);
    const float cross = s_l * s_r;
    f0 = (s_r * r_l * un_l - s_l * r_r * un_r + cross * (r_r - r_l)) * inv;
    f1 = (s_r * (mx[left] * un_l + p_l * normal_x) -
          s_l * (mx[right] * un_r + p_r * normal_x) + cross * (mx[right] - mx[left])) * inv;
    f2 = (s_r * (my[left] * un_l + p_l * normal_y) -
          s_l * (my[right] * un_r + p_r * normal_y) + cross * (my[right] - my[left])) * inv;
    f3 = (s_r * (e_l + p_l) * un_l - s_l * (e_r + p_r) * un_r +
          cross * (e_r - e_l)) * inv;
  }

  const float scale_l = dt * length / cell_area[left];
  const float scale_r = dt * length / cell_area[right];
  next_rho[left] -= scale_l * f0;
  next_mx[left] -= scale_l * f1;
  next_my[left] -= scale_l * f2;
  next_energy[left] -= scale_l * f3;
  next_rho[right] += scale_r * f0;
  next_mx[right] += scale_r * f1;
  next_my[right] += scale_r * f2;
  next_energy[right] += scale_r * f3;
}

inline void logical_gradient(const std::vector<float>& field, int i, int j,
                             float& gradient_x, float& gradient_y) {
  const int im = index_of(i - 1, j);
  const int ip = index_of(i + 1, j);
  const int jm = index_of(i, std::max(0, j - 1));
  const int jp = index_of(i, std::min(ny - 1, j + 1));
  const float d_eta = (j == 0 || j == ny - 1) ? 1.0f : 2.0f;
  const float f_xi = 0.5f * (field[ip] - field[im]);
  const float f_eta = (field[jp] - field[jm]) / d_eta;
  const float x_xi = 0.5f * (cell_x[ip] - cell_x[im]);
  const float x_eta = (cell_x[jp] - cell_x[jm]) / d_eta;
  const float y_xi = 0.5f * (cell_y[ip] - cell_y[im]);
  const float y_eta = (cell_y[jp] - cell_y[jm]) / d_eta;
  const float jacobian = x_xi * y_eta - x_eta * y_xi;
  if (std::abs(jacobian) < 1.0e-10f) {
    gradient_x = 0.0f;
    gradient_y = 0.0f;
    return;
  }
  gradient_x = (f_xi * y_eta - f_eta * y_xi) / jacobian;
  gradient_y = (-f_xi * x_eta + f_eta * x_xi) / jacobian;
}

void resize_cell_array(std::vector<float>& array) {
  array.assign(static_cast<std::size_t>(cell_count), 0.0f);
}
}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int cfd_create(int requested_nx, int requested_ny) {
  if (requested_nx < 16 || requested_ny < 8) return 0;
  nx = requested_nx;
  ny = requested_ny;
  cell_count = nx * ny;
  for (auto* array : {&rho, &mx, &my, &energy, &next_rho, &next_mx, &next_my,
                      &next_energy, &vorticity, &mach_field, &schlieren, &cell_x,
                      &cell_y, &cell_area, &cell_scale, &u_field, &v_field,
                      &p_field, &a_field, &xi_nx, &xi_ny, &xi_len, &eta_nx,
                      &eta_ny, &eta_len}) {
    resize_cell_array(*array);
  }
  wall_nx.assign(nx, 0.0f);
  wall_ny.assign(nx, 0.0f);
  wall_len.assign(nx, 0.0f);
  wall_x.assign(nx, 0.0f);
  wall_y.assign(nx, 0.0f);
  sim_time = 0.0;
  iteration = 0;
  residual = 0.0f;
  return 1;
}

EMSCRIPTEN_KEEPALIVE void cfd_reset(float requested_mach, float requested_reynolds,
                                    float requested_cfl, float requested_min_cell_scale) {
  mach_inf = requested_mach;
  reynolds = requested_reynolds;
  cfl = requested_cfl;
  min_cell_scale = requested_min_cell_scale;
  const float pressure = 1.0f / gamma_g;
  const float total_energy = pressure / (gamma_g - 1.0f) + 0.5f * mach_inf * mach_inf;
  for (int k = 0; k < cell_count; ++k) {
    rho[k] = 1.0f;
    mx[k] = mach_inf;
    my[k] = 0.0f;
    energy[k] = total_energy;
  }
  sim_time = 0.0;
  iteration = 0;
  residual = 0.0f;
}

EMSCRIPTEN_KEEPALIVE double cfd_step() {
  float wave = 1.0f;
  for (int k = 0; k < cell_count; ++k) {
    float r, u, v, p, a;
    primitive_at(k, r, u, v, p, a);
    u_field[k] = u;
    v_field[k] = v;
    p_field[k] = p;
    a_field[k] = a;
    wave = std::max(wave, std::hypot(u, v) + a);
  }
  const float dt = cfl * min_cell_scale / wave;
  std::copy(rho.begin(), rho.end(), next_rho.begin());
  std::copy(mx.begin(), mx.end(), next_mx.begin());
  std::copy(my.begin(), my.end(), next_my.begin());
  std::copy(energy.begin(), energy.end(), next_energy.begin());

  for (int j = 0; j < ny; ++j) {
    for (int i = 0; i < nx; ++i) {
      const int right = i + j * nx;
      const int left = (i ? i - 1 : nx - 1) + j * nx;
      add_internal_face(left, right, xi_nx[right], xi_ny[right], xi_len[right], dt);
    }
  }
  for (int j = 1; j < ny; ++j) {
    for (int i = 0; i < nx; ++i) {
      const int top = i + j * nx;
      const int bottom = top - nx;
      add_internal_face(bottom, top, eta_nx[top], eta_ny[top], eta_len[top], dt);
    }
  }
  for (int i = 0; i < nx; ++i) {
    const int k = i;
    const float scale = dt * wall_len[i] / cell_area[k];
    next_mx[k] -= scale * p_field[k] * wall_nx[i];
    next_my[k] -= scale * p_field[k] * wall_ny[i];
  }

  const float viscosity = std::max(mach_inf, 0.3f) / reynolds;
  for (int j = 0; j < ny - 2; ++j) {
    for (int i = 0; i < nx; ++i) {
      const int k = index_of(i, j);
      const int neighbours[4] = {index_of(i - 1, j), index_of(i + 1, j),
                                 index_of(i, std::max(0, j - 1)), index_of(i, j + 1)};
      const float u = u_field[k];
      const float v = v_field[k];
      const float temperature = p_field[k] / std::max(rho[k], 0.12f);
      float laplace_u = 0.0f;
      float laplace_v = 0.0f;
      float laplace_t = 0.0f;
      for (int neighbour : neighbours) {
        const float dx = cell_x[neighbour] - cell_x[k];
        const float dy = cell_y[neighbour] - cell_y[k];
        const float distance_squared = std::max(dx * dx + dy * dy, 1.0e-7f);
        const float weight = 0.5f / distance_squared;
        laplace_u += weight * (u_field[neighbour] - u);
        laplace_v += weight * (v_field[neighbour] - v);
        laplace_t += weight * (p_field[neighbour] / std::max(rho[neighbour], 0.12f) - temperature);
      }
      next_mx[k] += dt * viscosity * laplace_u;
      next_my[k] += dt * viscosity * laplace_v;
      next_energy[k] += dt * (viscosity / prandtl * laplace_t +
                              viscosity * (u * laplace_u + v * laplace_v));
    }
  }

  const float pressure_inf = 1.0f / gamma_g;
  const float energy_inf = pressure_inf / (gamma_g - 1.0f) + 0.5f * mach_inf * mach_inf;
  double total_change = 0.0;
  int active_cells = 0;
  for (int j = 0; j < ny; ++j) {
    for (int i = 0; i < nx; ++i) {
      const int k = index_of(i, j);
      if (j >= ny - 2) {
        next_rho[k] = 1.0f;
        next_mx[k] = mach_inf;
        next_my[k] = 0.0f;
        next_energy[k] = energy_inf;
      } else {
        next_rho[k] = clampf(next_rho[k], 0.15f, 4.0f);
        float u = next_mx[k] / next_rho[k];
        float v = next_my[k] / next_rho[k];
        const float speed = std::hypot(u, v);
        if (speed > 3.5f) {
          const float scale = 3.5f / speed;
          next_mx[k] *= scale;
          next_my[k] *= scale;
          u *= scale;
          v *= scale;
        }
        const float pressure = (gamma_g - 1.0f) *
            (next_energy[k] - 0.5f * next_rho[k] * (u * u + v * v));
        if (pressure < 0.035f) {
          next_energy[k] = 0.035f / (gamma_g - 1.0f) +
                           0.5f * next_rho[k] * (u * u + v * v);
        }
        total_change += std::abs(next_mx[k] - mx[k]) + std::abs(next_my[k] - my[k]);
        ++active_cells;
      }
    }
  }

  std::copy(next_rho.begin(), next_rho.end(), rho.begin());
  std::copy(next_mx.begin(), next_mx.end(), mx.begin());
  std::copy(next_my.begin(), next_my.end(), my.begin());
  std::copy(next_energy.begin(), next_energy.end(), energy.begin());
  sim_time += dt;
  ++iteration;
  residual = static_cast<float>(total_change / std::max(active_cells, 1));
  return dt;
}

EMSCRIPTEN_KEEPALIVE void cfd_update_derived() {
  for (int k = 0; k < cell_count; ++k) {
    float r, u, v, p, a;
    primitive_at(k, r, u, v, p, a);
    u_field[k] = u;
    v_field[k] = v;
    mach_field[k] = std::hypot(u, v) / a;
  }
  for (int j = 0; j < ny; ++j) {
    for (int i = 0; i < nx; ++i) {
      const int k = index_of(i, j);
      float du_dx, du_dy, dv_dx, dv_dy, dr_dx, dr_dy;
      logical_gradient(u_field, i, j, du_dx, du_dy);
      logical_gradient(v_field, i, j, dv_dx, dv_dy);
      logical_gradient(rho, i, j, dr_dx, dr_dy);
      vorticity[k] = dv_dx - du_dy;
      schlieren[k] = std::log1p(6.0f * std::hypot(dr_dx, dr_dy));
    }
  }
}

EMSCRIPTEN_KEEPALIVE double cfd_time() { return sim_time; }
EMSCRIPTEN_KEEPALIVE int cfd_iteration() { return iteration; }
EMSCRIPTEN_KEEPALIVE float cfd_residual() { return residual; }

#define POINTER_EXPORT(function_name, vector_name) \
  EMSCRIPTEN_KEEPALIVE float* function_name() { return vector_name.data(); }

POINTER_EXPORT(cfd_ptr_rho, rho)
POINTER_EXPORT(cfd_ptr_mx, mx)
POINTER_EXPORT(cfd_ptr_my, my)
POINTER_EXPORT(cfd_ptr_E, energy)
POINTER_EXPORT(cfd_ptr_nr, next_rho)
POINTER_EXPORT(cfd_ptr_nmx, next_mx)
POINTER_EXPORT(cfd_ptr_nmy, next_my)
POINTER_EXPORT(cfd_ptr_nE, next_energy)
POINTER_EXPORT(cfd_ptr_vorticity, vorticity)
POINTER_EXPORT(cfd_ptr_machField, mach_field)
POINTER_EXPORT(cfd_ptr_schlieren, schlieren)
POINTER_EXPORT(cfd_ptr_cellX, cell_x)
POINTER_EXPORT(cfd_ptr_cellY, cell_y)
POINTER_EXPORT(cfd_ptr_cellArea, cell_area)
POINTER_EXPORT(cfd_ptr_cellScale, cell_scale)
POINTER_EXPORT(cfd_ptr_uField, u_field)
POINTER_EXPORT(cfd_ptr_vField, v_field)
POINTER_EXPORT(cfd_ptr_pField, p_field)
POINTER_EXPORT(cfd_ptr_aField, a_field)
POINTER_EXPORT(cfd_ptr_xiNx, xi_nx)
POINTER_EXPORT(cfd_ptr_xiNy, xi_ny)
POINTER_EXPORT(cfd_ptr_xiLen, xi_len)
POINTER_EXPORT(cfd_ptr_etaNx, eta_nx)
POINTER_EXPORT(cfd_ptr_etaNy, eta_ny)
POINTER_EXPORT(cfd_ptr_etaLen, eta_len)
POINTER_EXPORT(cfd_ptr_wallNx, wall_nx)
POINTER_EXPORT(cfd_ptr_wallNy, wall_ny)
POINTER_EXPORT(cfd_ptr_wallLen, wall_len)
POINTER_EXPORT(cfd_ptr_wallX, wall_x)
POINTER_EXPORT(cfd_ptr_wallY, wall_y)

#undef POINTER_EXPORT
}  // extern "C"
