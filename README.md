<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="src/asserts/logo/AlloyView_logo_light.svg">
    <img src="src/asserts/logo/AlloyView_logo_dark.svg" alt="AlloyView — atomistic structure visualization in your browser" width="640">
  </picture>
</h1>

<p align="center">
  <a href="https://yazhuoliu.com/AlloyView/">Use online</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/USER_GUIDE.md">User &amp; development guide</a> ·
  <a href="docs/FORMATS.md">Supported formats</a>
</p>

AlloyView is a browser-based viewer for atomistic structures and trajectories
in metals and alloys. Open AtomEye CFG or LAMMPS text dumps, inspect atoms,
calculate coordination numbers, and export figures. Files are parsed and
analyzed on your device; structure data is never uploaded by the application.

## Viewer

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/alloyview-dark.png">
  <img src="docs/images/alloyview-light.png" alt="AlloyView displaying an FCC crystal with a vacancy, colored by coordination number, with display controls and a scalar legend" width="1000">
</picture>

The bundled FCC vacancy example, colored by coordination number. The 3D view
is on the left; structure information, display settings, slicing and analysis
are on the right. Switch between **Light** and **Dark** in the top bar.

## Features

- AtomEye CFG and LAMMPS text dumps, including orthogonal and restricted
  triclinic cells, scalar properties and periodic boundary flags.
- Individual files, multi-frame dumps, numbered CFG sequences and numbered
  dump series, with a timeline and continuous playback.
- WebGL 2 sphere rendering, element-aware atom radii, six standard views,
  perspective/orthographic projection, cell outlines and Cartesian axes.
- Wrapped and unwrapped trajectory views, atom selection and fractional slicing.
- Display-only replication along independent periodic cell vectors, including
  triclinic tilts, without expanding or rerunning analysis.
- Periodic cutoff-based coordination analysis in browser Workers, with an
  editable cutoff suggestion for recognized metallic elements.
- Adaptive/fixed-cutoff CNA for FCC, HCP, BCC and icosahedral environments,
  crystal colors and per-class visibility checkboxes with live counts.
- Real polyhedral template matching (PTM) in Wasm Workers, with eight crystal
  templates, an adjustable RMSD threshold and the same crystal visibility controls.
- Atomic elastic strain relative to an ideal lattice, with editable element-based
  lattice constants, shear/hydrostatic strain, volume change and tensor components.
- AtomEye normalized central symmetry with 8/12 neighbors; all analyses share
  a bounded parallel Worker scheduler and retain per-frame results.
- Per-analysis Cancel controls stop computation and reset results and frame
  caches while keeping input settings and other analyses.
- Atom-type colors and five scalar color maps, with editable ranges and
  optional filtering of out-of-range atoms.
- PNG export with independent background, legend and XYZ-arrow controls.
  Exported arrows are optional and off by default. Transparent
  exports keep the legend labels and color keys without a filled legend panel.
- Light and dark themes with matching project logos and a saved preference.
- A resizable controls panel with saved width, plus live display and legend
  edits and automatic coordination updates when the cutoff changes.
- Selectable tool settings and a phone layout with the viewport fixed above
  independently scrolling tools and collapsed camera/legend controls.
- Bundled FCC, BCC trajectory and 40-image NEB examples.

## Quick start

Open the [online viewer](https://yazhuoliu.com/AlloyView/) in a browser with
WebGL 2 support. No installation or account is needed.

1. **Open a structure.** Click **Open local → Choose files…** for one or more
   CFG/LAMMPS files. Use **Choose folder…** to browse a folder and detect
   numbered sequences automatically. Dragging files into the viewport also
   works. Or click **Examples** and choose a bundled source.
2. **Navigate.** Drag to rotate, Shift/right-drag to pan, and scroll to zoom.
   Click an atom to inspect its ID, type, coordinates and scalar properties.
   Use the standard views, **Perspective** or **Ortho** to set the camera.
   Drag the divider beside the right panel to adjust its width; double-click
   the divider to restore the default.
3. **Adjust the view.** Choose colors and atom size in **Display**, change the
   viewport color with **BG**, or hide the cell and axes. Trajectories expose
   wrapped/unwrapped coordinates and frame controls below the viewport.
   Select **Replicate** to set total copies along periodic **a/b/c** directions
   and click **Apply**. Select a tool button to open its settings; switch tools
   to keep analyses running, or close an analysis to cancel it and reset results.
4. **Analyze.** Check the suggested cutoff under **Coordination number** and
   click **Calculate**. The scalar legend lets you choose a color map and
   adjust the visible range. Editing the cutoff automatically recalculates
   after a short typing pause. Display and legend edits apply immediately.
   The cutoff is a starting estimate; choose it for
   your structure's neighbor shells.
   Use **Common neighbor analysis** or **Polyhedral template matching** for
   crystal identification, then the legend checkboxes to show/hide each class.
   Under **Ideal lattice reference**, check the element, crystal phase and
   lattice constants before calculating atomic elastic strain.
5. **Export.** Choose **Include background in PNG** and **Include legend in
   PNG** independently, then click the download arrow in the viewport toolbar.
   Uncheck the background option for transparency, including around the legend.
   **Include XYZ arrows in PNG** adds the current Cartesian orientation even
   when the screen's axes are hidden; it is unchecked by default.

A single file picker cannot discover unselected sibling files. Select all
frames together or choose their folder to open a sequence.

## Run locally

Development requires Node.js 20 or newer. The viewer has no npm dependencies.

```bash
npm run dev
```

Open <http://localhost:5173>. To build and preview the static site:

```bash
npm run build
npm run preview
```

Open <http://localhost:4173>. The deployable site is in `dist/`.

The compiled PTM kernel is included in the repository. Normal development and
CI need no compiler. To change its C++ integration, install Emscripten and run
`npm run build:ptm`; see [Structure analysis](docs/STRUCTURE_ANALYSIS.md).

## Tests and deployment

```bash
npm test
npm run build
npm run test:browser
```

The browser regression requires Node.js 24 and Chrome/Chromium; set
`CHROME_PATH` if needed. It serves the production build at `/AlloyView/`
without isolation headers, loads local files and all examples, checks themes
and trajectory frames, exercises CNA/CSP/PTM/strain and crystal visibility
filters, and decodes PNG exports to verify transparency and optional axes.

The included GitHub Actions workflow tests, builds and deploys on pushes to
`main`. Set **Settings → Pages → Source → GitHub Actions** in the repository.
Each build versions the entire script/Worker/asset tree to prevent cached
modules from mixing file-loading protocols after deployment. See the
[deployment guide](docs/DEPLOYMENT.md).

## Documentation

| Topic | Reference |
| --- | --- |
| Detailed capabilities, local setup and current limits | [User & development guide](docs/USER_GUIDE.md) |
| CFG and LAMMPS conventions | [Supported formats](docs/FORMATS.md) |
| Static hosting and GitHub Pages | [Deployment](docs/DEPLOYMENT.md) |
| Executed tests and benchmark results | [Validation record](docs/VALIDATION.md) |
| AtomEye design references and source provenance | [AtomEye review](docs/ATOMEYE_REVIEW.md) |
| CNA, PTM, atomic strain, central symmetry and parallel execution | [Structure analysis](docs/STRUCTURE_ANALYSIS.md) |

WebGL 2 is required. Compressed/binary dumps, LAMMPS data/input files and
LAMMPS general triclinic `abc origin` dumps are not supported. Coordination
currently uses one global cutoff. Million-atom interactive performance has
not been verified; see the guide for memory and trajectory limitations.

## Contributing and support

Report bugs or request features through
[GitHub Issues](https://github.com/Yazhuo-Liu/AlloyView/issues). For loading
problems, include the browser version, file format and a small reproducible
sample when possible. Contributions are welcome as pull requests.

## License

AlloyView is distributed under the [MIT License](LICENSE). AtomEye informed
format conventions and neighbor-search design; no AtomEye C source or asset
is copied into this repository. The vendored PTM library is MIT licensed and
its embedded Voro++ code is BSD licensed; [third-party notices](licenses/)
ship with the static build. See the [provenance review](docs/ATOMEYE_REVIEW.md).
