/** Keep viewport overlays compact on narrow screens without changing display settings. */
export function initializeMobileControls() {
  const narrow = matchMedia('(max-width: 920px)');
  const overlays = [
    {
      wrapper: document.getElementById('view-overlay'),
      button: document.getElementById('toggle-view-controls'),
      panel: document.getElementById('view-controls'),
    },
    {
      wrapper: document.getElementById('legend-overlay'),
      button: document.getElementById('toggle-legend'),
      panel: document.getElementById('legend'),
    },
    {
      wrapper: document.getElementById('atom-details-overlay'),
      button: document.getElementById('toggle-atom-details'),
      panel: document.getElementById('atom-details'),
      // Details also folds on desktop and starts folded everywhere.
      desktopCollapsible: true,
    },
  ].filter(({ wrapper, button, panel }) => wrapper && button && panel);

  function setExpanded(overlay, expanded) {
    overlay.wrapper.classList.toggle('is-expanded', expanded);
    overlay.button.setAttribute('aria-expanded', String(expanded));
    // Collapsed content must also be absent from keyboard navigation.
    overlay.panel.inert = (narrow.matches || overlay.desktopCollapsible) && !expanded;
    if (overlay.desktopCollapsible) overlay.panel.hidden = !expanded;
  }

  const expandedByDefault = overlay => !narrow.matches && !overlay.desktopCollapsible;

  function syncLayout() {
    for (const overlay of overlays) setExpanded(overlay, expandedByDefault(overlay));
    document.getElementById('background-picker')?.removeAttribute('open');
  }

  for (const overlay of overlays) {
    overlay.button.addEventListener('click', () => {
      const expanded = overlay.button.getAttribute('aria-expanded') !== 'true';
      if (!narrow.matches) {
        if (overlay.desktopCollapsible) setExpanded(overlay, expanded);
        return;
      }
      for (const other of overlays) setExpanded(other, other === overlay && expanded);
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !narrow.matches) return;
    const active = document.activeElement;
    for (const overlay of overlays) {
      if (overlay.panel.contains(active)) overlay.button.focus();
      setExpanded(overlay, false);
    }
    document.getElementById('background-picker')?.removeAttribute('open');
  });

  const legend = overlays.find(({ panel }) => panel.id === 'legend');
  if (legend) {
    function syncLegendAvailability() {
      legend.wrapper.hidden = legend.panel.hidden;
      if (legend.panel.hidden) setExpanded(legend, !narrow.matches);
    }
    new MutationObserver(syncLegendAvailability).observe(legend.panel, {
      attributes: true,
      attributeFilter: ['hidden'],
    });
    syncLegendAvailability();
  }

  const details = overlays.find(({ panel }) => panel.id === 'atom-details');
  if (details) {
    // Closing a source folds Details again for the next structure;
    // frame/analysis updates preserve the user's current expansion choice.
    new MutationObserver(() => {
      if (details.wrapper.hidden) setExpanded(details, expandedByDefault(details));
    }).observe(details.wrapper, { attributes: true, attributeFilter: ['hidden'] });
  }

  narrow.addEventListener('change', syncLayout);
  syncLayout();
}
