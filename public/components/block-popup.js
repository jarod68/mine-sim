// Floating popup showing a block's composition. While a block is unexplored it
// offers a "Drill & Explore" button; once drilled it shows the dirt/ore gauge
// with remaining tonnage.

import { COLORS_SOLID as COLORS, ORE_LABELS, BLOCK_TONNAGE } from './mine.js';

const tons = (t) => `${Math.round(t).toLocaleString('en-US')} t`;

export class BlockPopup {
  constructor(el) {
    this.el = el;
    this._block = null;
    this._pos = null;
    this._onDrill = null;

    // Dismiss when clicking outside the popup (canvas clicks re-open it).
    document.addEventListener('click', (e) => {
      if (this.el.contains(e.target)) return;
      if (e.target.tagName === 'CANVAS') return;
      this.hide();
    });
  }

  show(block, pos, { onDrill, drillCost, note } = {}) {
    this._block = block;
    this._pos = pos;
    this._onDrill = onDrill;
    if (drillCost != null) this._drillCost = drillCost;
    this._note = note || null;

    this.el.innerHTML = block.explored
      ? this._exploredHtml(block)
      : this._unexploredHtml(block);

    this.el.querySelector('.close').addEventListener('click', () => this.hide());

    const drill = this.el.querySelector('.drill');
    if (drill) {
      drill.addEventListener('click', async () => {
        drill.disabled = true;
        drill.textContent = 'Drilling…';
        const revealed = await this._onDrill?.(block);
        if (revealed) {
          this.show(revealed, pos, { onDrill: this._onDrill });
        } else {
          // drill refused (e.g. insufficient credit) — keep the button, warn
          this.show(block, pos, { onDrill: this._onDrill, note: 'Not enough credit' });
        }
      });
    }

    this._position(pos);
  }

  _unexploredHtml(block) {
    const cost = this._drillCost != null
      ? ` · $${this._drillCost.toLocaleString('en-US')}`
      : '';
    const note = this._note ? `<div class="note">${this._note}</div>` : '';
    return `
      <header>
        <span>Block (${block.x}, ${block.y})</span>
        <button class="close" aria-label="Close">×</button>
      </header>
      <div class="unknown">Composition unknown</div>
      ${note}
      <button class="drill">⛏ Drill &amp; Explore${cost}</button>
    `;
  }

  _exploredHtml(block) {
    const oreSeg = block.ore
      ? `<div class="seg" style="width:${block.orePct}%;background:${COLORS[block.ore]}"></div>`
      : '';
    const oreRow = block.ore
      ? `<div class="row">
           <span class="swatch" style="background:${COLORS[block.ore]}"></span>
           <span class="label">${ORE_LABELS[block.ore]}</span>
           <span class="pct">${tons(block.oreRemaining)}</span>
         </div>`
      : `<div class="row muted">No ore — pure dirt</div>`;

    return `
      <header>
        <span>Block (${block.x}, ${block.y})</span>
        <button class="close" aria-label="Close">×</button>
      </header>
      <div class="bar">
        <div class="seg" style="width:${block.dirtPct}%;background:${COLORS.dirt}"></div>
        ${oreSeg}
      </div>
      <div class="row">
        <span class="swatch" style="background:${COLORS.dirt}"></span>
        <span class="label">Dirt</span>
        <span class="pct">${tons(block.dirtRemaining)}</span>
      </div>
      ${oreRow}
      <div class="total">Total remaining: ${tons(block.dirtRemaining + block.oreRemaining)} / ${tons(BLOCK_TONNAGE)}</div>
    `;
  }

  _position(pos) {
    this.el.style.display = 'block';
    const margin = 12;
    const rect = this.el.getBoundingClientRect();
    let left = pos.clientX + margin;
    let top = pos.clientY + margin;
    if (left + rect.width > window.innerWidth) left = pos.clientX - rect.width - margin;
    if (top + rect.height > window.innerHeight) top = pos.clientY - rect.height - margin;
    this.el.style.left = `${Math.max(margin, left)}px`;
    this.el.style.top = `${Math.max(margin, top)}px`;
  }

  hide() {
    this.el.style.display = 'none';
  }
}
