# GitHub Pages deployment

`npm run build` creates `dist/`; no server-side code or upload endpoint exists.
The production artifact contains only the browser application, examples, root
license, and an optional prebuilt Wasm module. Tests, benchmarks, documentation,
and native C++ sources are not copied into the web root.

The single **Open local** action uses a read-only `webkitdirectory` file input.
The browser returns the selected directory as a complete `FileList`, including
relative paths, and AlloyView presents that list in its own file/sequence chooser.
Folder access is requested by an explicit user action and no selected file is
uploaded. This also avoids browser-specific `showDirectoryPicker()` behavior that
can expose only part of a provider-backed folder.

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

All runtime paths are document-relative, so a project site at
`https://<owner>.github.io/<repository>/` works without rewriting URLs. The two
built-in examples are fetched from the same Pages origin. User-selected files
are read with the browser `File` API and are not uploaded.

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
