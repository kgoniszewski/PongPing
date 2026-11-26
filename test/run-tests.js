// Testy: node test/run-tests.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ClipperLib: CL, NestCore, Geometry, CadParse, Samples } = require('./load');
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'dxfwrite.js'), 'utf8'));
const DxfWrite = globalThis.DxfWrite;

let failed = 0, passed = 0;
function test(name, fn) {
  const t0 = Date.now();
  try { fn(); passed++; console.log(`ok   ${name} (${Date.now() - t0} ms)`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.stack || e}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'asercja nie spełniona'); }
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || ''} oczekiwano ${b}, jest ${a} (tol ${tol})`); }

const S = 100;
// Sprawdza, że rzeczywiste kształty (bez odstępu) nie nachodzą na siebie, zachowują
// zadany odstęp i mieszczą się w arkuszu z marginesem.
function checkLayout(result, parts, sheets, spacing, margin) {
  let issues = 0;
  result.sheets.forEach((sh, si) => {
    const def = sheets[sh.t];
    const polys = sh.placements.map(pl => {
      const p = parts[pl.pi];
      const th = pl.deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const tr = pts => pts.map(q => ({ X: Math.round((q[0] * c - q[1] * s + pl.dx) * S), Y: Math.round((q[0] * s + q[1] * c + pl.dy) * S) }));
      const o = tr(p.outer); if (CL.Clipper.Area(o) < 0) o.reverse();
      const hs = p.holes.map(h => { const t = tr(h); if (CL.Clipper.Area(t) > 0) t.reverse(); return t; });
      return [o, ...hs];
    });
    polys.forEach((pp, i) => {
      for (const q of pp[0]) {
        if (q.X < (margin - 0.02) * S || q.Y < (margin - 0.02) * S || q.X > (def.w - margin + 0.02) * S || q.Y > (def.h - margin + 0.02) * S) { issues++; break; }
      }
      const co = new CL.ClipperOffset(2, 5);
      co.AddPaths(pp, CL.JoinType.jtRound, CL.EndType.etClosedPolygon);
      const grown = new CL.Paths(); co.Execute(grown, Math.max(0, spacing - 0.05) * S);
      for (let j = i + 1; j < polys.length; j++) {
        const c = new CL.Clipper(); c.AddPaths(grown, 0, true); c.AddPaths(polys[j], 1, true);
        const sol = new CL.Paths(); c.Execute(CL.ClipType.ctIntersection, sol, CL.PolyFillType.pftNonZero, CL.PolyFillType.pftNonZero);
        const a = sol.reduce((s, p) => s + Math.abs(CL.Clipper.Area(p)), 0) / S / S;
        if (a > 0.01) issues++;
      }
    });
  });
  return issues;
}

function orderByArea(parts) {
  const o = []; parts.forEach((p, i) => { for (let k = 0; k < (p.qty || 1); k++) o.push(i); });
  return o.sort((a, b) => Math.abs(Geometry.polyArea(parts[b].outer)) - Math.abs(Geometry.polyArea(parts[a].outer)));
}

/* ------------------------------------------------------------------ nesting */

test('przykładowe detale: brak kolizji, obroty co 45°, dwa formaty arkuszy', () => {
  const parts = Samples.build(Geometry, { tol: 0.05, joinTol: 0.05 }).map(p => Object.assign(p, { rots: [0, 45, 90, 135, 180, 225, 270, 315] }));
  const sheets = [{ w: 1500, h: 1000, count: 1 }, { w: 2000, h: 1000, count: -1 }];
  const n = NestCore.createNester(parts, sheets, { spacing: 3, margin: 5 });
  const r = n.nest(orderByArea(parts));
  assert(r.unplaced.length === 0, 'nie wszystkie detale rozmieszczone');
  assert(r.sheets[0].t === 0 && r.sheets.slice(1).every(s => s.t === 1), 'zła kolejność formatów');
  const bad = checkLayout(r, parts, sheets, 3, 5);
  assert(bad === 0, `${bad} naruszeń odstępu/granic`);
});

test('losowe kształty wklęsłe z otworami: brak kolizji', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const parts = [];
  for (let k = 0; k < 8; k++) {
    const n = 5 + Math.floor(rnd() * 6), R = 40 + rnd() * 80;
    const outer = [];
    for (let i = 0; i < n * 2; i++) {
      const a = i / (n * 2) * Math.PI * 2, r = i % 2 ? R * (0.45 + rnd() * 0.3) : R;
      outer.push([R + r * Math.cos(a), R + r * Math.sin(a)]);
    }
    const holes = k % 3 === 0 ? [Geometry.arcPoints([R, R], R * 0.3, 0, Math.PI * 2, 0.1, true).slice(0, -1).reverse()] : [];
    parts.push({ outer, holes, rots: [0, 90, 180, 270], qty: 4 });
  }
  parts.push({ outer: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [], rots: [0], qty: 20 });
  const sheets = [{ w: 1000, h: 600, count: -1 }];
  const n = NestCore.createNester(parts, sheets, { spacing: 2, margin: 0 });
  const r = n.nest(orderByArea(parts));
  assert(r.unplaced.length === 0, 'nie wszystkie detale rozmieszczone');
  const bad = checkLayout(r, parts, sheets, 2, 0);
  assert(bad === 0, `${bad} naruszeń`);
});

test('małe detale trafiają do otworów dużych', () => {
  const ring = { outer: Geometry.arcPoints([150, 150], 150, 0, Math.PI * 2, 0.05, true).slice(0, -1), holes: [Geometry.arcPoints([150, 150], 110, 0, Math.PI * 2, 0.05, true).slice(0, -1).reverse()], rots: [0], qty: 1 };
  const disc = { outer: Geometry.arcPoints([30, 30], 30, 0, Math.PI * 2, 0.05, true).slice(0, -1), holes: [], rots: [0], qty: 6 };
  const parts = [ring, disc];
  const sheets = [{ w: 310, h: 310, count: 1 }];
  const n = NestCore.createNester(parts, sheets, { spacing: 2, margin: 2 });
  const r = n.nest(orderByArea(parts));
  assert(r.unplaced.length === 0, 'krążki nie zmieściły się w pierścieniu');
  assert(checkLayout(r, parts, sheets, 2, 2) === 0, 'kolizje');
});

test('detal większy niż arkusz zostaje na liście nierozmieszczonych', () => {
  const parts = [{ outer: [[0, 0], [500, 0], [500, 500], [0, 500]], holes: [], rots: [0], qty: 1 }, { outer: [[0, 0], [50, 0], [50, 50], [0, 50]], holes: [], rots: [0], qty: 2 }];
  const n = NestCore.createNester(parts, [{ w: 400, h: 400, count: -1 }], { spacing: 0, margin: 0 });
  const r = n.nest([0, 1, 1]);
  assert(r.unplaced.length === 1 && r.unplaced[0] === 0 && r.placedCount === 2);
});

test('prostokąty na styk wypełniają arkusz bez odpadu', () => {
  const parts = [{ outer: [[0, 0], [100, 0], [100, 50], [0, 50]], holes: [], rots: [0, 90], qty: 20 }];
  const n = NestCore.createNester(parts, [{ w: 500, h: 200, count: -1 }], { spacing: 0, margin: 0 });
  const r = n.nest(new Array(20).fill(0));
  assert(r.sheets.length === 1 && r.unplaced.length === 0, `arkuszy: ${r.sheets.length}, nierozm.: ${r.unplaced.length}`);
});

test('obrys przecinający sam siebie jest bezpiecznie obejmowany', () => {
  const bow = [[655.29, 1014.09], [549.6, 802.82], [147.97, 570.42], [0, 0]];
  const parts = [{ outer: bow, holes: [], rots: [0, 90], qty: 1 }, { outer: [[0, 0], [100, 0], [100, 100], [0, 100]], holes: [], rots: [0], qty: 30 }];
  const sheets = [{ w: 2000, h: 1100, count: -1 }];
  const n = NestCore.createNester(parts, sheets, { spacing: 5, margin: 10 });
  const r = n.nest([0].concat(new Array(30).fill(1)));
  assert(r.unplaced.length === 0);
  // sprawdzamy granice arkusza dla wszystkich wierzchołków
  for (const sh of r.sheets) for (const pl of sh.placements) {
    const th = pl.deg * Math.PI / 180;
    for (const q of parts[pl.pi].outer) {
      const x = q[0] * Math.cos(th) - q[1] * Math.sin(th) + pl.dx, y = q[0] * Math.sin(th) + q[1] * Math.cos(th) + pl.dy;
      assert(x > 9.9 && y > 9.9 && x < 1990.1 && y < 1090.1, `wierzchołek poza arkuszem: ${x.toFixed(1)}, ${y.toFixed(1)}`);
    }
  }
});

/* ------------------------------------------------------------------ import DXF */

function load(name) {
  const model = CadParse.parseDXF(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
  return Geometry.buildParts(model, name, { tol: 0.01, joinTol: 0.05, scale: CadParse.unitFactor(model.insunits) });
}

test('DXF: łuki z bulge, ARC+LINE, okrąg; tekst i wymiar pomijane', () => {
  const { parts } = load('plyta.dxf');
  assert(parts.length === 1, 'oczekiwano 1 detalu');
  const p = parts[0];
  near(p.w, 200, 0.01); near(p.h, 100, 0.01);
  near(p.area, 18485.84, 2, 'pole');
  assert(p.holes.length === 2);
});

test('DXF: bloki z obrotem, lustrem i skalą, jednostki calowe', () => {
  const { parts } = load('bloki_cale.dxf');
  const areas = parts.map(p => p.area).sort((a, b) => a - b);
  assert(parts.length === 3);
  near(areas[0], 6324.92, 2); near(areas[1], 6324.92, 2); near(areas[2], 25299.69, 5);
});

test('DXF: encje w OCS (normalna 0,0,-1)', () => {
  const { parts } = load('ocs.dxf');
  const byArea = parts.map(p => p.area).sort((a, b) => a - b);
  assert(parts.length === 2, 'półkole z cięciwą powinno być domknięte');
  near(byArea[0], 2400, 0.5); near(byArea[1], 3926.99, 3);
});

test('DXF: splajn zamknięty i elipsa z otworem', () => {
  const model = CadParse.parseDXF(fs.readFileSync(path.join(__dirname, 'fixtures', 'splajn_elipsa.dxf'), 'utf8'));
  const { parts } = Geometry.buildParts(model, 'x', { tol: 0.01, joinTol: 0.05, scale: 1 }); // wymuszone mm
  assert(parts.length === 2);
  const el = parts.find(p => p.holes.length === 1);
  near(el.area, Math.PI * 80 * 40 - Math.PI * 225, 3);
  assert(el.marks.length === 1, 'linia wewnątrz elipsy powinna być grawerem');
});

/* ------------------------------------------------------------------ eksport DXF */

test('eksport DXF i ponowny import zachowują detale i pola', () => {
  const parts = Samples.build(Geometry, { tol: 0.05, joinTol: 0.05 }).map(p => Object.assign(p, { rots: [0, 30, 90, 270] }));
  const n = NestCore.createNester(parts, [{ w: 2500, h: 1250, count: -1 }], { spacing: 4, margin: 10 });
  const r = n.nest(orderByArea(parts));
  const sheets = r.sheets.map((s, i) => ({ W: 2500, H: 1250, offsetY: i * 1500, placements: s.placements.map(pl => ({ part: parts[pl.pi], deg: pl.deg, dx: pl.dx, dy: pl.dy })) }));
  const txt = DxfWrite.build(sheets, { labels: true });
  const model = CadParse.parseDXF(txt);
  const { parts: back } = Geometry.buildParts(model, 'b', { tol: 0.05, joinTol: 0.05, skipLayers: ['ARKUSZ', 'OPISY'] });
  const cnt = back.reduce((s, p) => s + p.qty, 0);
  const placed = r.sheets.reduce((s, x) => s + x.placements.length, 0);
  assert(cnt === placed, `liczba detali po imporcie ${cnt} ≠ ${placed}`);
  const a1 = back.reduce((s, p) => s + p.area * p.qty, 0);
  const a2 = r.sheets.reduce((s, x) => s + x.placements.reduce((t, pl) => t + parts[pl.pi].area, 0), 0);
  near(a1, a2, a2 * 1e-4, 'suma pól');
});

console.log(`\n${passed} zaliczonych, ${failed} niezaliczonych`);
process.exit(failed ? 1 : 0);
