import { crc32 } from '../io/export-archive.js';

// One encoder handles the two admitted snapshots in order. The page can
// render the next frame while PNG compression and its CRC run here.
let queue = Promise.resolve();
self.onmessage = ({ data: { id, bitmap } }) => {
  queue = queue.then(async () => {
    let canvas, closed = false;
    try {
      canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      // Adopt the snapshot directly when supported: PNG export needs no new
      // drawing, so another 2D copy and readback would only add work.
      const bitmapContext = canvas.getContext('bitmaprenderer');
      if (bitmapContext) bitmapContext.transferFromImageBitmap(bitmap);
      else {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('The image encoder could not create a canvas.');
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
      }
      closed = true;
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const crc = crc32(new Uint8Array(await blob.arrayBuffer()));
      self.postMessage({ id, blob, crc });
    } catch (error) {
      self.postMessage({ id, error: error?.message ?? String(error) });
    } finally {
      if (!closed) bitmap.close();
      if (canvas) canvas.width = canvas.height = 1;
    }
  });
};
