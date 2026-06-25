// Top-down vehicle SPRITES — pure canvas drawing routines, one per vehicle type,
// each drawn in the vehicle local frame (front toward +x, origin at centre).
// Factored out of vehicle.js so the Fleet renderer stays focused on state,
// smoothing and layout. No module state: every function takes (ctx, L, W, …).

// ── top-down sprites (front toward +x) ───────────────────────────────────────

// Light utility vehicle — construction yellow, with a flashing orange beacon.
export function drawPickup(ctx, L, W) {
  ctx.fillStyle = '#111317';
  const ww = W * 0.2;
  const wl = L * 0.2;
  for (const sx of [-L * 0.26, L * 0.26]) {
    for (const sy of [-W / 2 - ww * 0.15, W / 2 - ww * 0.85]) {
      ctx.fillRect(sx - wl / 2, sy, wl, ww);
    }
  }

  ctx.fillStyle = '#f2c218';                 // body — construction yellow
  ctx.beginPath();
  ctx.roundRect(-L / 2, -W / 2, L, W, W * 0.24);
  ctx.fill();

  ctx.fillStyle = '#cf9914';                 // cargo bed (darker yellow)
  ctx.beginPath();
  ctx.roundRect(-L / 2 + L * 0.05, -W * 0.34, L * 0.4, W * 0.68, 1.5);
  ctx.fill();

  ctx.fillStyle = '#f7d65a';                 // cab (lighter yellow)
  ctx.beginPath();
  ctx.roundRect(0, -W * 0.42, L * 0.34, W * 0.84, 1.5);
  ctx.fill();

  ctx.fillStyle = '#1d2a36';                 // windshield
  ctx.beginPath();
  ctx.roundRect(L * 0.2, -W * 0.32, L * 0.12, W * 0.64, 1);
  ctx.fill();

  ctx.fillStyle = '#e6ecf5';                 // bumper
  ctx.fillRect(L * 0.46, -W * 0.32, L * 0.04, W * 0.64);

  // flashing orange beacon (gyrophare) on the left of the cab roof, no outline
  const on = (performance.now() % 700) < 350;
  const bx = L * 0.08;
  const by = -W * 0.25;            // left side of the roof
  const br = Math.min(L, W) * 0.14;
  if (on) { ctx.shadowColor = 'rgba(255, 140, 0, 0.95)'; ctx.shadowBlur = 9; }
  ctx.fillStyle = on ? '#ff9b1a' : '#7a4a12';
  ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
}

// Track dozer (PR776) — white crawler bulldozer. Top view, front toward +x:
//   • front 10% = a wide, very thin blade on its push-arms,
//   • middle 25% = the cab (widest part) with a windshield,
//   • rear 50% = the engine deck (narrower) with louvers + exhaust,
//   • tail = a single ripper shank that hooks into the ground.
export function drawDozer(ctx, L, W, modelTag = null) {
  // crawler tracks (dark) down both sides
  ctx.fillStyle = '#15171b';
  const tw = W * 0.28;
  ctx.beginPath(); ctx.roundRect(-L * 0.46, -W / 2, L * 0.9, tw, 2); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-L * 0.46, W / 2 - tw, L * 0.9, tw, 2); ctx.fill();
  ctx.strokeStyle = '#2e3238'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = -L * 0.42; gx < L * 0.42; gx += 3.0) {
    ctx.moveTo(gx, -W / 2); ctx.lineTo(gx, -W / 2 + tw);
    ctx.moveTo(gx, W / 2 - tw); ctx.lineTo(gx, W / 2);
  }
  ctx.stroke();

  // rear ripper — a shank hooking into the ground (top view)
  ctx.strokeStyle = '#3b3e44';
  ctx.lineWidth = Math.max(1.6, W * 0.11);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-L * 0.34, 0);
  ctx.lineTo(-L * 0.45, 0);
  ctx.quadraticCurveTo(-L * 0.53, 0, -L * 0.50, W * 0.18);
  ctx.stroke();
  ctx.lineCap = 'butt';

  // engine deck (rear 50%, narrower) — white with louvers + an exhaust stack
  ctx.fillStyle = '#e8eaed';
  ctx.beginPath(); ctx.roundRect(-L * 0.35, -W * 0.31, L * 0.50, W * 0.62, 2); ctx.fill();
  ctx.strokeStyle = '#9aa0aa'; ctx.lineWidth = Math.max(0.6, W * 0.03);
  ctx.beginPath();
  for (let gx = -L * 0.30; gx <= -L * 0.04; gx += L * 0.05) { ctx.moveTo(gx, -W * 0.2); ctx.lineTo(gx, W * 0.2); }
  ctx.stroke();
  const er = Math.min(L, W) * 0.035;
  ctx.fillStyle = '#2c2f34';
  ctx.beginPath(); ctx.arc(-L * 0.27, -W * 0.23, er, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#6b7077'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(-L * 0.27, -W * 0.23, er, 0, Math.PI * 2); ctx.stroke();

  // cab — a black square (thin white outline) midway between engine deck and blade
  const cabH = W * 0.30;             // half-side (a square ≈ 0.6·W across)
  const cabCx = L * 0.30;            // midway between the engine front and the blade
  ctx.fillStyle = '#111317';
  ctx.beginPath(); ctx.roundRect(cabCx - cabH, -cabH, cabH * 2, cabH * 2, 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = Math.max(0.4, W * 0.025);
  ctx.stroke();

  // flashing beacon (gyrophare) on the cab roof, like the LV (small)
  const on = (performance.now() % 700) < 350;
  const gbr = Math.min(L, W) * 0.042;
  if (on) { ctx.shadowColor = 'rgba(255, 140, 0, 0.95)'; ctx.shadowBlur = 9; }
  ctx.fillStyle = on ? '#ff9b1a' : '#7a4a12';
  ctx.beginPath(); ctx.arc(cabCx, -cabH * 0.42, gbr, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // push-arms + the arm holding the blade (front 10%)
  ctx.fillStyle = '#b9bec5';
  for (const sy of [-W * 0.30, W * 0.30]) { ctx.beginPath(); ctx.roundRect(L * 0.38, sy - W * 0.045, L * 0.10, W * 0.09, 1); ctx.fill(); }
  ctx.fillStyle = '#c7ccd2';
  ctx.beginPath(); ctx.roundRect(L * 0.40, -W * 0.10, L * 0.08, W * 0.20, 1); ctx.fill();

  // blade — wide, very thin steel edge at the very front. Slight U-blade: the
  // central run is straight, but the outer ~5% at each end sweep forward (+x,
  // toward the vehicle's nose), like a real dozer's U-blade wings.
  const bbx = L * 0.46;              // back face of the blade
  const bfx = L * 0.515;            // front (leading) face
  const bExt = W * 0.58;            // half-span across the vehicle
  const bKnee = W * 0.522;          // bend starts here → only the outer ~5% curls forward
  const bFwd = L * 0.045;           // how far the wing tips sweep forward
  const frontFace = () => {         // leading edge, top tip → straight run → bottom tip
    ctx.moveTo(bfx + bFwd, -bExt);
    ctx.quadraticCurveTo(bfx, -bExt, bfx, -bKnee);
    ctx.lineTo(bfx, bKnee);
    ctx.quadraticCurveTo(bfx, bExt, bfx + bFwd, bExt);
  };
  ctx.fillStyle = '#dadfe5';
  ctx.beginPath();
  frontFace();
  ctx.lineTo(bbx + bFwd, bExt);                            // bottom wing cap
  ctx.quadraticCurveTo(bbx, bExt, bbx, bKnee);             // back face up
  ctx.lineTo(bbx, -bKnee);
  ctx.quadraticCurveTo(bbx, -bExt, bbx + bFwd, -bExt);     // top wing cap
  ctx.closePath();
  ctx.fill();
  // darker cutting edge tracing the U-shaped leading face
  ctx.strokeStyle = '#aeb4bc';
  ctx.lineWidth = Math.max(1, L * 0.014);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); frontFace(); ctx.stroke();
  ctx.lineJoin = 'miter'; ctx.lineCap = 'butt';

  // model tag on the engine deck, turned 90° and sitting on its own white pad so
  // nothing (e.g. the louvers) shows through behind it.
  if (modelTag) {
    const fs = Math.max(2, W * 0.12);
    ctx.save();
    ctx.translate(-L * 0.18, 0);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `bold ${fs.toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(modelTag);
    const tw = (m && m.width) || fs * 3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(-tw / 2 - 1.5, -fs * 0.62, tw + 3, fs * 1.24, 1.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(40, 45, 55, 0.9)';
    ctx.fillText(modelTag, 0, 0);
    ctx.restore();
  }
}

// Motor grader (CAT 24) — a long, narrow construction-yellow machine, ~half the
// width of a haul truck but just as long. Top view, front toward +x:
//   • front tip = a single steered axle (two wheels) right at the nose,
//   • a full-width angled blade (moldboard) just behind the front axle,
//   • a black square cab amidships with a flashing beacon (like the dozer),
//   • rear 30% = the engine deck riding over the tandem rear wheels.
export function drawGrader(ctx, L, W, modelTag = null) {
  // ── tyres (dark): front steer axle + rear tandem, sticking out past the body ──
  ctx.fillStyle = '#111317';
  const wl = L * 0.11;                 // wheel length (along travel)
  const wheel = (ax) => {
    ctx.fillRect(ax - wl / 2, W * 0.30, wl, W * 0.34);    // right
    ctx.fillRect(ax - wl / 2, -W * 0.64, wl, W * 0.34);   // left
  };
  wheel(L * 0.40);                     // front steer axle (at the nose)
  wheel(-L * 0.28);                    // rear tandem (front pair)
  wheel(-L * 0.42);                    // rear tandem (rear pair)

  // ── chassis: the long "gooseneck" frame beam from front axle back to engine,
  // bright yellow so the whole machine reads as one connected body ──
  ctx.fillStyle = '#f2c218';
  ctx.beginPath(); ctx.roundRect(-L * 0.5, -W * 0.18, L * 0.95, W * 0.36, W * 0.09); ctx.fill();
  ctx.strokeStyle = '#b07f10'; ctx.lineWidth = Math.max(0.5, W * 0.03);
  ctx.beginPath(); ctx.roundRect(-L * 0.5, -W * 0.18, L * 0.95, W * 0.36, W * 0.09); ctx.stroke();

  // ── engine deck (rear 30% of the length) — yellow, louvered, with an exhaust ──
  ctx.fillStyle = '#f2c218';
  ctx.beginPath(); ctx.roundRect(-L * 0.5, -W * 0.42, L * 0.30, W * 0.84, 2); ctx.fill();
  ctx.strokeStyle = '#b07f10'; ctx.lineWidth = Math.max(0.6, W * 0.05);
  ctx.beginPath();
  for (let gx = -L * 0.46; gx <= -L * 0.24; gx += L * 0.05) { ctx.moveTo(gx, -W * 0.30); ctx.lineTo(gx, W * 0.30); }
  ctx.stroke();
  const er = Math.min(L, W) * 0.06;
  ctx.fillStyle = '#2c2f34';
  ctx.beginPath(); ctx.arc(-L * 0.22, -W * 0.30, er, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#6b7077'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(-L * 0.22, -W * 0.30, er, 0, Math.PI * 2); ctx.stroke();

  // ── moldboard (blade): full-width steel set on a diagonal, between the cab and
  // the front axle (front ~third of the machine). ──
  ctx.save();
  ctx.translate(L * 0.18, 0);
  ctx.rotate(0.34);                    // angle the blade like a working grader
  ctx.fillStyle = '#c7ccd2';
  ctx.beginPath(); ctx.roundRect(-L * 0.035, -W * 0.66, L * 0.07, W * 1.32, 1.5); ctx.fill();
  ctx.strokeStyle = '#9aa0aa'; ctx.lineWidth = Math.max(1, L * 0.012);
  ctx.beginPath(); ctx.roundRect(-L * 0.035, -W * 0.66, L * 0.07, W * 1.32, 1.5); ctx.stroke();
  ctx.restore();
  // the circle/drawbar tying the blade back to the frame
  ctx.fillStyle = '#b9bec5';
  ctx.beginPath(); ctx.roundRect(L * 0.02, -W * 0.07, L * 0.18, W * 0.14, 1); ctx.fill();

  // ── cab: a black SQUARE amidships, thin white outline (like the dozer). Sharp
  // corners (only a hair of rounding) so it reads as a square, not a disc. ──
  const cabHalf = W * 0.33;
  const cabCx = -L * 0.02;
  const cabR = Math.max(0.3, W * 0.04);
  ctx.fillStyle = '#111317';
  ctx.beginPath(); ctx.roundRect(cabCx - cabHalf, -cabHalf, cabHalf * 2, cabHalf * 2, cabR); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = Math.max(0.4, W * 0.035);
  ctx.stroke();

  // flashing beacon (gyrophare) on the cab roof, same as the dozer
  const on = (performance.now() % 700) < 350;
  const gbr = Math.min(L, W) * 0.055;
  if (on) { ctx.shadowColor = 'rgba(255, 140, 0, 0.95)'; ctx.shadowBlur = 9; }
  ctx.fillStyle = on ? '#ff9b1a' : '#7a4a12';
  ctx.beginPath(); ctx.arc(cabCx, -cabHalf * 0.5, gbr, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // model tag on the engine deck, turned 90° on its own white pad (like the dozer)
  if (modelTag) {
    const fs = Math.max(2, W * 0.20);
    ctx.save();
    ctx.translate(-L * 0.35, 0);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `bold ${fs.toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(modelTag);
    const tw = (m && m.width) || fs * 2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(-tw / 2 - 1.5, -fs * 0.62, tw + 3, fs * 1.24, 1.5);
    ctx.fill();
    ctx.fillStyle = 'rgba(40, 45, 55, 0.9)';
    ctx.fillText(modelTag, 0, 0);
    ctx.restore();
  }
}

export function drawExcavator(ctx, L, W, digging, modelTag) {
  // ── crawler tracks (aligned to travel, static) ──
  ctx.fillStyle = '#15171b';
  const tw = W * 0.26;
  ctx.beginPath(); ctx.roundRect(-L * 0.5, -W / 2, L, tw, 2); ctx.fill();
  ctx.beginPath(); ctx.roundRect(-L * 0.5, W / 2 - tw, L, tw, 2); ctx.fill();
  ctx.strokeStyle = '#2e3238';               // grousers
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = -L * 0.46; gx < L * 0.5; gx += 3.2) {
    ctx.moveTo(gx, -W / 2); ctx.lineTo(gx, -W / 2 + tw);
    ctx.moveTo(gx, W / 2 - tw); ctx.lineTo(gx, W / 2);
  }
  ctx.stroke();

  // ── upper structure: slews + the arm extends/retracts while loading ──
  const t = performance.now() / 1000;
  const swing = digging ? Math.sin(t * 2.4) * 0.5 : 0;                       // turret slew
  const reach = digging ? (Math.sin(t * 2.4 + Math.PI / 2) * 0.5 + 0.5) : 0.45; // dig cycle

  ctx.save();
  ctx.rotate(swing);

  // counterweight (rear) — light grey, extended back almost to the track ends
  ctx.fillStyle = '#d7dadf';
  ctx.beginPath(); ctx.roundRect(-L * 0.48, -W * 0.32, L * 0.16, W * 0.64, 2); ctx.fill();
  // house / turret — white, and a bit LONGER than before (closer to the real one)
  ctx.fillStyle = '#eef0f2';
  ctx.beginPath(); ctx.roundRect(-L * 0.34, -W * 0.34, L * 0.66, W * 0.68, 2); ctx.fill();
  // cab glass near the front of the house
  ctx.fillStyle = '#1d2a36';
  ctx.beginPath(); ctx.roundRect(L * 0.14, -W * 0.28, L * 0.16, W * 0.3, 1); ctx.fill();

  // engine deck at the rear of the turret: louvers (grille) + exhaust stack
  ctx.strokeStyle = '#9aa0aa';
  ctx.lineWidth = Math.max(0.6, W * 0.03);
  ctx.beginPath();
  for (let gx = -L * 0.30; gx <= -L * 0.14; gx += L * 0.045) {
    ctx.moveTo(gx, -W * 0.2); ctx.lineTo(gx, W * 0.2);
  }
  ctx.stroke();
  // exhaust pipe (top view: dark stack with a light rim), offset to one side
  const er = Math.min(L, W) * 0.03;
  ctx.fillStyle = '#2c2f34';
  ctx.beginPath(); ctx.arc(-L * 0.2, -W * 0.3, er, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#6b7077';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(-L * 0.2, -W * 0.3, er, 0, Math.PI * 2); ctx.stroke();

  // boom + stick (grey), extend with reach
  const baseX = L * 0.30;
  const tipX = L * (0.44 + 0.26 * reach);
  const midX = (baseX + tipX) / 2;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#b9bdc4';
  ctx.lineWidth = W * 0.18;
  ctx.beginPath(); ctx.moveTo(baseX, 0); ctx.lineTo(midX, 0); ctx.stroke();   // boom
  ctx.strokeStyle = '#d2d5da';
  ctx.lineWidth = W * 0.12;
  ctx.beginPath(); ctx.moveTo(midX, 0); ctx.lineTo(tipX, 0); ctx.stroke();    // stick

  // bucket at the tip
  ctx.fillStyle = '#54585f';
  ctx.strokeStyle = '#34373c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(tipX - L * 0.02, -W * 0.13, L * 0.09, W * 0.26, 1.5);
  ctx.fill(); ctx.stroke();

  // tiny model name near the lower edge of the house, clear of the boom, cab,
  // louvers and exhaust. Drawn inside the slew group so it rotates with the
  // turret during the loading animation. (Only legible when zoomed in.)
  if (modelTag) {
    ctx.fillStyle = 'rgba(40, 45, 55, 0.85)';
    ctx.font = `bold ${Math.max(2, W * 0.12).toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(modelTag, -L * 0.04, W * 0.26);
  }

  ctx.restore();
}

// Off-highway haul truck (tomberau), white. Top view, front toward +x:
//   • rear 75% of the length = dump bed (load well tinted by the carried ore),
//   • next ~22% = the canopy ("casquette") attached to the bed, over the cab,
//   • front 3% = the engine nose, in dark grey.
export function drawOHT(ctx, L, W, load = 0, oreColor = null, modelTag = null) {
  // tyres (dark), peeking out along the sides
  ctx.fillStyle = '#111317';
  const ww = W * 0.22;
  const wl = L * 0.1;
  const axle = (ax) => {
    for (const sy of [-W / 2 - ww * 0.05, W / 2 - ww * 0.95]) ctx.fillRect(ax - wl / 2, sy, wl, ww);
  };
  axle(L * 0.34);          // front
  axle(-L * 0.06);         // rear dual
  axle(-L * 0.24);

  // white body
  ctx.fillStyle = '#eef0f2';
  ctx.beginPath();
  ctx.roundRect(-L * 0.5, -W / 2, L, W, W * 0.14);
  ctx.fill();

  // dump bed (rear 75%) — load well shows the carried material's colour. Its rear
  // edge is a blunt pyramid across the width: triangle 25% / flat 50% / triangle 25%.
  const fX = L * 0.22;        // front of the well
  const rFlat = -L * 0.47;    // rearmost x (the flat middle)
  const rCorner = -L * 0.40;  // where the rear triangles meet the side walls
  const top = -W * 0.4;
  const bot = W * 0.4;
  ctx.fillStyle = (load > 0 && oreColor) ? oreColor : '#c9ccd1';
  ctx.beginPath();
  ctx.moveTo(fX, top);
  ctx.lineTo(fX, bot);
  ctx.lineTo(rCorner, bot);     // bottom side → start of lower triangle
  ctx.lineTo(rFlat, W * 0.2);   // lower triangle → flat
  ctx.lineTo(rFlat, -W * 0.2);  // flat middle (50%)
  ctx.lineTo(rCorner, top);     // upper triangle → top side
  ctx.closePath();
  ctx.fill();

  // canopy / "casquette" (front ~22%) covering the cab — white
  ctx.fillStyle = '#f7f8fa';
  ctx.beginPath();
  ctx.roundRect(L * 0.25, -W * 0.46, L * 0.22, W * 0.92, W * 0.08);
  ctx.fill();
  // faint cab hint under the canopy
  ctx.fillStyle = 'rgba(40, 55, 70, 0.35)';
  ctx.beginPath();
  ctx.roundRect(L * 0.30, -W * 0.34, L * 0.12, W * 0.68, 1);
  ctx.fill();

  // engine nose — front 3%, dark grey/black
  ctx.fillStyle = '#34373c';
  ctx.beginPath();
  ctx.roundRect(L * 0.47, -W * 0.34, L * 0.03, W * 0.68, 1);
  ctx.fill();

  // tiny model name on the canopy ("casquette"), running across it (zoom to read)
  if (modelTag) {
    ctx.save();
    ctx.translate(L * 0.36, 0);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = 'rgba(40, 45, 55, 0.85)';
    ctx.font = `bold ${Math.max(2, W * 0.22).toFixed(1)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(modelTag, 0, 0);
    ctx.restore();
  }
}

