#!/usr/bin/env node
/* Bake the Langley kitchen board.
 *
 * Reads the pristine template (langley-board.template.html) and three raw
 * Google Calendar dumps, then writes langley-board.baked.html — the same board
 * with a static calendar snapshot spliced in place of the live window.claude /
 * MCP layer, so it renders on a plain browser (the kitchen Raspberry Pi) with
 * no Claude login.
 *
 * Inputs (same directory):
 *   langley-board.template.html   — pristine original artifact source
 *   cal-primary.json              — list_events on jesslangley4@gmail.com   (~21 days)
 *   cal-alex.json                 — list_events on alex.langley90@gmail.com (~56 days)
 *   cal-arsenal.json              — list_events on the Arsenal fixtures calendar (~45 days)
 * Each JSON file is the raw tool response; we use its `.events` array.
 *
 * Output:
 *   index.html                   — GitHub Pages serves this
 *
 * Usage:  node bake.js
 */
const fs = require('fs');
const path = require('path');
const DIR = __dirname;

const F = (n) => path.join(DIR, n);
const readJSON = (n) => JSON.parse(fs.readFileSync(F(n), 'utf8'));

function evStartMs(ev) {
  const s = ev.start || {};
  if (s.dateTime) return new Date(s.dateTime).getTime();
  if (s.date) return new Date(s.date.indexOf('T') !== -1 ? s.date : s.date + 'T00:00:00').getTime();
  return 0;
}

// keep only the fields the board actually reads
function trim(ev) {
  const o = { summary: ev.summary || '', start: ev.start, end: ev.end, status: ev.status || 'confirmed' };
  if (ev.location) o.location = ev.location;
  if (ev.colorId) o.colorId = ev.colorId;
  if (ev.description) {
    // the board only uses description.split('|')[0] (the competition name);
    // keep the first few segments, drop the ecal marketing tail
    o.description = String(ev.description).split('\n')[0].split('|').slice(0, 3).join('|').trim();
  }
  return o;
}

const now = new Date();
const horizon = (days) => now.getTime() + days * 86400000;

const primaryAll = (readJSON('cal-primary.json').events || []).map(trim).sort((a, b) => evStartMs(a) - evStartMs(b));
const alexAll = (readJSON('cal-alex.json').events || []).map(trim).sort((a, b) => evStartMs(a) - evStartMs(b));
const arsenalAll = (readJSON('cal-arsenal.json').events || []).map(trim).sort((a, b) => evStartMs(a) - evStartMs(b));

const BAKED = {
  generatedISO: now.toISOString(),
  primary: primaryAll.filter((e) => evStartMs(e) < horizon(9)),
  familyTicker: primaryAll.filter((e) => evStartMs(e) < horizon(21)),
  alex: alexAll,
  arsenal: arsenalAll.filter((e) => /\(H\)|\(A\)/.test(e.summary) && !/ticket/i.test(e.summary)),
};

let html = fs.readFileSync(F('langley-board.template.html'), 'utf8');

// Patch 1 — inject the snapshot after the ALEX_WINDOW_DAYS config line
const a1 = 'var ALEX_WINDOW_DAYS = 56; // ~8 weeks — Jessica only wants near-term visibility for Alex';
if (!html.includes(a1)) throw new Error('template drifted: anchor 1 not found');
html = html.replace(
  a1,
  a1 +
    '\n\n  /* ---- BAKED calendar snapshot (written by the langley-board-refresh task) ----\n' +
    '     The board reads this instead of calling window.claude / MCP, so it renders\n' +
    '     on a plain browser (the kitchen Raspberry Pi) with no Claude login. */\n' +
    '  var BAKED = ' + JSON.stringify(BAKED, null, 2).replace(/\n/g, '\n  ') + ';\n'
);

// Patch 2 — replace the live MCP block in init() with the baked feed
const s = html.indexOf("    try {\n      mcp = (window.claude && window.claude.use)");
const endMarker =
  "    document.getElementById('refreshBtn').addEventListener('click', function(){\n" +
  "      mcp.invalidate('Google Calendar', 'list_events').catch(function(){});\n    });";
const e = html.indexOf(endMarker);
if (s === -1 || e === -1) throw new Error('template drifted: init markers not found');
html =
  html.slice(0, s) +
  "    // ---- Baked calendar snapshot — no live Claude/MCP connection ----\n" +
  "    var mkResult = function(list){\n" +
  "      return { type: 'data', result: { payload: { events: list || [] }, cache: { storedAt: BAKED.generatedISO } } };\n" +
  "    };\n" +
  "    handleWatch(mkResult(BAKED.primary));\n" +
  "    handleArsenalWatch(mkResult(BAKED.arsenal));\n" +
  "    handleAlexWatch(mkResult(BAKED.alex));\n" +
  "    if (IS_KIOSK) handleFamilyTickerWatch(mkResult(BAKED.familyTicker));\n\n" +
  "    var rb = document.getElementById('refreshBtn');\n" +
  "    if (rb) rb.style.display = 'none';\n" +
  html.slice(e + endMarker.length);

// Patch 3 — footer wording: it's a snapshot, not a live feed
html = html.replace(
  "el.textContent = 'CALENDAR UPDATED ' + t + (revalidating ? ' (refreshing…)' : '');",
  "el.textContent = 'CALENDAR SNAPSHOT ' + date.toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });"
);

// Patch 4 — distinct title so it doesn't clash with the live board in the gallery
html = html.replace('<title>Langley Departures</title>', '<title>Langley Kitchen Board</title>');

// Patch 5 — the kiosk browser loads this page once and keeps it; reload every
// 20 min so it picks up the newer snapshot the refresh task republishes.
html = html.replace(
  '  init();\n})();',
  "  init();\n  setTimeout(function(){ try { location.reload(); } catch (e) {} }, 20 * 60 * 1000);\n})();"
);

// Patch 6 — kitchen Pi screen is 800x480; the stock kiosk layout leaves a
// dead strip at the bottom. Nudge the root size up so the board fills it.
html = html.replace(
  '@media (max-width:900px) and (max-height:560px){\n    :root{ font-size:13px; }',
  '@media (max-width:900px) and (max-height:560px){\n    :root{ font-size:14px; }'
);
if (!html.includes('and (max-height:560px){\n    :root{ font-size:14px; }')) {
  throw new Error('bake failed: kiosk font-size patch did not apply');
}

if (html.includes('window.claude.use')) throw new Error('bake failed: window.claude.use still present');
if (!html.includes('location.reload')) throw new Error('bake failed: reload patch did not apply');

fs.writeFileSync(F('index.html'), html); // GitHub Pages serves this
console.log(
  'baked OK — ' + html.length + ' bytes | primary=' + BAKED.primary.length +
  ' familyTicker=' + BAKED.familyTicker.length + ' alex=' + BAKED.alex.length +
  ' arsenal=' + BAKED.arsenal.length + ' | generated ' + BAKED.generatedISO
);
