/* ============================================================
   Baccarat Scoreboard — core logic
   Standalone PWA. No network calls, no analytics, no accounts.
   ============================================================ */

'use strict';

const STORE_KEY = 'baccarat-scoreboard/v1';
const ROWS = 6;              // every road is 6 rows tall
const MAX_SHOES = 40;        // keep localStorage small
const HAND_NAMES = { B: 'Banker', P: 'Player', T: 'Tie' };

let state = loadState();
const ui = {
  mods: { bp: false, pp: false, nat: false },
  toastTimer: null,
  audio: null
};

/* ---------------- persistence ---------------- */

function defaultState() {
  return { shoes: [], activeId: null, settings: { sound: true, haptics: true } };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.shoes)) return defaultState();
    parsed.settings = Object.assign({ sound: true, haptics: true }, parsed.settings || {});
    return parsed;
  } catch (err) {
    return defaultState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) { /* private mode / quota — app keeps working in memory */ }
}

function makeShoe() {
  const id = 'shoe-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  return { id, startedAt: Date.now(), hands: [] };
}

function activeShoe() {
  let shoe = state.shoes.find((s) => s.id === state.activeId);
  if (!shoe) {
    shoe = makeShoe();
    state.shoes.unshift(shoe);
    state.activeId = shoe.id;
    saveState();
  }
  return shoe;
}

/* ---------------- roads ---------------- */

const k = (r, c) => r + ':' + c;

/**
 * Big road: columns of streaks, 6 rows tall.
 *  - a streak continues downward
 *  - a change starts a new column at the top
 *  - a streak longer than 6 turns the corner: one cell right on the bottom
 *    row, then continues upward ("dragon tail")
 *  - ties do not take a cell; they add a green slash to the previous cell
 */
function buildBigRoad(hands) {
  const cells = new Map();
  const depth = [];
  const order = [];
  let last = null;

  const findTailSpot = (col) => {
    let c = col;
    // first free bottom-row cell to the right, then climb up that column
    while (cells.has(k(ROWS - 1, c))) c += 1;
    if (!cells.has(k(ROWS - 1, c))) return { r: ROWS - 1, c };
    return null;
  };

  for (const hand of hands) {
    if (hand.o === 'T') {
      if (last) {
        const cell = cells.get(k(last.r, last.c));
        if (cell) cell.ties += 1;
      }
      continue;
    }

    let r;
    let c;

    if (!last) {
      r = 0; c = 0;
    } else if (last.o === hand.o) {
      // continuation
      if (last.r < ROWS - 1 && !cells.has(k(last.r + 1, last.c))) {
        r = last.r + 1; c = last.c;
      } else if (last.r === ROWS - 1) {
        const spot = findTailSpot(last.c + 1);
        r = spot.r; c = spot.c;
      } else {
        // column blocked lower down (shouldn't happen) — start new column
        c = last.c + 1; r = 0;
        while (r < ROWS - 1 && cells.has(k(r, c))) r += 1;
      }
    } else {
      // new column
      c = last.c + 1;
      r = 0;
      while (r < ROWS - 1 && cells.has(k(r, c))) r += 1;
    }

    cells.set(k(r, c), { o: hand.o, ties: 0, hand });
    depth[c] = (depth[c] || 0) + 1;
    order.push({ r, c, o: hand.o });
    last = { r, c, o: hand.o };
  }

  const cols = order.reduce((m, p) => Math.max(m, p.c), 0) + 1;
  return { cells, depth, order, cols: order.length ? cols : 0 };
}

/**
 * Derived roads, lookback L (1 = Big Eye Boy, 2 = Small Road, 3 = Cockroach Pig).
 *  - new column: red when the column one to the left has the same depth as the
 *    column L to the left of that one (pattern repeated), blue when it differs
 *  - continuation: red while the column to the left still reaches this row,
 *    blue once the streak grows past it (pattern broke)
 */
function derivedMarks(big, L) {
  const marks = [];
  const depth = new Array(Math.max(1, big.cols + 2)).fill(0);

  for (const p of big.order) {
    depth[p.c] = (depth[p.c] || 0) + 1;
    let mark = null;

    if (p.r === 0) {
      const a = p.c - 1;
      const b = p.c - 1 - L;
      if (b >= 0 && a >= 0) mark = (depth[a] || 0) === (depth[b] || 0) ? 'R' : 'B';
    } else if (p.c >= 1) {
      mark = (depth[p.c - 1] || 0) > p.r ? 'R' : 'B';
    }

    if (mark) marks.push(mark);
  }
  return marks;
}

/** Lay a flat list of marks into a 6-row derived grid. */
function layoutMarks(marks) {
  const cells = new Map();
  let last = null;
  let maxCol = 0;

  marks.forEach((mark) => {
    let r; let c;
    if (!last) {
      r = 0; c = 0;
    } else if (last.m === mark) {
      if (last.r < ROWS - 1 && !cells.has(k(last.r + 1, last.c))) {
        r = last.r + 1; c = last.c;
      } else if (last.r === ROWS - 1) {
        c = last.c + 1;
        while (cells.has(k(ROWS - 1, c))) c += 1;
        r = ROWS - 1;
      } else {
        c = last.c + 1; r = 0;
        while (r < ROWS - 1 && cells.has(k(r, c))) r += 1;
      }
    } else {
      c = last.c + 1; r = 0;
      while (r < ROWS - 1 && cells.has(k(r, c))) r += 1;
    }
    cells.set(k(r, c), { m: mark });
    last = { r, c, m: mark };
    maxCol = Math.max(maxCol, c);
  });

  return { cells, cols: marks.length ? maxCol + 1 : 0 };
}

function computeStats(hands) {
  const s = { B: 0, P: 0, T: 0, bp: 0, pp: 0, nat: 0, total: hands.length };
  for (const h of hands) {
    s[h.o] += 1;
    if (h.bp) s.bp += 1;
    if (h.pp) s.pp += 1;
    if (h.nat) s.nat += 1;
  }
  return s;
}

/* ---------------- rendering ---------------- */

const $ = (id) => document.getElementById(id);

function cellEl(r, c, inner) {
  const d = document.createElement('div');
  d.className = 'gc';
  d.style.gridRow = String(r + 1);
  d.style.gridColumn = String(c + 1);
  if (inner) d.innerHTML = inner;
  return d;
}

function tieSlashes(n) {
  const count = Math.min(n, 3);
  let out = '';
  for (let i = 1; i <= count; i += 1) out += `<i class="slash${i > 1 ? ' s' + i : ''}"></i>`;
  return out;
}

/**
 * Panel-driven sizing: six rows always fill the panel height, the column count
 * grows to fill the width, and the cell is nudged down so the last column never
 * hangs off the edge. Phones stay dense, tablets stop showing postage stamps
 * in a sea of beige.
 */
function fitPanel(scrollId, contentCols, minCell, maxCell) {
  const el = $(scrollId);
  const w = el ? el.clientWidth : 0;
  const h = el ? el.clientHeight : 0;
  let cell = Math.floor((h - 1) / ROWS);
  cell = Math.max(minCell, Math.min(maxCell, cell || minCell));
  // always cover the panel width so no bare panel shows through the grid
  const cols = Math.max(contentCols + 1, w ? Math.ceil(w / cell) : 8);
  return { cell, cols };
}

function applyCellVars(cells) {
  const root = document.documentElement.style;
  root.setProperty('--cell', cells.big + 'px');
  root.setProperty('--bead', cells.bead + 'px');
  root.setProperty('--mini', cells.mini + 'px');
}

/** Bead plate: fixed plate that fits every hand of the shoe without scrolling. */
function fitBead(hands) {
  const box = $('bead-scroll');
  const w = box ? box.clientWidth : 0;
  const h = box ? box.clientHeight : 0;
  const contentCols = Math.max(1, Math.ceil(hands.length / ROWS));
  const heightFit = Math.max(7, Math.min(72, Math.floor((h - 1) / ROWS) || 11));
  const widthFit = w ? Math.floor(w / contentCols) : heightFit;
  const cell = Math.max(7, Math.min(heightFit, widthFit, 72));
  return {
    cell,
    cols: Math.max(contentCols, w ? Math.floor(w / cell) : 6),
    rows: Math.max(ROWS, h ? Math.floor(h / cell) : ROWS)
  };
}

function renderBead(hands, fit) {
  const grid = $('bead');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let c = 0; c < fit.cols; c += 1) {
    for (let r = 0; r < fit.rows; r += 1) {
      const index = c * ROWS + r;
      const hand = r < ROWS ? hands[index] : undefined;
      let inner = '';
      if (hand) {
        inner += `<span class="mk ${hand.o.toLowerCase()}"></span>`;
        if (hand.bp) inner += '<i class="corner bp"></i>';
        if (hand.pp) inner += '<i class="corner pp"></i>';
        if (hand.nat) inner += '<i class="corner nat"></i>';
      }
      frag.appendChild(cellEl(r, c, inner));
    }
  }
  grid.appendChild(frag);
  $('bead-meta').textContent = hands.length ? String(hands.length) : '';
}

function renderBigRoad(big, cols) {
  const grid = $('bigroad');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < ROWS; r += 1) {
      const entry = big.cells.get(k(r, c));
      let inner = '';
      if (entry) {
        inner += `<span class="mk ${entry.o.toLowerCase()}"></span>`;
        if (entry.ties) inner += tieSlashes(entry.ties);
        if (entry.hand.bp) inner += '<i class="corner bp"></i>';
        if (entry.hand.pp) inner += '<i class="corner pp"></i>';
        if (entry.hand.nat) inner += '<i class="corner nat"></i>';
      }
      frag.appendChild(cellEl(r, c, inner));
    }
  }
  grid.appendChild(frag);
  $('big-meta').textContent = big.cols ? big.cols + ' col' : '';
}

function renderDerived(id, laid, cols) {
  const grid = $(id);
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < ROWS; r += 1) {
      const entry = laid.cells.get(k(r, c));
      const inner = entry ? `<span class="mk ${entry.m === 'R' ? 'mark-red' : 'mark-blue'}"></span>` : '';
      frag.appendChild(cellEl(r, c, inner));
    }
  }
  grid.appendChild(frag);
}

function renderStats(stats) {
  $('st-b').textContent = stats.B;
  $('st-p').textContent = stats.P;
  $('st-t').textContent = stats.T;
  $('st-bp').textContent = stats.bp;
  $('st-pp').textContent = stats.pp;
  $('st-nat').textContent = stats.nat;
  $('st-game').textContent = stats.total;
}

function scrollToEnd(id, cell) {
  const box = $(id);
  if (!box) return;
  const max = box.scrollWidth - box.clientWidth;
  if (max <= 0) { box.scrollLeft = 0; return; }
  // snap to a column boundary so the newest cell sits flush instead of half-cut
  box.scrollLeft = cell ? Math.min(max, Math.ceil(max / cell) * cell) : max;
}

function render(opts = {}) {
  const shoe = activeShoe();
  const hands = shoe.hands;
  const big = buildBigRoad(hands);
  const stats = computeStats(hands);

  const lays = {
    beb: layoutMarks(derivedMarks(big, 1)),
    small: layoutMarks(derivedMarks(big, 2)),
    cock: layoutMarks(derivedMarks(big, 3))
  };
  const beadFit = fitBead(hands);
  const bigFit = fitPanel('big-scroll', big.cols, 13, 56);
  const miniFit = fitPanel('beb-scroll', Math.max(lays.beb.cols, lays.small.cols, lays.cock.cols), 8, 32);

  applyCellVars({ big: bigFit.cell, bead: beadFit.cell, mini: miniFit.cell });

  renderBead(hands, beadFit);
  renderBigRoad(big, bigFit.cols);
  renderDerived('beb', lays.beb, miniFit.cols);
  renderDerived('smallroad', lays.small, miniFit.cols);
  renderDerived('cockroad', lays.cock, miniFit.cols);
  renderStats(stats);
  renderEntryState(stats);

  $('btn-undo').disabled = hands.length === 0;
  $('e-undo').disabled = hands.length === 0;

  requestAnimationFrame(() => {
    scrollToEnd('big-scroll', bigFit.cell);
    scrollToEnd('beb-scroll', miniFit.cell);
    scrollToEnd('small-scroll', miniFit.cell);
    scrollToEnd('cock-scroll', miniFit.cell);
  });

  if (opts.flash) {
    const el = document.querySelector('.outcome.o-' + opts.flash.toLowerCase());
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }
}

function previewLabel() {
  const parts = [];
  if (ui.mods.bp) parts.push('Banker Pair');
  if (ui.mods.pp) parts.push('Player Pair');
  if (ui.mods.nat) parts.push('Natural');
  return parts.length ? parts.join(' + ') : 'Banker / Player / Tie';
}

function renderEntryState(stats) {
  $('e-game').textContent = stats.total + 1;
  $('o-b').textContent = stats.B;
  $('o-p').textContent = stats.P;
  $('o-t').textContent = stats.T;
  $('e-preview').textContent = 'Next hand: ' + previewLabel();
  document.querySelectorAll('.mod').forEach((btn) => {
    btn.setAttribute('aria-pressed', ui.mods[btn.dataset.mod] ? 'true' : 'false');
  });

  const shoe = activeShoe();
  const last = shoe.hands[shoe.hands.length - 1];
  if (!last) {
    $('e-last').textContent = 'Last hand: —';
  } else {
    const tags = [];
    if (last.bp) tags.push('B pair');
    if (last.pp) tags.push('P pair');
    if (last.nat) tags.push('natural');
    $('e-last').textContent = 'Last hand: ' + HAND_NAMES[last.o] + (tags.length ? ' · ' + tags.join(' · ') : '');
  }
}

/* ---------------- actions ---------------- */

function flash(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(ui.toastTimer);
  ui.toastTimer = setTimeout(() => { el.hidden = true; }, 1400);
}

function tick() {
  if (!state.settings.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ui.audio = ui.audio || new Ctx();
    if (ui.audio.state === 'suspended') ui.audio.resume();
    const osc = ui.audio.createOscillator();
    const gain = ui.audio.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.05, ui.audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ui.audio.currentTime + 0.08);
    osc.connect(gain).connect(ui.audio.destination);
    osc.start();
    osc.stop(ui.audio.currentTime + 0.09);
  } catch (err) { /* audio is optional */ }
}

function haptic() {
  if (!state.settings.haptics) return;
  if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* ignore */ } }
}

function addHand(outcome) {
  const shoe = activeShoe();
  shoe.hands.push({
    o: outcome,
    bp: ui.mods.bp ? 1 : 0,
    pp: ui.mods.pp ? 1 : 0,
    nat: ui.mods.nat ? 1 : 0
  });
  ui.mods = { bp: false, pp: false, nat: false };
  saveState();
  tick();
  haptic();
  render({ flash: outcome });
}

function undo() {
  const shoe = activeShoe();
  if (!shoe.hands.length) { flash('Nothing to undo'); return; }
  shoe.hands.pop();
  saveState();
  haptic();
  render();
}

function newShoe() {
  const current = state.shoes.find((s) => s.id === state.activeId);
  if (current && current.hands.length === 0) { flash('Shoe already empty'); return; }
  const shoe = makeShoe();
  state.shoes.unshift(shoe);
  state.activeId = shoe.id;
  if (state.shoes.length > MAX_SHOES) state.shoes.length = MAX_SHOES;
  saveState();
  closeSheets();
  render();
  flash('New shoe started');
}

/* ---------------- entry overlay ---------------- */

function openEntry() {
  ui.mods = { bp: false, pp: false, nat: false };
  $('entry').hidden = false;
  renderEntryState(computeStats(activeShoe().hands));
}

function closeEntry() {
  $('entry').hidden = true;
  render();
}

/* ---------------- sheets ---------------- */

function openMenu() { updateMenuLabels(); $('menu').hidden = false; }
function openHistory() { renderHistory(); $('history').hidden = false; }
function closeSheets() { $('menu').hidden = true; $('history').hidden = true; }

function updateMenuLabels() {
  $('m-sound-state').textContent = state.settings.sound ? 'On' : 'Off';
  $('m-haptics-state').textContent = state.settings.haptics ? 'On' : 'Off';
  const archived = state.shoes.filter((s) => s.id !== state.activeId && s.hands.length);
  $('m-history-meta').textContent = archived.length
    ? archived.length + ' archived shoe' + (archived.length === 1 ? '' : 's')
    : 'No archived shoes';
}

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch (err) { return ''; }
}

function renderHistory() {
  const list = $('h-list');
  const shoes = state.shoes.filter((s) => s.hands.length);
  if (!shoes.length) {
    list.innerHTML = '<div class="empty-note">No shoes recorded yet.</div>';
    return;
  }
  list.innerHTML = '';
  shoes.forEach((shoe) => {
    const st = computeStats(shoe.hands);
    const isActive = shoe.id === state.activeId;
    const row = document.createElement('div');
    row.className = 'shoe-row';
    row.innerHTML =
      '<div class="sr-main">' +
        '<b>' + fmtDate(shoe.startedAt) + (isActive ? ' · current' : '') + '</b>' +
        '<small>' + st.total + ' hands · B ' + st.B + ' / P ' + st.P + ' / T ' + st.T +
          ' · pairs ' + st.bp + '/' + st.pp + ' · natural ' + st.nat + '</small>' +
      '</div>' +
      '<div class="sr-actions">' +
        (isActive ? '' : '<button class="mini-btn" data-open="' + shoe.id + '">Open</button>') +
        '<button class="mini-btn danger" data-del="' + shoe.id + '">Delete</button>' +
      '</div>';
    list.appendChild(row);
  });

  list.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeId = btn.dataset.open;
      saveState();
      closeSheets();
      render();
      flash('Shoe loaded');
    });
  });
  list.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.del;
      state.shoes = state.shoes.filter((s) => s.id !== id);
      if (state.activeId === id) state.activeId = state.shoes[0] ? state.shoes[0].id : null;
      saveState();
      renderHistory();
      render();
      flash('Shoe deleted');
    });
  });
}

/* ---------------- wiring ---------------- */

function bind() {
  $('btn-add').addEventListener('click', openEntry);
  $('btn-undo').addEventListener('click', undo);
  $('btn-menu').addEventListener('click', openMenu);
  $('e-close').addEventListener('click', closeEntry);
  $('e-undo').addEventListener('click', () => {
    undo();
    renderEntryState(computeStats(activeShoe().hands));
  });
  $('m-close').addEventListener('click', closeSheets);
  $('h-close').addEventListener('click', closeSheets);
  $('m-new').addEventListener('click', newShoe);
  $('m-history').addEventListener('click', () => { closeSheets(); openHistory(); });

  $('m-sound').addEventListener('click', () => {
    state.settings.sound = !state.settings.sound;
    saveState(); updateMenuLabels();
    if (state.settings.sound) tick();
  });
  $('m-haptics').addEventListener('click', () => {
    state.settings.haptics = !state.settings.haptics;
    saveState(); updateMenuLabels(); haptic();
  });

  document.querySelectorAll('.outcome').forEach((btn) => {
    btn.addEventListener('click', () => addHand(btn.dataset.o));
  });

  document.querySelectorAll('.mod').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.mod;
      ui.mods[m] = !ui.mods[m];
      renderEntryState(computeStats(activeShoe().hands));
    });
  });

  ['menu', 'history'].forEach((id) => {
    $(id).addEventListener('click', (ev) => { if (ev.target.id === id) closeSheets(); });
  });

  window.addEventListener('keydown', (ev) => {
    const key = ev.key.toLowerCase();
    const entryOpen = !$('entry').hidden;

    if (key === 'escape') {
      if (entryOpen) closeEntry(); else closeSheets();
      return;
    }

    if (!entryOpen) {
      if (key === 'enter' || key === ' ') { ev.preventDefault(); openEntry(); }
      if ((ev.ctrlKey || ev.metaKey) && key === 'z') { ev.preventDefault(); undo(); }
      return;
    }

    if (key === 'b' || key === '1') addHand('B');
    else if (key === 'p' || key === '2') addHand('P');
    else if (key === 't' || key === '3') addHand('T');
    else if (key === '4') { ui.mods.bp = !ui.mods.bp; renderEntryState(computeStats(activeShoe().hands)); }
    else if (key === '5') { ui.mods.pp = !ui.mods.pp; renderEntryState(computeStats(activeShoe().hands)); }
    else if (key === '6') { ui.mods.nat = !ui.mods.nat; renderEntryState(computeStats(activeShoe().hands)); }
    else if ((ev.ctrlKey || ev.metaKey) && key === 'z') {
      ev.preventDefault();
      undo();
      renderEntryState(computeStats(activeShoe().hands));
    }
  });

  let raf = null;
  const relayout = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => render());
  };
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', () => setTimeout(relayout, 120));
  if (window.visualViewport) window.visualViewport.addEventListener('resize', relayout);
}

/* ---------------- boot ---------------- */

function boot() {
  bind();
  render();
  // fonts / safe-area insets can shift the panels a pixel on first paint
  requestAnimationFrame(() => render());

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => { /* file:// or unsupported */ });
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
