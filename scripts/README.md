# Development scripts

Run commands from the repository root. The `npm run` command names are the stable
entry points; use `npm run` to list them. Browser checks need Node 22+ with built-in
`WebSocket` and Chrome/Chromium; set `CHROME_PATH` when it is not in a standard
location.

| Location | Purpose |
| --- | --- |
| `build.mjs`, `build-docs.mjs` | Static application build and documentation rendering. |
| `serve.mjs` | Development and production-preview server. |
| `ci-test-summary.mjs` | Format the Node test log for the CI job summary. |
| `browser/` | Browser regression checks, plus their feature-specific smoke-test helpers. |
| `benchmarks/` | CPU/browser/GPU timings and before/after performance comparisons. |
| `lib/` | Shared browser harness, build helpers, GPU fixtures and scientific comparison utilities. |
| `research/` | Optional OVITO reference exporters and comparison tools; outside normal app/CI execution. |

## Common commands

```sh
npm ci
npm run dev
npm test
npm run build
npm run preview
npm run test:browser
npm run test:browser:bundled-runtime
npm run test:gpu -- --software
npm run benchmark
```

Build before checks that read `dist/`, including the main browser smoke check and
commands with `--production`. For one feature, use its existing npm command (for
example, `npm run test:browser:grains` or `npm run benchmark:voronoi:cpu`). A script
without an npm alias can be invoked by its path, for example
`node scripts/benchmarks/benchmark-dxa-edges.mjs`; read its argument handling or
usage comment first. Some comparison benchmarks require a baseline checkout or
commit and do not support a generic `--help` flag.

The shared browser harness defaults to software rendering. Scripts that expose
adapter selection accept `--software`/`--hardware` or `ALLOYVIEW_GPU_ADAPTER`;
software results validate behavior but do not measure physical GPU speed. Research
scripts document their additional OVITO/Python prerequisites in their headers.

## Adding or moving scripts

- Put regressions in `browser/`, measurements in `benchmarks/`, reusable helpers
  in `lib/`, and external scientific reference work in `research/`.
- Keep build/server entry points in this directory and retain existing npm command
  names when moving their implementations. Preserve the descriptive `browser-`
  and `benchmark-` filenames so existing searches remain useful.
- Resolve repository files from the script location. A script one directory below
  `scripts/` reaches the repository root with `resolve(import.meta.dirname, '../..')`
  or `new URL('../../', import.meta.url)`. Explicit CLI input/output paths retain
  the individual script's documented behavior.
- Imports inside browser `evaluate(...)` expressions resolve against the page URL,
  not the Node script. Shared browser fixtures use `/AlloyView/scripts/lib/...`;
  update these URLs as well as Node imports when moving helpers.
- Keep generated benchmark reports and temporary fixtures outside tracked source
  files unless a reviewed regression fixture is intentionally being added.
