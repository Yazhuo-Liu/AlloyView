# AlloyView

AlloyView is a browser-only atomistic structure viewer and analysis prototype for
metals and alloys. Local AtomEye CFG and LAMMPS text dump files are parsed in a
Web Worker, rendered with WebGL 2 sphere impostors, and never uploaded by the
application.

The current milestone closes the first useful loop:

1. open a local CFG or LAMMPS dump;
2. render atoms and the simulation cell on the GPU;
3. calculate periodic coordination numbers off the UI thread;
4. color, slice, inspect, change trajectory frames, and export an opaque or
   transparent PNG.

## Run locally

Development requires Node.js 20 or newer. End users only need a WebGL 2 capable
browser.

```bash
npm run dev
```

Open <http://localhost:5173>. The development server sends COOP/COEP headers so
that a future threaded Wasm build can use shared memory. The current release uses
one Worker and does not require `SharedArrayBuffer`.

Build and preview the static site:

```bash
npm run build
npm run preview
```

The deployable files are in `dist/`. Any static server can host them. No backend
API is used. A deployment only needs COOP/COEP headers if a future pthreads Wasm
build is enabled; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Deploy to GitHub Pages

The repository includes `.github/workflows/deploy-pages.yml`. Every push to
`main` runs the tests, builds the static site, uploads `dist/`, and deploys it
with the official GitHub Pages Actions. Relative asset URLs make the same build
work at both a user site and a repository subpath such as `/AlloyView/`.

In the GitHub repository, open **Settings → Pages** and set **Source** to
**GitHub Actions** once. Push to `main`, or start **Deploy AlloyView to GitHub
Pages** manually from the Actions tab. No repository secret is required.
After the first successful deployment, the project site is expected at
<https://yazhuo-liu.github.io/AlloyView/>.

## Tests and benchmark

```bash
npm test
npm run benchmark
```

The test suite checks CFG and orthogonal/restricted-triclinic LAMMPS parsing,
coordinate conversion, malformed-input errors, PBC neighbors, FCC/BCC
coordination, and bounded LRU caching. The benchmark separates text generation,
parsing, and coordination analysis. Browser GPU upload/FPS/memory are measured in
the in-app performance panel on the target workstation; the automated test
session does not provide a browser graphics context.

## Supported scope

- AtomEye CFG: basic and extended CFG, `H0`, `A`, `Transform`, `eta`, optional
  velocities, and scalar `auxiliary[]` columns. LAMMPS-written CFG auxiliaries
  `id` and complete `ix/iy/iz` image flags are recognized for stable atom IDs
  and unwrapped display. A non-identity `Transform`
  combined with non-zero `eta` is rejected because upstream AtomEye gives those
  fields ambiguous precedence.
- LAMMPS text dump: `id`, numeric `type`, common scalar columns, `x/y/z`,
  `xu/yu/zu`, `xs/ys/zs`, or `xsu/ysu/zsu`; orthogonal and restricted triclinic
  `xy/xz/yz` boxes; per-axis boundary flags; and optional `ix/iy/iz` image flags
  for unwrapped display. General triclinic `abc origin`, compressed/binary dumps,
  partial image flags, and non-numeric custom columns (except `element`) are
  rejected explicitly.
- Trajectories: byte offsets are indexed incrementally from the local `File`;
  requested frames are sliced and parsed on demand. The UI keeps at most three
  parsed frames.
- Rendering: one instanced quad per atom with an analytic sphere/depth shader,
  optional wrapped/unwrapped trajectory coordinates, and an optional cell
  wireframe. The camera uses a Z-up constrained orbit, six orthographic standard
  views, and a live Cartesian axis tripod. There is no per-atom mesh or draw call.
- Analysis: cutoff-based coordination number using fractional-space linked cells,
  cell face heights, per-axis periodic bin wrapping, and a triclinic-safe image
  search. A recognized metal composition initializes an editable radius-based
  cutoff suggestion; unknown types fall back to 3.00 Å. Scalar color legends
  have editable ranges. Display unwrapping never changes the coordinates used
  for analysis.

More detail is in [docs/FORMATS.md](docs/FORMATS.md) and actual executed results
are in [docs/VALIDATION.md](docs/VALIDATION.md).

## AtomEye relationship and licensing

The upstream review is pinned to
`jameskermode/AtomEye@c418eb2553f6793460d4a956236fc698c39fbe74` in
[docs/ATOMEYE_REVIEW.md](docs/ATOMEYE_REVIEW.md). AtomEye's CFG conventions,
fractional-coordinate data model, and linked-cell neighbor-list design informed
the interfaces and tests here.

No AtomEye C source or asset is copied into this MIT-licensed repository. The
reviewed upstream snapshot has no repository-wide license file; its Python
bridge alone contains an explicit GPLv2 notice. Until the copyright holders
clarify terms, shipping modified upstream C/Wasm would be legally ambiguous.
The source evidence and reuse boundary are recorded in the review document.
This is a provenance and risk statement, not legal advice.

## Known limits and next steps

- WebGL 2 is required; WebGPU and fallback Canvas rendering are not implemented.
- The parser currently indexes a dump in one Worker and does not stream partial
  atom rows into the renderer.
- Very large text frames still require memory for the frame slice, parsed arrays,
  the main-thread copy, and GPU buffers. One million atoms is an exploration
  target, not a performance claim.
- Coordination has one global cutoff, not a species-pair matrix.
- Bonds, DXA, PTM, CNA, defect lines, and periodic image replication are future
  modules.
- `wasm/` defines the intended native ABI, but the verified default build uses
  the JavaScript Worker implementation because Emscripten is not installed in
  the validation environment.

Recommended next work is to benchmark real 100k/1M trajectories on target GPUs,
then compile the isolated coordination ABI with Emscripten and compare it against
the existing reference tests before considering Wasm threads.
