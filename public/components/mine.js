// Client-side presentation constants. The mine itself (generation, drilling,
// hidden composition) is now owned by the server — see game/mine.js. The client
// only needs colours and labels to render the state it receives.

export const ORE_LABELS = {
  iron:   'Iron',
  copper: 'Copper',
  gold:   'Gold',
  carbon: 'Carbon',
};

// Flat fills used when zoomed far out (blocks too small for their pixel
// texture, see textures.js) — roughly each texture's average colour.
export const COLORS = {
  dirt:       'rgba(118, 61, 36, 1)',     // pit floor
  iron:       'rgba(140, 62, 50, 1)',
  copper:     'rgba(72, 150, 118, 1)',
  gold:       'rgba(214, 170, 72, 1)',
  carbon:     'rgba(46, 41, 38, 1)',
  unexplored: 'rgba(164, 84, 48, 1)',     // red-ochre soil
  prep:       'rgba(74, 54, 48, 1)',      // ironstone — unprepared rich vein
};

// Solid swatch colours (popup gauge, stats chart, truck loads): each ore's
// fleck colour, so they match the textures.
export const COLORS_SOLID = {
  dirt:       '#7a3f24',
  iron:       '#b0453a',
  copper:     '#3fa57e',
  gold:       '#f2c14e',
  carbon:     '#2e2926',
  unexplored: '#a4532f',
};

// Fallback total used for the popup gauge; the authoritative value also comes
// from the server state (`blockTonnage`).
export const BLOCK_TONNAGE = 10000;
