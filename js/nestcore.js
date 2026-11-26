/*
 * Rdzeń algorytmu nestingu (rozmieszczania detali na arkuszach).
 *
 * Metoda:
 *  - każdy detal jest powiększany o połowę odstępu (offset), upraszczany (RDP) i ponownie
 *    powiększany o tolerancję uproszczenia — tak, aby uproszczony obrys zawsze obejmował
 *    rzeczywisty kształt (bez ryzyka kolizji),
 *  - dla par (detal nieruchomy A, detal ruchomy B, z ich obrotami) liczony jest wielokąt
 *    No-Fit-Polygon (NFP) = A ⊕ (−B) za pomocą sumy Minkowskiego (unia równoległoboków
 *    krawędź×krawędź + wnętrza), z "wycięciami" w miejscach, gdzie B mieści się w całości
 *    wewnątrz otworu A (umożliwia wkładanie małych detali w otwory dużych),
 *  - obszar dopuszczalnych położeń = prostokąt Inner-Fit arkusza minus suma NFP już
 *    rozłożonych detali; kandydatami są wierzchołki tego obszaru, a wybierany jest ten
 *    o najlepszej ocenie (np. najmniejsza zużyta długość arkusza, potem najniżej/najbardziej w lewo),
 *  - dla każdego detalu sprawdzane są wszystkie dozwolone obroty,
 *  - kolejność wkładania detali optymalizuje algorytm genetyczny (po stronie wątku głównego).
 *
 * Funkcja-fabryka jest serializowana (toString) i wstrzykiwana do Web Workerów.
 */
function NestCoreFactory(ClipperLib) {
  'use strict';

  const CL = ClipperLib;
  const PT = CL.PolyType, CT = CL.ClipType, PFT = CL.PolyFillType;

  /* ---------------------------------------------------------------- pomocnicze */

  function areaOf(path) { return CL.Clipper.Area(path); }

  function rdp(pts, eps) { // pts: [{X,Y}] otwarte
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const A = pts[a], B = pts[b];
      const dx = B.X - A.X, dy = B.Y - A.Y;
      const L = Math.hypot(dx, dy) || 1e-12;
      let md = -1, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((pts[i].X - A.X) * dy - (pts[i].Y - A.Y) * dx) / L;
        if (d > md) { md = d; mi = i; }
      }
      if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function rdpClosed(path, eps) {
    if (path.length <= 4 || eps <= 0) return path.slice();
    // najdalszy punkt od pierwszego jako drugi punkt podziału
    let far = 0, fd = -1;
    for (let i = 1; i < path.length; i++) {
      const d = (path[i].X - path[0].X) ** 2 + (path[i].Y - path[0].Y) ** 2;
      if (d > fd) { fd = d; far = i; }
    }
    const a = rdp(path.slice(0, far + 1), eps);
    const b = rdp(path.slice(far).concat([path[0]]), eps);
    const res = a.slice(0, -1).concat(b.slice(0, -1));
    return res.length >= 3 ? res : path.slice();
  }

  // Zwraca obrys i jego otwory z PolyTree. Gdy kontur rozpadł się na kilka części
  // (np. obrys przecinający sam siebie), zwraca otoczkę wypukłą wszystkich części –
  // to gwarantuje, że rzeczywisty detal zawsze mieści się w obrysie roboczym.
  function largestFromTree(tree) {
    let best = null, ba = 0;
    const kids = tree.Childs();
    for (const n of kids) {
      const a = Math.abs(areaOf(n.Contour()));
      if (a > ba) { ba = a; best = n; }
    }
    if (!best) return null;
    if (kids.length > 1) {
      const pts = [];
      for (const n of kids) for (const p of n.Contour()) pts.push(p);
      return { outer: convexHull(pts), holes: [], merged: true };
    }
    return { outer: best.Contour(), holes: best.Childs().map(h => h.Contour()) };
  }

  function offsetShape(paths, delta, arcTol, round) {
    const co = new CL.ClipperOffset(2, arcTol);
    co.AddPaths(paths, round ? CL.JoinType.jtRound : CL.JoinType.jtMiter, CL.EndType.etClosedPolygon);
    const tree = new CL.PolyTree();
    co.Execute(tree, delta);
    return largestFromTree(tree);
  }

  function isConvex(path) {
    let sign = 0;
    const n = path.length;
    for (let i = 0; i < n; i++) {
      const a = path[i], b = path[(i + 1) % n], c = path[(i + 2) % n];
      const cr = (b.X - a.X) * (c.Y - b.Y) - (b.Y - a.Y) * (c.X - b.X);
      if (cr !== 0) { const s = cr > 0 ? 1 : -1; if (sign === 0) sign = s; else if (s !== sign) return false; }
    }
    return true;
  }

  function convexHull(points) {
    const p = points.slice().sort((a, b) => a.X - b.X || a.Y - b.Y);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }

  function translatePath(path, dx, dy) {
    const out = new Array(path.length);
    for (let i = 0; i < path.length; i++) out[i] = { X: path[i].X + dx, Y: path[i].Y + dy };
    return out;
  }

  // Unia równoległoboków krawędź(A) × krawędź(C) – brzeg sumy Minkowskiego ∂A ⊕ ∂C
  function boundaryQuads(A, C) {
    const quads = [];
    const n = A.length, m = C.length;
    for (let i = 0; i < n; i++) {
      const a0 = A[i], a1 = A[(i + 1) % n];
      for (let j = 0; j < m; j++) {
        const c0 = C[j], c1 = C[(j + 1) % m];
        const q = [
          { X: a0.X + c0.X, Y: a0.Y + c0.Y }, { X: a1.X + c0.X, Y: a1.Y + c0.Y },
          { X: a1.X + c1.X, Y: a1.Y + c1.Y }, { X: a0.X + c1.X, Y: a0.Y + c1.Y }
        ];
        const ar = (q[1].X - q[0].X) * (q[3].Y - q[0].Y) - (q[1].Y - q[0].Y) * (q[3].X - q[0].X);
        if (ar === 0) continue; // zdegenerowany (krawędzie równoległe) – pokryty przez sąsiednie
        if (ar < 0) q.reverse();
        quads.push(q);
      }
    }
    return quads;
  }

  // Unia równoległoboków zostawia czasem mikroskopijne fałszywe "dziury" (artefakty numeryczne).
  // Usuwamy otwory o polu poniżej progu – to zawsze bezpieczne (zmniejsza obszar dopuszczalny).
  function dropTinyHoles(paths, minArea) {
    return paths.filter(p => p.length >= 3 && (areaOf(p) > 0 || -areaOf(p) >= minArea));
  }

  function unionPaths(paths) {
    const c = new CL.Clipper();
    c.AddPaths(paths, PT.ptSubject, true);
    const sol = new CL.Paths();
    c.Execute(CT.ctUnion, sol, PFT.pftNonZero, PFT.pftNonZero);
    return sol;
  }

  function difference(subj, clip) {
    const c = new CL.Clipper();
    c.AddPaths(subj, PT.ptSubject, true);
    c.AddPaths(clip, PT.ptClip, true);
    const sol = new CL.Paths();
    c.Execute(CT.ctDifference, sol, PFT.pftNonZero, PFT.pftNonZero);
    return sol;
  }

  /* ---------------------------------------------------------------- przygotowanie */

  /**
   * parts:  [{ outer:[[x,y]], holes:[[[x,y]]], rots:[deg...] }]  (mm)
   * sheets: [{ w, h, count }] (count < 0 → bez limitu)
   * params: { spacing, margin, simplify, strategy:'x'|'y'|'area', fillHoles, scale }
   */
  function createNester(parts, sheets, params) {
    const S = params.scale || 100;
    const spacing = Math.max(0, params.spacing || 0);
    const margin = params.margin || 0;
    const eps = Math.max(0.01, params.simplify || 0.2) * S;
    const arcTol = 0.05 * S;
    const strategy = params.strategy || 'x';
    const fillHoles = params.fillHoles !== false;

    const tinyHole = S * S; // 1 mm²
    const toPath = pts => pts.map(p => ({ X: Math.round(p[0] * S), Y: Math.round(p[1] * S) }));

    // 1) obrys roboczy (offset + uproszczenie) – raz na detal
    const work = parts.map(pt => {
      let outer = toPath(pt.outer);
      if (areaOf(outer) < 0) outer.reverse();
      const holes = (pt.holes || []).map(h => { const p = toPath(h); if (areaOf(p) > 0) p.reverse(); return p; });
      let shape = { outer, holes };
      // samoprzecięcia: rozwiązujemy unią; jeśli powstało kilka części – otoczka wypukła
      const fixed = CL.Clipper.SimplifyPolygon(outer, PFT.pftNonZero).filter(q => Math.abs(areaOf(q)) > 0);
      if (fixed.length > 1) {
        const pts = [];
        for (const q of fixed) for (const p of q) pts.push(p);
        shape = { outer: convexHull(pts), holes: [] };
      }
      // + arcTol: cięciwy zaokrągleń leżą do arcTol wewnątrz łuku – kompensujemy
      if (spacing > 0) shape = offsetShape([shape.outer, ...shape.holes], spacing / 2 * S + arcTol, arcTol, true) || shape;
      // uproszczenie (tylko konturów z wieloma wierzchołkami, czyli łuków/splajnów)
      // + zabezpieczający offset o tolerancję, by uproszczony obrys obejmował oryginał
      const MANY = 40;
      let shape2 = shape;
      if (shape.outer.length > MANY || shape.holes.some(h => h.length > MANY)) {
        const so = shape.outer.length > MANY ? rdpClosed(shape.outer, eps) : shape.outer;
        const sh = shape.holes.map(h => (h.length > MANY ? rdpClosed(h, eps) : h));
        shape2 = offsetShape([so, ...sh], eps, arcTol, false) || shape;
        if (shape2.merged) shape2 = offsetShape([convexHull(shape.outer)], eps, arcTol, false) || shape2;
      }
      shape2.outer = CL.Clipper.CleanPolygon(shape2.outer, S * 0.01);
      shape2.holes = shape2.holes.map(h => CL.Clipper.CleanPolygon(h, S * 0.01)).filter(h => h.length >= 3);
      return shape2;
    });

    const minArea = Math.min(...work.map(w => Math.abs(areaOf(w.outer))));

    // 2) warianty obrotów
    const variants = parts.map((pt, i) => {
      const w = work[i];
      const sigs = new Set();
      return (pt.rots && pt.rots.length ? pt.rots : [0]).map(deg => {
        const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
        const rot = path => path.map(p => ({ X: Math.round(p.X * c - p.Y * s), Y: Math.round(p.X * s + p.Y * c) }));
        const o = rot(w.outer);
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const p of o) { if (p.X < minx) minx = p.X; if (p.Y < miny) miny = p.Y; if (p.X > maxx) maxx = p.X; if (p.Y > maxy) maxy = p.Y; }
        const outer = translatePath(o, -minx, -miny);
        if (areaOf(outer) < 0) outer.reverse();
        // obroty dające identyczny kształt (symetria) pomijamy
        const sig = outer.map(p => Math.round(p.X / (0.2 * S)) + ':' + Math.round(p.Y / (0.2 * S))).sort().join(';') + '#' + w.holes.length;
        if (sigs.has(sig)) return null;
        sigs.add(sig);
        const holes = !fillHoles ? [] : w.holes
          .filter(h => Math.abs(areaOf(h)) >= minArea * 0.999)
          .map(h => { const t = translatePath(rot(h), -minx, -miny); if (areaOf(t) > 0) t.reverse(); return t; })
          .map(h => {
            let a = Infinity, b = Infinity, cx = -Infinity, d = -Infinity;
            for (const p of h) { if (p.X < a) a = p.X; if (p.Y < b) b = p.Y; if (p.X > cx) cx = p.X; if (p.Y > d) d = p.Y; }
            return { path: h, w: cx - a, h: d - b, area: Math.abs(areaOf(h)) };
          });
        return {
          deg, th, outer, holes, w: maxx - minx, h: maxy - miny, area: Math.abs(areaOf(outer)),
          shiftX: minx, shiftY: miny, convex: isConvex(outer)
        };
      }).filter(Boolean);
    });

    /* ------------------------------------------------------------ NFP */
    const nfpCache = new Map();
    let nfpCount = 0;

    function negate(path) { return path.map(p => ({ X: -p.X, Y: -p.Y })); }

    function computeNFP(A, B) {
      const negB = negate(B.outer);
      let solid;
      if (A.convex && B.convex) {
        const pts = [];
        for (const a of A.outer) for (const c of negB) pts.push({ X: a.X + c.X, Y: a.Y + c.Y });
        solid = [convexHull(pts)];
      } else {
        const b0 = B.outer[0], a0 = A.outer[0];
        const paths = boundaryQuads(A.outer, negB);
        paths.push(translatePath(A.outer, -b0.X, -b0.Y));
        const nb = translatePath(negB, a0.X, a0.Y); if (areaOf(nb) < 0) nb.reverse();
        paths.push(nb);
        solid = unionPaths(paths);
      }
      // miejsca wewnątrz otworów A, w których B mieści się w całości
      const ifps = [];
      for (const H of A.holes) {
        if (H.w < B.w || H.h < B.h || H.area < B.area) continue;
        const b0 = B.outer[0];
        const Hpos = H.path.slice().reverse(); // dodatnia orientacja
        const swept = unionPaths(boundaryQuads(Hpos, negB));
        const inner = difference([translatePath(Hpos, -b0.X, -b0.Y)], swept);
        for (const p of inner) ifps.push(p);
      }
      nfpCount++;
      const res = dropTinyHoles(ifps.length ? difference(dropTinyHoles(solid, tinyHole), ifps) : solid, tinyHole);
      // Pomniejszenie NFP o 1 jedn. (0,01 mm): dopasowania "na styk" dają wtedy wąski pas
      // zamiast odcinka o zerowym polu, który Clipper by pominął.
      const co = new CL.ClipperOffset(2, arcTol);
      co.AddPaths(res, CL.JoinType.jtMiter, CL.EndType.etClosedPolygon);
      const shrunk = new CL.Paths();
      co.Execute(shrunk, -1);
      return dropTinyHoles(shrunk, tinyHole);
    }

    function getNFP(ia, ra, ib, rb) {
      const key = ia + '.' + ra + '|' + ib + '.' + rb;
      let v = nfpCache.get(key);
      if (!v) {
        v = computeNFP(variants[ia][ra], variants[ib][rb]);
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const p of v) for (const q of p) { if (q.X < minx) minx = q.X; if (q.Y < miny) miny = q.Y; if (q.X > maxx) maxx = q.X; if (q.Y > maxy) maxy = q.Y; }
        v = { paths: v, minx, miny, maxx, maxy };
        nfpCache.set(key, v);
      }
      return v;
    }

    /* ------------------------------------------------------------ arkusze */

    const sheetDefs = sheets.map(s => {
      const W = Math.round(s.w * S), H = Math.round(s.h * S);
      const inset = Math.round((margin - spacing / 2) * S);
      return { W, H, L: inset, B: inset, R: W - inset, T: H - inset, count: s.count, area: W * H };
    });

    function newSheet(t) {
      const d = sheetDefs[t];
      return { t, d, placed: [], minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity, usedArea: 0, failed: new Set(), unions: new Map() };
    }

    function score(sh, x, y, V) {
      const d = sh.d;
      const minx = Math.min(sh.minx, x), miny = Math.min(sh.miny, y);
      const maxx = Math.max(sh.maxx, x + V.w), maxy = Math.max(sh.maxy, y + V.h);
      if (strategy === 'y') return (maxy - d.B) * 1e6 + (maxx - d.L) + (y + x) * 1e-7;
      if (strategy === 'area') return (maxx - Math.min(minx, d.L)) * (maxy - Math.min(miny, d.B)) + (x + y) * 1e-3;
      return (maxx - d.L) * 1e6 + (maxy - d.B) + (x + y) * 1e-7;
    }

    function tryPlace(sh, pi) {
      const d = sh.d;
      let best = null;
      const vs = variants[pi];
      for (let ri = 0; ri < vs.length; ri++) {
        const V = vs[ri];
        const xmax = d.R - V.w, ymax = d.T - V.h;
        if (xmax < d.L || ymax < d.B) continue;
        let cands;
        if (!sh.placed.length) {
          cands = [[{ X: d.L, Y: d.B }]];
        } else {
          // prostokąt Inner-Fit poszerzony o 1 jedn. (0,01 mm) – kandydaci są potem przycinani do granic
          const xr = xmax + 1, yt = ymax + 1;
          const ifp = [{ X: d.L - 1, Y: d.B - 1 }, { X: xr, Y: d.B - 1 }, { X: xr, Y: yt }, { X: d.L - 1, Y: yt }];
          // Suma NFP już rozłożonych detali – aktualizowana przyrostowo dla każdego wariantu
          const key = pi + '.' + ri;
          let U = sh.unions.get(key);
          if (!U) { U = { paths: [], count: 0 }; sh.unions.set(key, U); }
          if (U.count < sh.placed.length) {
            const c = new CL.Clipper();
            if (U.paths.length) c.AddPaths(U.paths, PT.ptSubject, true);
            let added = 0;
            for (let k = U.count; k < sh.placed.length; k++) {
              const q = sh.placed[k];
              const nfp = getNFP(q.pi, q.ri, pi, ri);
              if (nfp.maxx + q.x < d.L || nfp.minx + q.x > xr || nfp.maxy + q.y < d.B || nfp.miny + q.y > yt) continue;
              for (const p of nfp.paths) c.AddPath(translatePath(p, q.x, q.y), PT.ptSubject, true);
              added++;
            }
            if (added) {
              // przycinamy do (lekko powiększonego) prostokąta Inner-Fit – reszta nie ma znaczenia
              c.AddPath([{ X: d.L - 10, Y: d.B - 10 }, { X: xr + 10, Y: d.B - 10 }, { X: xr + 10, Y: yt + 10 }, { X: d.L - 10, Y: yt + 10 }], PT.ptClip, true);
              const sol = new CL.Paths();
              c.Execute(CT.ctIntersection, sol, PFT.pftNonZero, PFT.pftNonZero);
              U.paths = dropTinyHoles(sol, tinyHole);
            }
            U.count = sh.placed.length;
          }
          const c2 = new CL.Clipper();
          c2.AddPath(ifp, PT.ptSubject, true);
          if (U.paths.length) c2.AddPaths(U.paths, PT.ptClip, true);
          cands = new CL.Paths();
          c2.Execute(CT.ctDifference, cands, PFT.pftNonZero, PFT.pftNonZero);
        }
        for (const path of cands) {
          for (const p of path) {
            const x = Math.max(d.L, Math.min(p.X, xmax)), y = Math.max(d.B, Math.min(p.Y, ymax));
            const s = score(sh, x, y, V);
            if (!best || s < best.s) best = { s, ri, x, y };
          }
        }
      }
      return best;
    }

    function commit(sh, pi, b) {
      const V = variants[pi][b.ri];
      sh.placed.push({ pi, ri: b.ri, x: b.x, y: b.y });
      sh.minx = Math.min(sh.minx, b.x); sh.miny = Math.min(sh.miny, b.y);
      sh.maxx = Math.max(sh.maxx, b.x + V.w); sh.maxy = Math.max(sh.maxy, b.y + V.h);
      sh.usedArea += V.area;
    }

    function minVariantArea(pi) { return Math.min(...variants[pi].map(v => v.area)); }

    /**
     * Rozkłada detale w podanej kolejności (tablica indeksów typów detali, z powtórzeniami).
     */
    function nest(order) {
      const sheetsUsed = [];
      const remaining = sheetDefs.map(d => d.count < 0 ? Infinity : d.count);
      const unplaced = [];
      for (const pi of order) {
        const need = minVariantArea(pi) * 0.98;
        let done = false;
        for (const sh of sheetsUsed) {
          if (sh.failed.has(pi)) continue;
          if (sh.d.area - sh.usedArea < need) { sh.failed.add(pi); continue; }
          const b = tryPlace(sh, pi);
          if (b) { commit(sh, pi, b); done = true; break; }
          sh.failed.add(pi);
        }
        if (done) continue;
        for (let t = 0; t < sheetDefs.length && !done; t++) {
          if (remaining[t] <= 0) continue;
          const sh = newSheet(t);
          const b = tryPlace(sh, pi);
          if (b) { commit(sh, pi, b); sheetsUsed.push(sh); remaining[t]--; done = true; }
        }
        if (!done) unplaced.push(pi);
      }
      return finalize(sheetsUsed, unplaced, order.length);
    }

    function finalize(sheetsUsed, unplaced, total) {
      let fitness = 0, bestRemnant = 0, bboxSum = 0;
      for (const sh of sheetsUsed) {
        const d = sh.d;
        fitness += d.area;
        let remnant;
        if (strategy === 'y') remnant = Math.max(0, d.T - sh.maxy) * d.W;
        else if (strategy === 'area') remnant = d.area - (sh.maxx - d.L) * (sh.maxy - d.B);
        else remnant = Math.max(0, d.R - sh.maxx) * d.H;
        bestRemnant = Math.max(bestRemnant, remnant);
        bboxSum += (sh.maxx - sh.minx) * (sh.maxy - sh.miny);
      }
      fitness = fitness - bestRemnant + bboxSum * 1e-3;
      for (const pi of unplaced) fitness += 1e13 + variants[pi][0].area * 10;
      return {
        fitness,
        sheets: sheetsUsed.map(sh => ({
          t: sh.t,
          usedX: (sh.maxx - spacing / 2 * S) / S, usedY: (sh.maxy - spacing / 2 * S) / S,
          placements: sh.placed.map(q => {
            const V = variants[q.pi][q.ri];
            return { pi: q.pi, deg: V.deg, dx: (q.x - V.shiftX) / S, dy: (q.y - V.shiftY) / S };
          })
        })),
        unplaced: unplaced.slice(),
        placedCount: total - unplaced.length
      };
    }

    // Obrys roboczy (z odstępem) do podglądu / diagnostyki, w mm, w układzie detalu
    function workOutline(pi) {
      return { outer: work[pi].outer.map(p => [p.X / S, p.Y / S]), holes: work[pi].holes.map(h => h.map(p => [p.X / S, p.Y / S])) };
    }

    return { nest, workOutline, stats: () => ({ nfpCount, cache: nfpCache.size }), variants, getNFP };
  }

  return { createNester };
}

if (typeof module !== 'undefined' && module.exports) module.exports = NestCoreFactory;
