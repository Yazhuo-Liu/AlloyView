/** The same descriptions power panel help and the documentation navigation. */
export const FEATURE_HELP = Object.freeze({
  display: { title: 'Display', page: 'display', summary: 'Choose coordinates, atom colors and radii, image options, and an independent second camera. Display changes preserve the source data.' },
  replicate: { title: 'Replicate', page: 'replicate', summary: 'Display copies along the actual periodic cell vectors. Copies reuse source atoms and do not change analysis input.' },
  slice: { title: 'Slices', page: 'slices', summary: 'Keep the intersection of up to 16 Cartesian half-spaces. Edit plane normals and positions numerically or with the viewport handles.' },
  coordination: { title: 'Coordination number', page: 'coordination', summary: 'Count unique neighboring atom IDs within a cutoff using the cell geometry and periodic boundaries.' },
  bonds: { title: 'Bonds', page: 'bonds', summary: 'Create periodic neighbor edges within a global or element-pair cutoff. Bond cylinders follow the selected periodic image.' },
  displacement: { title: 'Displacement', page: 'displacement', summary: 'Calculate current minus reference positions as per-atom components and magnitude. Opening enables frame updates; Cancel stops calculation and clears results.' },
  vectors: { title: 'Vector arrows', page: 'vectors', summary: 'Display imported or calculated vector properties without starting analyses. Choose arrow scale, anchor and proportions; atom visibility does not hide arrows.' },
  statistics: { title: 'Statistics and RDF', page: 'statistics', summary: 'Inspect coordination populations and a normalized radial distribution. RDF requires a fully periodic cell and a bounded cutoff.' },
  cna: { title: 'Common neighbor analysis', page: 'cna', summary: 'Classify FCC, HCP, BCC and ICO environments from common-neighbor bond signatures, with adaptive or fixed neighbor shells.' },
  centrosymmetry: { title: 'Central symmetry', page: 'centrosymmetry', summary: 'Measure AtomEye-style dimensionless opposite-neighbor symmetry. Auto selects an 8- or 12-neighbor shell from the local structure.' },
  ptm: { title: 'Polyhedral template matching', page: 'ptm', summary: 'Fit local neighbor topology to selected crystal templates. The RMSD threshold controls classification rejection.' },
  strain: { title: 'Ideal lattice strain', page: 'ideal-strain', summary: 'Restore the absolute ideal lattice scale to a PTM fit, then calculate Green–Lagrange strain and volume change.' },
  referenceStrain: { title: 'Reference frame strain', page: 'reference-strain', summary: 'Match stable atom IDs to a trajectory reference and fit a local deformation gradient from reference-frame neighbors.' },
  localShear: { title: 'Local shear', page: 'local-shear', summary: 'Measure the anisotropy of normalized neighbor second moments using AtomEye geometric shear. No reference frame is required.' },
  selection: { title: 'Atom details and measurements', page: 'selection', summary: 'Inspect atoms by ID, override their appearance, and measure distance, angle or dihedral with optional periodic image correction.' },
  performance: { title: 'Performance', page: 'performance', summary: 'Inspect GPU and analysis timing, Worker concurrency, and the trajectory cache. Rendering and analysis remain on this device.' },
  configuration: { title: 'Configuration', page: 'configuration', summary: 'Save or restore source metadata and view/analysis settings as JSON. Reopen the matching original files to restore a session.' },
});

export function initializeFeatureHelp(root = document) {
  if (!root.getElementById('feature-help-styles')) {
    const stylesheet = root.createElement('link');
    stylesheet.id = 'feature-help-styles';
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./feature-help.css', import.meta.url).href;
    root.head.append(stylesheet);
  }
  const panels = [...root.querySelectorAll('[data-tool-panel]')];
  const configuration = root.getElementById('configuration-section');
  if (configuration) panels.push(configuration);
  let activeTooltip = null;
  function positionTooltip(link, tooltip) {
    const anchor = link.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const width = root.documentElement.clientWidth;
    const height = root.documentElement.clientHeight;
    const left = Math.max(8, Math.min(width - box.width - 8, anchor.right - box.width));
    const below = anchor.bottom + 9;
    const top = below + box.height <= height - 8 ? below : Math.max(8, anchor.top - box.height - 9);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }
  root.addEventListener('scroll', () => { if (activeTooltip) positionTooltip(...activeTooltip); }, true);
  root.defaultView?.addEventListener('resize', () => { if (activeTooltip) positionTooltip(...activeTooltip); });
  for (const panel of panels) {
    const key = panel === configuration ? 'configuration' : panel.dataset.toolPanel;
    const feature = FEATURE_HELP[key];
    if (!feature) continue;
    // Statistics contains two detailed headings; both explain the same page.
    const headings = [...panel.querySelectorAll('h3, .section-heading h2')];
    // Performance uses a collapsible details summary rather than an h3.
    if (!headings.length) { const summaryLabel = panel.querySelector('summary > span'); if (summaryLabel) headings.push(summaryLabel); }
    for (const [index, heading] of headings.entries()) {
      if (heading.querySelector('.feature-help')) continue;
      const wrapper = root.createElement('span');
      wrapper.className = 'feature-help';
      const link = root.createElement('a');
      link.className = 'feature-help-link';
      link.href = new URL(`./docs/features/${feature.page}.html`, root.baseURI).href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = '?';
      link.setAttribute('aria-label', `${heading.textContent.trim()}: open documentation in a new tab`);
      const tooltip = root.createElement('span');
      tooltip.id = `feature-help-${key}-${index}`;
      tooltip.className = 'feature-help-tooltip';
      tooltip.role = 'tooltip';
      tooltip.textContent = feature.summary;
      link.setAttribute('aria-describedby', tooltip.id);
      wrapper.append(link, tooltip);
      if (/^H[23]$/.test(heading.tagName)) heading.classList.add('feature-help-heading');
      heading.append(wrapper);
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { wrapper.classList.add('tooltip-dismissed'); activeTooltip = null; link.blur(); }
      });
      const show = () => { wrapper.classList.remove('tooltip-dismissed'); activeTooltip = [link, tooltip]; positionTooltip(link, tooltip); };
      link.addEventListener('mouseenter', show);
      link.addEventListener('focus', show);
      link.addEventListener('mouseleave', () => { if (root.activeElement !== link) activeTooltip = null; });
      link.addEventListener('blur', () => { activeTooltip = null; });
    }
  }
}
