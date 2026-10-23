# Repository architecture

AlloyView is a static browser application built from JavaScript ES modules.
`index.html` loads `src/app.js`, which connects source loading, analysis,
rendering and the user interface. The source layout groups modules by their
responsibility. The directory reorganization moves existing modules and updates
their references; it does not split their business logic or change the Worker
and GPU warmup lifecycle.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `index.html`, `styles.css` | Viewer markup and shared page styles. |
| `src/` | Browser application modules, Worker entrypoints and runtime assets. |
| `tests/` | Node tests; `tests/helpers/` supplies fixtures, reference implementations and Node Worker adapters. |
| `scripts/` | Development server, static build, documentation generation, browser checks and benchmarks. |
| `docs/` | User and developer guides, feature pages, validation evidence and one active backlog. |
| `examples/` | Structures and trajectories bundled with the viewer; the build generates their catalog. |
| `wasm/` | Native interface sources and Emscripten build scripts; optional coordination build output also lives here. |
| `third_party/` | Sources and provenance for the native analysis implementations. |
| `licenses/` | Third-party license notices distributed with the site. |
| `.github/workflows/` | GitHub Actions build and deployment automation. |
| `dist/` | Generated deployable site, including generated documentation and versioned runtime assets. Do not edit it directly. |

`package.json` defines the development commands, and `package-lock.json` pins
their dependencies. `_headers` supplies the supported static-host header
policy. `node_modules/` and `dist/` are local generated directories.

## Source layout

```text
src/
├── app.js                  Application entry and integration
├── application/            Configuration, restoration and cross-feature coordination
├── analysis/               Numerical analysis, CPU scheduling and analysis clients
│   └── gpu/                WebGPU runtime, shaders, kernels and GPU Worker
├── assets/
│   └── logo/               Runtime logo and favicon files
├── data/                   Frames, trajectories, caches and persistent data state
├── io/                     File parsing, import/export formats and their clients
├── properties/             Expressions, computed properties and global attributes
├── render/                 Rendering, geometry, camera state and display models
├── shared/                 Small cross-domain runtime helpers
├── ui/
│   ├── analysis/           Analysis tool controllers
│   ├── automation/         Keyboard commands and script controls
│   ├── export/             Image, statistics and movie export controls
│   ├── properties/         Imported/computed property and time-series controls
│   ├── selection/          Selection group and trajectory tool controls
│   ├── shell/              Theme, tool navigation, help and window layout
│   ├── styles/             Styles shared by multiple UI areas
│   └── view/               Camera, slicing, labels and comparison-view controls
├── video/                  Movie settings, encoding and container writers
└── workers/                Worker entrypoints and Worker-side processing
```

The main distinctions are:

- `application/` coordinates application behavior. Configuration serialization
  and restoration, the command-script language, and analysis dependency
  resolution belong here. `app.js` remains the composition entry.
- `analysis/` owns scientific calculations and their execution machinery.
  Measurements, grain and binning clients, selection expansion and CPU pools
  live beside the algorithms they use. GPU-specific implementations remain
  under `analysis/gpu/`.
- `data/` owns frame and trajectory lifetimes, shared reads, replication,
  selection-group state and time-series storage. The structure-loading client
  is `data/structure-worker-client.js`. CPU and GPU prefetch schedulers remain
  `data/cpu-prefetch.js` and `data/gpu-prefetch.js`.
- `io/` parses and formats data. External-property and statistics-export Worker
  clients live here, together with format definitions and archive generation.
- `properties/` evaluates expressions and exposes per-atom computed properties
  and frame-level attribute registries. UI controls for these capabilities
  live separately under `ui/properties/`.
- `render/` owns WebGL rendering and display-specific models such as appearance,
  vectors, text labels, camera paths and slicing geometry. Its charts display
  analysis results without owning the numerical analysis.
- `ui/` binds controls and events to these capabilities. Analysis controllers
  are in `ui/analysis/`; the tool registry and navigation are in `ui/shell/`.
  Existing controllers with several related responsibilities, such as the
  comparison-view tools, remain intact.
- `video/` owns movie output settings, frame encoding, byte sinks and MP4/WebM
  muxers. Movie UI controls remain in `ui/export/`; camera interpolation
  remains in `render/camera-path.js`.

## Where to add a module

Choose a directory by the module's responsibility rather than its current
caller. For example, a new analysis gets its calculation in `analysis/`, its
Worker protocol in `workers/` if needed, and its settings controller in
`ui/analysis/`. A new file format belongs in `io/`, while a reusable expression
operation belongs in `properties/`.

Keep state and calculations usable without constructing the page. Put DOM
binding, dialogs and input handling in the appropriate `ui/` area. Worker
clients belong to the capability they serve, rather than a generic UI or
clients folder. Use `shared/` only for small helpers needed across unrelated
areas, such as yielding to the event loop.

Place a controller's stylesheet beside it when that controller owns the
styles. Styles shared by script and movie controls live in
`ui/styles/script-movie.css`. Keep root-level `styles.css` for the shared page
layout. Add runtime images under `src/assets/`; the former `src/asserts/` path
has been corrected to `src/assets/`.

Use explicit relative ES module imports with file extensions. Avoid adding
forwarding modules merely to preserve the former flat source layout. When
moving a module, update its consumers in source, tests, browser probes,
build scripts and current implementation documentation.

## Entrypoints and runtime paths

`src/app.js` stays at a stable location. `scripts/lib/bundle-runtime.mjs` builds
the page entry, `src/workers/*-worker.js`, and
`src/analysis/gpu/worker.js`. Worker helpers that are not entrypoints stay in
the Worker subtree without becoming independent bundles. Production module
facades expose the bundled page's existing module identities to integration
checks.

Construct Worker and module-owned asset URLs relative to `import.meta.url`.
For example, `data/structure-worker-client.js` resolves its structure Worker
with `new URL('../workers/structure-worker.js', import.meta.url)`. The bundler
preserves each module's original URL base, so these references also work after
bundling. A relative path must still be updated when its source module moves.
Document-relative URLs, such as links to feature documentation, have a different
base and should not be rewritten as module-relative assets.

Keep the generated PTM, Voronoi and DXA `.mjs` loaders beside their `.wasm`
files in `src/analysis/`. Emscripten owns native and pthread loading; these
generated files are not ordinary modules to relocate or hand-edit. The optional
coordination loader and binary are generated under `wasm/`. Rebuild native
artifacts through the corresponding `build:wasm`, `build:ptm`,
`build:voronoi`, `build:dxa` or `build:dxa:threaded` npm command when native
sources change.

The site build places scripts, Workers and assets together under
`dist/assets/<build-id>/` and publishes static documentation in `dist/docs/`.
Do not hard-code a build ID or a host-root `/src/` path. Browser checks should
derive runtime module URLs from the page's module script so they exercise the
same build as the viewer, including deployments under `/AlloyView/`.

Directory changes must retain persistent Worker pools, Wasm initialization,
GPU preparation and prefetch scheduling. Changing import paths does not require
recreating these resources or delaying their existing warmup calls. See
[analysis implementation](STRUCTURE_ANALYSIS.md) and
[deployment](DEPLOYMENT.md) for their lifecycle and hosting details.

## Development and verification

Node.js 20 or newer supports the development build and Node tests. Browser
automation uses Node.js 22 or newer with its built-in WebSocket API and an
installed Chrome/Chromium browser; set `CHROME_PATH` if it is not discovered
automatically.

```bash
npm ci
npm run dev
```

Open `http://localhost:5173`. For a production build and preview:

```bash
npm run build
npm run preview
```

Open `http://localhost:4173`. Run the Node suite and production browser checks
after changing paths:

```bash
npm test
npm run build
npm run test:browser
npm run test:browser:bundled-runtime
npm run test:browser:cpu-warmup
npm run test:browser:gpu-recovery
```

The browser scripts start their own local test servers. The bundled-runtime
check covers production entrypoints and resource loading; the warmup and GPU
recovery checks exercise persistent compute resources. Other focused browser
checks and benchmarks are listed in `package.json`. These commands describe
the verification workflow; executed results are recorded separately in
[validation](VALIDATION.md) and dated reports.

## Development scripts

| Directory | Contents |
| --- | --- |
| `scripts/` | Stable build, documentation, server and CI entrypoints. |
| `scripts/browser/` | Browser regression suites and feature-specific smoke helpers. |
| `scripts/benchmarks/` | CPU, browser and GPU performance comparisons. |
| `scripts/lib/` | Shared browser harness, fixtures, build and comparison helpers. |
| `scripts/research/` | Optional external scientific reference tools. |

Keep existing npm command names stable when moving implementations. New checks
belong beside the relevant scripts; reusable support belongs in `lib/`. For
command examples, prerequisites and path conventions see the
[script guide](https://github.com/Yazhuo-Liu/AlloyView/blob/main/scripts/README.md).

## Documentation maintenance

[TODO](TODO.md) is the only review/performance backlog. Keep actionable unfinished
work there, with current code evidence and acceptance criteria; explicitly mark
hardware-dependent checks and deferred decisions. Remove completed entries.
Feature guides describe current behavior, [DXA](DXA.md) preserves its scientific
validation contract, and [Validation](VALIDATION.md) retains executed evidence.
Historical reviews and superseded reports remain in Git history.

Register maintained guide pages in `DOC_GUIDES` in `scripts/build-docs.mjs` and
link them from [the documentation index](INDEX.md). Feature pages are connected
to the contextual help registry in `ui/shell/feature-help.js`. Benchmark records
retain their original revisions, commands and hardware; do not rewrite those
records to imply that old measurements ran against the current checkout.
