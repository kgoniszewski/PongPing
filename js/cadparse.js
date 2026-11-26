/*
 * Odczyt plików CAD (DXF – własny parser, DWG – LibreDWG/WASM ładowany na żądanie)
 * i sprowadzenie ich do wspólnej, prostej reprezentacji encji:
 *
 *   { t:'line',    a:[x,y], b:[x,y] }
 *   { t:'arc',     c:[x,y], r, a0, a1 }            // kąty w radianach, kierunek CCW od a0 do a1
 *   { t:'circle',  c:[x,y], r }
 *   { t:'poly',    pts:[[x,y,bulge],...], closed }
 *   { t:'ellipse', c:[x,y], maj:[x,y], ratio, a0, a1 }
 *   { t:'spline',  deg, knots, ctrl:[[x,y]], w:[...]|null, fit:[[x,y]], closed }
 *   { t:'insert',  name, p:[x,y], sx, sy, rot, cols, rows, cs, rs }
 *
 * Wynik: { entities:[...], blocks:{ NAZWA:{ base:[x,y], entities:[...] } }, insunits }
 */
(function (global) {
  'use strict';

  const DEG = Math.PI / 180;

  /* ------------------------------------------------------------------ DXF */

  function tokenize(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (Number.isNaN(code)) { i -= 1; continue; } // rozjechana para – spróbuj zsynchronizować się linię niżej
      pairs.push([code, lines[i + 1]]);
    }
    return pairs;
  }

  function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

  // Grupuje pary w "obiekty" zaczynające się od kodu 0.
  function groupObjects(pairs, start, end) {
    const objs = [];
    let cur = null;
    for (let i = start; i < end; i++) {
      const [c, v] = pairs[i];
      if (c === 0) { cur = { type: v.trim(), g: [] }; objs.push(cur); }
      else if (cur) cur.g.push([c, v]);
    }
    return objs;
  }

  function first(g, code, def) {
    for (const [c, v] of g) if (c === code) return v;
    return def;
  }
  function firstNum(g, code, def) {
    for (const [c, v] of g) if (c === code) return num(v);
    return def;
  }

  // Obsługa wektora wytłaczania (OCS). Dla Z = -1 (najczęstszy przypadek "odwróconych" encji) lustrujemy X.
  function ocsFlip(g) {
    const ez = firstNum(g, 230, 1);
    return ez < 0;
  }

  function convertDxfEntity(o, objs, idx) {
    const g = o.g;
    const layer = (first(g, 8, '0') || '0').trim();
    const flip = ocsFlip(g);
    const fx = flip ? -1 : 1;
    let e = null;
    switch (o.type) {
      case 'LINE':
        e = { t: 'line', a: [firstNum(g, 10, 0), firstNum(g, 20, 0)], b: [firstNum(g, 11, 0), firstNum(g, 21, 0)] };
        break;
      case 'CIRCLE':
        e = { t: 'circle', c: [fx * firstNum(g, 10, 0), firstNum(g, 20, 0)], r: firstNum(g, 40, 0) };
        break;
      case 'ARC': {
        let a0 = firstNum(g, 50, 0) * DEG, a1 = firstNum(g, 51, 0) * DEG;
        const c = [firstNum(g, 10, 0), firstNum(g, 20, 0)];
        if (flip) { c[0] = -c[0]; const t0 = Math.PI - a1, t1 = Math.PI - a0; a0 = t0; a1 = t1; }
        e = { t: 'arc', c, r: firstNum(g, 40, 0), a0, a1 };
        break;
      }
      case 'LWPOLYLINE': {
        const pts = [];
        const flags = firstNum(g, 70, 0);
        let p = null;
        for (const [c, v] of g) {
          if (c === 10) { p = [num(v), 0, 0]; pts.push(p); }
          else if (c === 20 && p) p[1] = num(v);
          else if (c === 42 && p) p[2] = num(v);
        }
        if (flip) for (const q of pts) { q[0] = -q[0]; q[2] = -q[2]; }
        e = { t: 'poly', pts, closed: (flags & 1) === 1 };
        break;
      }
      case 'POLYLINE': {
        const flags = firstNum(g, 70, 0);
        const pts = [];
        let j = idx + 1;
        for (; j < objs.length && objs[j].type === 'VERTEX'; j++) {
          const vg = objs[j].g;
          const vf = firstNum(vg, 70, 0);
          if (vf & 16) continue; // punkt kontrolny splajnu – pomijamy
          pts.push([firstNum(vg, 10, 0), firstNum(vg, 20, 0), firstNum(vg, 42, 0)]);
        }
        if (flags & (16 | 64)) return { e: null, skip: j - idx }; // siatki 3D – pomijamy
        if (flip) for (const q of pts) { q[0] = -q[0]; q[2] = -q[2]; }
        e = { t: 'poly', pts, closed: (flags & 1) === 1 };
        return { e: e && Object.assign(e, { layer }), skip: j - idx };
      }
      case 'ELLIPSE': {
        e = {
          t: 'ellipse', c: [firstNum(g, 10, 0), firstNum(g, 20, 0)], maj: [firstNum(g, 11, 1), firstNum(g, 21, 0)],
          ratio: firstNum(g, 40, 1), a0: firstNum(g, 41, 0), a1: firstNum(g, 42, Math.PI * 2)
        };
        // środek i oś wielka są w WCS; ujemna normalna odwraca kierunek parametru
        if (flip) { const t0 = -e.a1, t1 = -e.a0; e.a0 = t0; e.a1 = t1; }
        break;
      }
      case 'SPLINE': {
        const flags = firstNum(g, 70, 0);
        const knots = [], ctrl = [], fit = [], w = [];
        let cp = null, fp = null;
        for (const [c, v] of g) {
          if (c === 40) knots.push(num(v));
          else if (c === 41) w.push(num(v));
          else if (c === 10) { cp = [num(v), 0]; ctrl.push(cp); }
          else if (c === 20 && cp) cp[1] = num(v);
          else if (c === 11) { fp = [num(v), 0]; fit.push(fp); }
          else if (c === 21 && fp) fp[1] = num(v);
        }
        e = { t: 'spline', deg: firstNum(g, 71, 3), knots, ctrl, w: w.length === ctrl.length ? w : null, fit, closed: (flags & 1) === 1 };
        break;
      }
      case 'INSERT': {
        e = {
          t: 'insert', name: (first(g, 2, '') || '').trim(), p: [firstNum(g, 10, 0), firstNum(g, 20, 0)],
          sx: firstNum(g, 41, 1), sy: firstNum(g, 42, 1), rot: firstNum(g, 50, 0) * DEG,
          cols: Math.max(1, firstNum(g, 70, 1)), rows: Math.max(1, firstNum(g, 71, 1)), cs: firstNum(g, 44, 0), rs: firstNum(g, 45, 0)
        };
        if (flip) { e.p[0] = -e.p[0]; e.sx = -e.sx; e.rot = -e.rot; } // M·T·R(θ)·S = T(Mp)·R(-θ)·S(-sx,sy)
        break;
      }
      case 'SOLID': case 'TRACE': {
        // wypełnione trójkąty/czworokąty – traktujemy jak zamknięty wielokąt
        const p = [[firstNum(g, 10, 0), firstNum(g, 20, 0)], [firstNum(g, 11, 0), firstNum(g, 21, 0)], [firstNum(g, 13, 0), firstNum(g, 23, 0)], [firstNum(g, 12, 0), firstNum(g, 22, 0)]];
        e = { t: 'poly', pts: p.map(q => [q[0], q[1], 0]), closed: true };
        break;
      }
      default:
        return { e: null, skip: 1 };
    }
    if (e) e.layer = layer;
    return { e, skip: 1 };
  }

  function convertList(objs, from, to) {
    const out = [];
    for (let i = from; i < to;) {
      const { e, skip } = convertDxfEntity(objs[i], objs, i);
      if (e) out.push(e);
      i += Math.max(1, skip);
    }
    return out;
  }

  function parseDXF(text) {
    if (/^AutoCAD Binary DXF/.test(text.slice(0, 22))) throw new Error('Binarny DXF nie jest obsługiwany – zapisz plik jako DXF ASCII.');
    const pairs = tokenize(text);
    const res = { entities: [], blocks: {}, insunits: 0 };
    // Podział na sekcje
    let i = 0;
    while (i < pairs.length) {
      if (pairs[i][0] === 0 && pairs[i][1].trim() === 'SECTION' && pairs[i + 1] && pairs[i + 1][0] === 2) {
        const name = pairs[i + 1][1].trim();
        let j = i + 2;
        while (j < pairs.length && !(pairs[j][0] === 0 && pairs[j][1].trim() === 'ENDSEC')) j++;
        if (name === 'HEADER') {
          for (let k = i + 2; k < j; k++) {
            if (pairs[k][0] === 9 && pairs[k][1].trim() === '$INSUNITS' && pairs[k + 1]) res.insunits = num(pairs[k + 1][1]);
          }
        } else if (name === 'ENTITIES') {
          const objs = groupObjects(pairs, i + 2, j);
          res.entities = convertList(objs, 0, objs.length);
        } else if (name === 'BLOCKS') {
          const objs = groupObjects(pairs, i + 2, j);
          for (let k = 0; k < objs.length; k++) {
            if (objs[k].type !== 'BLOCK') continue;
            const bname = (first(objs[k].g, 2, '') || '').trim();
            const base = [firstNum(objs[k].g, 10, 0), firstNum(objs[k].g, 20, 0)];
            let m = k + 1;
            while (m < objs.length && objs[m].type !== 'ENDBLK') m++;
            res.blocks[bname] = { base, entities: convertList(objs, k + 1, m) };
            k = m;
          }
        }
        i = j + 1;
      } else i++;
    }
    return res;
  }

  /* ------------------------------------------------------------------ DWG (LibreDWG WASM) */

  const LIBREDWG_VERSION = '0.8.8';
  const LIBREDWG_BASE = 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@' + LIBREDWG_VERSION + '/';
  let libredwgPromise = null;

  function loadLibreDwg() {
    if (!libredwgPromise) {
      libredwgPromise = import(LIBREDWG_BASE + 'dist/libredwg-web.js')
        .then(m => m.LibreDwg.create(LIBREDWG_BASE + 'wasm').then(lib => ({ lib, m })))
        .catch(err => { libredwgPromise = null; throw err; });
    }
    return libredwgPromise;
  }

  const p2 = p => [p && p.x || 0, p && p.y || 0];

  function convertDwgEntity(d) {
    if (!d || d.isInPaperSpace) return null;
    const flip = d.extrusionDirection && d.extrusionDirection.z < 0;
    const fx = flip ? -1 : 1;
    let e = null;
    switch (d.type) {
      case 'LINE': e = { t: 'line', a: p2(d.startPoint), b: p2(d.endPoint) }; break;
      case 'CIRCLE': e = { t: 'circle', c: [fx * d.center.x, d.center.y], r: d.radius }; break;
      case 'ARC': {
        let a0 = d.startAngle, a1 = d.endAngle; const c = p2(d.center);
        if (flip) { c[0] = -c[0]; const t0 = Math.PI - a1, t1 = Math.PI - a0; a0 = t0; a1 = t1; }
        e = { t: 'arc', c, r: d.radius, a0, a1 }; break;
      }
      case 'LWPOLYLINE': {
        const pts = (d.vertices || []).map(v => [fx * v.x, v.y, fx * (v.bulge || 0)]);
        e = { t: 'poly', pts, closed: (d.flag & 1) === 1 }; break;
      }
      case 'POLYLINE2D': case 'POLYLINE3D': {
        if (d.flag & (16 | 64)) return null;
        const pts = (d.vertices || []).filter(v => !((v.flag || 0) & 16)).map(v => [fx * v.x, v.y, fx * (v.bulge || 0)]);
        e = { t: 'poly', pts, closed: (d.flag & 1) === 1 }; break;
      }
      case 'ELLIPSE':
        e = { t: 'ellipse', c: p2(d.center), maj: p2(d.majorAxisEndPoint), ratio: d.axisRatio, a0: flip ? -d.endAngle : d.startAngle, a1: flip ? -d.startAngle : d.endAngle };
        break;
      case 'SPLINE':
        e = {
          t: 'spline', deg: d.degree, knots: d.knots || [], ctrl: (d.controlPoints || []).map(p2),
          w: d.weights && d.weights.length === (d.controlPoints || []).length ? d.weights : null,
          fit: (d.fitPoints || []).map(p2), closed: (d.flag & 1) === 1
        };
        break;
      case 'INSERT':
        e = {
          t: 'insert', name: d.name, p: [fx * d.insertionPoint.x, d.insertionPoint.y], sx: fx * (d.xScale || 1), sy: d.yScale || 1,
          rot: flip ? -(d.rotation || 0) : (d.rotation || 0), cols: Math.max(1, d.columnCount || 1), rows: Math.max(1, d.rowCount || 1),
          cs: d.columnSpacing || 0, rs: d.rowSpacing || 0
        };
        break;
      case 'SOLID': case 'TRACE': {
        const c = ['corner1', 'corner2', 'corner4', 'corner3'].map(k => d[k]).filter(Boolean);
        if (c.length >= 3) e = { t: 'poly', pts: c.map(p => [p.x, p.y, 0]), closed: true };
        break;
      }
      default: return null;
    }
    if (e) e.layer = d.layer || '0';
    return e;
  }

  function dwgDatabaseToModel(db) {
    const res = { entities: [], blocks: {}, insunits: (db.header && db.header.INSUNITS) || 0 };
    for (const d of db.entities || []) { const e = convertDwgEntity(d); if (e) res.entities.push(e); }
    const recs = (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [];
    for (const r of recs) {
      if (!r || !r.name || /^\*(model|paper)_space/i.test(r.name)) continue;
      const ents = [];
      for (const d of r.entities || []) { const e = convertDwgEntity(d); if (e) ents.push(e); }
      res.blocks[r.name] = { base: p2(r.basePoint), entities: ents };
    }
    return res;
  }

  async function parseDWG(arrayBuffer) {
    let mod;
    try { mod = await loadLibreDwg(); }
    catch (err) { throw new Error('Nie udało się załadować modułu DWG (LibreDWG) – sprawdź połączenie z internetem lub zapisz plik jako DXF. (' + err.message + ')'); }
    const { lib, m } = mod;
    const ptr = lib.dwg_read_data(arrayBuffer, m.Dwg_File_Type.DWG);
    if (ptr == null) throw new Error('LibreDWG nie potrafił odczytać pliku DWG.');
    try { return dwgDatabaseToModel(lib.convert(ptr)); }
    finally { try { lib.dwg_free(ptr); } catch (_) { /* ignoruj */ } }
  }

  /* ------------------------------------------------------------------ Jednostki */

  // $INSUNITS → mnożnik do milimetrów
  const UNIT_TO_MM = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 14: 100 };

  function unitFactor(insunits, override) {
    if (override && override !== 'auto') return { mm: 1, cm: 10, m: 1000, in: 25.4 }[override] || 1;
    return UNIT_TO_MM[insunits] || 1;
  }

  global.CadParse = { parseDXF, parseDWG, dwgDatabaseToModel, unitFactor, LIBREDWG_BASE };
})(typeof window !== 'undefined' ? window : globalThis);
