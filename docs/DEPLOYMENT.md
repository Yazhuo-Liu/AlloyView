# GitHub Pages deployment

`npm run build` creates `dist/`; no server-side code or upload endpoint exists.
The production artifact contains only the browser application, examples, root
license, and an optional prebuilt Wasm module. Tests, benchmarks, documentation,
and native C++ sources are not copied into the web root.

**Open local** offers a file picker and a read-only `webkitdirectory` folder
picker. Individual files and multi-file selections load directly when they
form one source. A folder selection returns a complete `FileList` with relative
paths, which AlloyView presents in its file/sequence chooser. No selected file
is uploaded.

## GitHub Actions

`.github/workflows/deploy-pages.yml` deploys on every push to `main` and can
also be run manually. The workflow:

1. checks out the repository and selects Node.js 24;
2. runs the test suite;
3. creates `dist/` with `npm run build`;
4. uploads the Pages artifact;
5. deploys it to the protected `github-pages` environment.

In the repository on GitHub, select **Settings → Pages → Build and deployment →
Source → GitHub Actions**. No branch containing generated files, personal access
token, deployment secret, or custom base-path setting is required.

All runtime paths are relative, so a project site at
`https://<owner>.github.io/<repository>/` works without rewriting URLs. The two
built-in files and the NEB sequence are fetched from the same Pages origin. User-selected files
are read with the browser `File` API and are not uploaded.

The build computes a content hash and places the complete runtime tree under
`assets/<hash>/`. The HTML references this tree, so JavaScript imports, Workers,
examples, styles and logos all use one build version. A change to a Worker also
changes the URL of its client. This prevents independently cached modules from
mixing incompatible file-loading message formats after a deployment. The
current loader also accepts the earlier single-file message format.
Unversioned entrypoints remain available for an older cached HTML document
during the transition; newly generated HTML always uses the versioned tree.

## Other static hosts

Serve the contents of `dist/` with correct MIME types, especially
`application/wasm` when the optional native core has been built.

The verified default uses JavaScript module Workers; the optional Wasm build
also uses non-shared memory and is not currently selected by the range-partitioned
analysis pool. Cross-origin isolation is therefore not mandatory.
`npm run dev` and `npm run preview` nevertheless send:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

These headers allow the JavaScript coordination Worker pool to share one
coordinate buffer and would become mandatory for a future Emscripten pthreads
build. Every embedded resource must satisfy COEP (same-origin or an appropriate
CORP/CORS response). AlloyView intentionally has no CDN resources, which keeps
that deployment tractable.

GitHub Pages does not allow custom response headers. That is compatible with the
current Worker pool: it uses memory-budgeted structured-clone coordinate copies
inside the user's browser when `crossOriginIsolated` is false. GitHub still only
serves static files and never performs the calculation or receives the selected
structure. If Wasm pthreads are introduced later,
deploy behind a host that can provide the COOP and COEP headers above (or add an
isolation service worker after validating its tradeoffs); do not enable threaded
Wasm in the current Pages workflow.
