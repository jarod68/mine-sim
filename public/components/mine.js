// Client-side presentation constants. The mine itself (generation, drilling,
// hidden composition) is now owned by the server — see game/mine.js. The client
// only needs colours and labels to render the state it receives.

export const ORE_LABELS = {
  iron:   'Iron',
  copper: 'Copper',
  gold:   'Gold',
  carbon: 'Carbon',
};

export const COLORS = {
  dirt:       '#8a5a2b',
  iron:       '#9aa7b8',
  copper:     '#cd6e2e',
  gold:       '#e8c34a',
  carbon:     '#3d3d3d',
  unexplored: '#39414c',
};

// Fallback total used for the popup gauge; the authoritative value also comes
// from the server state (`blockTonnage`).
export const BLOCK_TONNAGE = 10000;
