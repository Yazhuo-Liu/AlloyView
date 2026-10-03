export function initializeFileDrop({ target = document, overlay, onFiles }) {
  let depth = 0;
  const listeners = [];
  const isFileDrag = event => [...(event.dataTransfer?.types ?? [])].includes('Files')
    || event.dataTransfer?.files?.length > 0;
  const clear = () => { depth = 0; overlay.hidden = true; };
  function listen(node, name, handler) {
    node?.addEventListener(name, handler);
    if (node) listeners.push(() => node.removeEventListener(name, handler));
  }
  listen(target, 'dragenter', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); depth++; overlay.hidden = false;
  });
  listen(target, 'dragover', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; overlay.hidden = false;
  });
  listen(target, 'dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) clear();
  });
  listen(target, 'drop', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault(); clear();
    const files = [...event.dataTransfer.files];
    if (files.length) onFiles(files);
  });
  listen(target.defaultView, 'blur', clear);
  return { clear, dispose() { clear(); for (const remove of listeners) remove(); } };
}
