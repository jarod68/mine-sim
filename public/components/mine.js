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
  dirt:       'rgba(134, 96, 67, 1)',
  iron:       'rgba(196, 160, 136, 1)',
  copper:     'rgba(206, 116, 66, 1)',
  gold:       'rgba(226, 198, 64, 1)',
  carbon:     'rgba(52, 52, 56, 1)',
  unexplored: 'rgba(96, 156, 56, 1)',
  prep:       'rgba(76, 76, 84, 1)',      // deepslate — unprepared rich vein
};

// Solid swatch colours (popup gauge, stats chart, truck loads): each ore's
// fleck colour, so they match the textures.
export const COLORS_SOLID = {
  dirt:       '#866043',
  iron:       '#d8af93',
  copper:     '#e07b40',
  gold:       '#fcee4b',
  carbon:     '#2b2b2b',
  unexplored: '#5d9a35',
};

// Fallback total used for the popup gauge; the authoritative value also comes
// from the server state (`blockTonnage`).
export const BLOCK_TONNAGE = 10000;
