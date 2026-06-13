// Client-side presentation constants. The mine itself (generation, drilling,
// hidden composition) is now owned by the server — see game/mine.js. The client
// only needs colours and labels to render the state it receives.

export const ORE_LABELS = {
  iron:   'Iron',
  copper: 'Copper',
  gold:   'Gold',
  carbon: 'Carbon',
};

// Terminal / phosphor palette — translucent neon over the near-black canvas so
// the dark grid shows through (modern "glass terminal" look).
export const COLORS = {
  dirt:       'rgba(74, 47, 25, 0.62)',     // dark brown earth (mined-out)
  iron:       'rgba(150, 90, 230, 0.50)',   // violet
  copper:     'rgba(255, 145, 70, 0.50)',   // amber
  gold:       'rgba(240, 226, 96, 0.55)',   // yellow
  carbon:     'rgba(10, 10, 14, 0.88)',     // near-black
  unexplored: 'rgba(70, 110, 95, 0.14)',    // dim phosphor void
};

// Solid (opaque) variants for legend swatches, so faint fills stay readable.
export const COLORS_SOLID = {
  dirt:       '#4a2f19',
  iron:       '#9a5ce6',
  copper:     '#ff9146',
  gold:       '#f0e260',
  carbon:     '#0c0c10',
  unexplored: '#2f6b56',
};

// Fallback total used for the popup gauge; the authoritative value also comes
// from the server state (`blockTonnage`).
export const BLOCK_TONNAGE = 10000;
