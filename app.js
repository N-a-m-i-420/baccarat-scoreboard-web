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

/**
 * The road engine (Big Road, Big Eye Boy, Small Road, Cockroach Pig and the
 * predictor) lives in roads.js so it can be unit-tested outside the browser:
 *   node tools/test-roads.js
 */
const cellAt = (road, r, c) => road.cells.get(r + ':' + c);

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
 * Board sizing. The rail (bead plate + predictor) and the big road share the top
 * row; the derived roads get the bottom row. Everything is measured from the
 * live DOM so no panel ends up with dead beige space and the big road always
 * shows ~20 columns instead of scrolling straight away.
 */
const MIN_BIG_CELL = 22;
const MAX_BIG_CELL = 72;
const TARGET_BIG_COLS = 20;
const MIN_PRED_H = 66;   // the predictor needs room for 3 mark rows + headers

function headHeight(sel) {
  const el = document.querySelector(sel + ' .panel-head');
  return el ? Math.round(el.getBoundingClientRect().height) : 17;
}

function layoutBoard(hands, road, lays) {
  const board = $('board');
  const GAP = 6;
  const H = Math.max(120, board.clientHeight - 6);       // padding-top only
  const bigW = Math.max(80, $('big-scroll').clientWidth);
  const beadW = Math.max(40, $('bead-scroll').clientWidth);
  const derW = Math.max(60, $('beb-scroll').clientWidth);
  const hBig = headHeight('#p-big');
  const hDer = headHeight('#p-beb');
  const hBead = headHeight('#p-bead');

  // big road: ~TARGET_BIG_COLS columns across, but never so tall that the
  // derived row is squeezed out
  const byWidth = Math.round(bigW / TARGET_BIG_COLS);
  const byHeight = Math.floor((H - GAP - hDer - 14 * 6) / 6);
  const bigCell = Math.max(MIN_BIG_CELL, Math.min(MAX_BIG_CELL, byWidth, byHeight));
  const bigH = hBig + bigCell * 6;

  // derived roads get whatever is left, capped so the marks stay sane
  const derH = Math.max(60, H - GAP - bigH);
  const miniCell = Math.max(8, Math.min(56, Math.floor((derH - hDer - 1) / 6)));
  const derContent = Math.max(lays.beb.colCount, lays.small.colCount, lays.cock.colCount);
  const derCols = Math.max(derContent + 1, Math.ceil(derW / miniCell));

  // bead plate: 6 rows, as many columns as the shoe needs, never taller than the
  // rail minus a usable predictor
  const beadNeeded = Math.max(1, Math.ceil(hands.length / ROWS));
  const beadCell = Math.max(6, Math.min(
    Math.floor((bigH - GAP - hBead - MIN_PRED_H) / 6),
    Math.floor(beadW / beadNeeded),
    44
  ));
  const beadCols = Math.max(beadNeeded, Math.floor(beadW / beadCell));

  const beadH = hBead + beadCell * 6 + 2;
  board.style.gridTemplateRows = bigH + 'px minmax(0, 1fr)';
  $('p-bead').style.height = beadH + 'px';

  // predictor marks scale to the row height that is actually left over, so they
  // never spill out of their chips on a short screen
  const predH = Math.max(46, bigH - GAP - beadH);
  const predInner = Math.max(28, predH - headHeight('#p-pred') - 5);
  const rowH = (predInner - 20) / 3;
  const sym = Math.max(7, Math.min(28, Math.floor(rowH * 0.92)));
  document.documentElement.style.setProperty('--pred-sym', sym + 'px');

  return {
    bigH,
    big: { cell: bigCell, cols: Math.max(road.colCount + 1, Math.ceil(bigW / bigCell)) },
    bead: { cell: beadCell, cols: beadCols, rows: ROWS },
    mini: { cell: miniCell, cols: derCols }
  };
}

function applyCellVars(cells) {
  const root = document.documentElement.style;
  root.setProperty('--cell', cells.big + 'px');
  root.setProperty('--bead', cells.bead + 'px');
  root.setProperty('--mini', cells.mini + 'px');
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

function renderBigRoad(road, cols) {
  const grid = $('bigroad');
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < ROWS; r += 1) {
      const entry = cellAt(road, r, c);
      let inner = '';
      if (entry) {
        inner += `<span class="mk ${entry.side.toLowerCase()}"></span>`;
        if (entry.ties) inner += tieSlashes(entry.ties);
        if (entry.hand && entry.hand.bp) inner += '<i class="corner bp"></i>';
        if (entry.hand && entry.hand.pp) inner += '<i class="corner pp"></i>';
        if (entry.hand && entry.hand.nat) inner += '<i class="corner nat"></i>';
      }
      frag.appendChild(cellEl(r, c, inner));
    }
  }
  grid.appendChild(frag);
  $('big-meta').textContent = road.colCount ? road.columns.length + ' col' : '';
}

function renderDerived(id, laid, cols) {
  const grid = $(id);
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < ROWS; r += 1) {
      const entry = laid.cells.get(r + ':' + c);
      const inner = entry ? `<span class="mk ${entry.m === 'R' ? 'mark-red' : 'mark-blue'}"></span>` : '';
      frag.appendChild(cellEl(r, c, inner));
    }
  }
  grid.appendChild(frag);
}

/**
 * Predictor board: what each derived road would print if the very next hand
 * were a Banker win (left) or a Player win (right). Red = that road would show
 * a repeat, blue = it would show a break. Same engine, one hand ahead.
 */
const PRED_ROWS = ['beb', 'small', 'cock'];

function predSym(kind, mark) {
  if (!mark) return '<i class="psym none"></i>';
  return '<i class="psym ' + kind + ' ' + (mark === 'R' ? 'r' : 'b') + '"></i>';
}

function renderPredictor(pred) {
  let bReds = 0;
  let pReds = 0;
  let known = 0;

  PRED_ROWS.forEach((row) => {
    const b = pred.B[row];
    const p = pred.P[row];
    $('pred-' + row + '-b').innerHTML = predSym(row, b);
    $('pred-' + row + '-p').innerHTML = predSym(row, p);
    if (b || p) known += 1;
    if (b === 'R') bReds += 1;
    if (p === 'R') pReds += 1;
  });

  const foot = $('pred-foot');
  if (!known) {
    foot.className = 'pred-foot dim';
    foot.textContent = 'Needs more columns';
    $('pred-meta').textContent = '';
    return;
  }
  foot.className = 'pred-foot';
  foot.innerHTML =
    '<span class="' + (bReds >= pReds ? 'lead' : '') + '">B&nbsp;' + bReds + '</span>' +
    '<span class="sep">&middot;</span>' +
    '<span class="' + (pReds > bReds ? 'lead' : '') + '">P&nbsp;' + pReds + '</span>';
  foot.title = 'Derived roads that would show a repeat: ' + bReds + ' if Banker, ' + pReds + ' if Player';
  $('pred-meta').textContent = known + '/3';
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

function scrollToEnd(id, cell, contentCols) {
  const box = $(id);
  if (!box) return;
  const max = box.scrollWidth - box.clientWidth;
  if (max <= 0) { box.scrollLeft = 0; return; }
  // land on the newest mark, not on the empty filler columns that pad the panel
  const want = contentCols && cell ? contentCols * cell - box.clientWidth + cell : max;
  const target = Math.max(0, Math.min(max, want));
  // snap to a column boundary so the newest cell sits flush instead of half-cut
  box.scrollLeft = cell ? Math.min(max, Math.ceil(target / cell) * cell) : target;
}

function render(opts = {}) {
  const shoe = activeShoe();
  const hands = shoe.hands;
  const road = Roads.buildRoad(hands);
  const stats = computeStats(hands);

  const lays = {
    beb: Roads.layoutMarks(Roads.derivedMarks(road, 1)),
    small: Roads.layoutMarks(Roads.derivedMarks(road, 2)),
    cock: Roads.layoutMarks(Roads.derivedMarks(road, 3))
  };
  const lay = layoutBoard(hands, road, lays);

  applyCellVars({ big: lay.big.cell, bead: lay.bead.cell, mini: lay.mini.cell });

  renderBead(hands, lay.bead);
  renderBigRoad(road, lay.big.cols);
  renderPredictor(Roads.predictor(road));
  renderDerived('beb', lays.beb, lay.mini.cols);
  renderDerived('smallroad', lays.small, lay.mini.cols);
  renderDerived('cockroad', lays.cock, lay.mini.cols);
  renderStats(stats);
  renderEntryState(stats);

  $('btn-undo').disabled = hands.length === 0;
  $('e-undo').disabled = hands.length === 0;

  requestAnimationFrame(() => {
    scrollToEnd('big-scroll', lay.big.cell, road.columns.length);
    scrollToEnd('beb-scroll', lay.mini.cell, lays.beb.colCount);
    scrollToEnd('small-scroll', lay.mini.cell, lays.small.colCount);
    scrollToEnd('cock-scroll', lay.mini.cell, lays.cock.colCount);
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
