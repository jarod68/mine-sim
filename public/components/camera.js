// Shared 2D camera. Layers render their logical content (0..VIEW) through this
// transform, so zooming re-rasterises at full resolution (no pixelation) rather
// than CSS-scaling a fixed bitmap. `scale` zoom, `ox/oy` pan (in CSS pixels).

export const camera = { scale: 1, ox: 0, oy: 0 };

// Cap the device-pixel-ratio: on a Retina screen the raw dpr (2–3) quadruples
// the backing store of EVERY canvas layer, which dominates fill cost for little
// visible gain past 2×.
export const DPR = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);

// Reset the context to device pixels, then apply the camera. Call at the start
// of every layer render (after clearing).
export function applyCamera(ctx, dpr) {
  ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * camera.ox, dpr * camera.oy);
}

// Convert a client (mouse) point to logical world coordinates.
export function toWorld(clientX, clientY, rect) {
  return {
    x: (clientX - rect.left - camera.ox) / camera.scale,
    y: (clientY - rect.top - camera.oy) / camera.scale,
  };
}

// The world-coordinate rectangle currently visible in a (cssW × cssH) viewport,
// for culling off-screen content. Inverse of the camera transform at the corners.
export function visibleRect(cssW, cssH) {
  return {
    x0: -camera.ox / camera.scale,
    y0: -camera.oy / camera.scale,
    x1: (cssW - camera.ox) / camera.scale,
    y1: (cssH - camera.oy) / camera.scale,
  };
}
