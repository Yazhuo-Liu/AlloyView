# GitHub Pages deployment

`npm run build` creates `dist/`; no server-side code or upload endpoint exists.
The production artifact contains only the browser application, examples, root
license, and an optional prebuilt Wasm module. Tests, benchmarks, documentation,
and native C++ sources are not copied into the web root.

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

The verified default uses a normal JavaScript Worker; the optional Wasm build
also uses non-shared memory. Cross-origin isolation is therefore not mandatory.
`npm run dev` and `npm run preview` nevertheless send:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

These headers become mandatory if Emscripten pthreads/`SharedArrayBuffer` are
enabled later. Every embedded resource must then satisfy COEP (same-origin or an
appropriate CORP/CORS response). AlloyView intentionally has no CDN resources,
which keeps that deployment tractable.

GitHub Pages does not allow custom response headers. That is compatible with the
current single-Worker build, which does not use `SharedArrayBuffer`. If Wasm
pthreads are introduced later, deploy behind a host that can provide the COOP
and COEP headers above (or add an isolation service worker after validating its
tradeoffs); do not enable threaded Wasm in the current Pages workflow.
