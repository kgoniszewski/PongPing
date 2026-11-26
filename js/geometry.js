/*
 * Geometria detali: rozbijanie encji CAD na prymitywy, łączenie w kontury,
 * rozpoznawanie obrysów i otworów, budowa definicji detali.
 *
 * Prymitywy (dokładne, używane też przy eksporcie DXF):
 *   { k:'L', a:[x,y], b:[x,y] }
 *   { k:'A', c:[x,y], r, a0, a1 }   // CCW od a0 do a1, 0 < a1-a0 <= 2π
 *   { k:'C', c:[x,y], r }
 *   { k:'P', pts:[[x,y],...], closed } // krzywe aproksymowane (elipsy, splajny, nierównomierne skale)
 */
(function (global) {
  'use strict';

  const TAU = Math.PI * 2;

  /* --------------------------------------------------------------- narzędzia */

  function polyArea(pts) {
    let a = 0;
    for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return -a / 2; // > 0 dla CCW
  }

  function bboxOf(pts, bb) {
    bb = bb || { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity };
    for (const p of pts) {
      if (p[0] < bb.minx) bb.minx = p[0]; if (p[0] > bb.maxx) bb.maxx = p[0];
      if (p[1] < bb.miny) bb.miny = p[1]; if (p[1] > bb.maxy) bb.maxy = p[1];
    }
    return bb;
  }

  function pointInPoly(pt, poly) {
    let inside = false;
    const x = pt[0], y = pt[1];
    for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function normAngle(a) { a %= TAU; return a < 0 ? a + TAU : a; }

  function arcSegments(r, sweep, tol) {
    if (r <= tol) return Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    const step = 2 * Math.acos(Math.max(-1, 1 - tol / r));
    return Math.max(Math.ceil(sweep / Math.max(step, 1e-3)), Math.ceil(sweep / (Math.PI / 4)), 1);
  }

  function arcPoints(c, r, a0, sweep, tol, includeStart) {
    const n = arcSegments(r, Math.abs(sweep), tol);
    const out = [];
    for (let i = includeStart ? 0 : 1; i <= n; i++) {
      const a = a0 + sweep * i / n;
      out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
    }
    return out;
  }

  /* --------------------------------------------------------------- przekształcenia */

  // Macierz afiniczna [a,b,c,d,e,f]: x' = a x + c y + e ; y' = b x + d y + f
  const I = [1, 0, 0, 1, 0, 0];
  function mul(m, n) { // m ∘ n
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  function tp(m, p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; }
  function isSimilarity(m) {
    const s1 = Math.hypot(m[0], m[1]), s2 = Math.hypot(m[2], m[3]);
    const dot = m[0] * m[2] + m[1] * m[3];
    return Math.abs(s1 - s2) <= 1e-9 * Math.max(1, s1) && Math.abs(dot) <= 1e-9 * Math.max(1, s1 * s2);
  }
  function det(m) { return m[0] * m[3] - m[1] * m[2]; }

  /* --------------------------------------------------------------- NURBS */

  function evalSpline(sp, tol) {
    const ctrl = sp.ctrl, deg = sp.deg || 3;
    if (!ctrl || ctrl.length < 2 || !sp.knots || sp.knots.length < ctrl.length + deg + 1) {
      return (sp.fit && sp.fit.length >= 2) ? sp.fit.map(p => [p[0], p[1]]) : (ctrl || []).map(p => [p[0], p[1]]);
    }
    const knots = sp.knots, w = sp.w;
    const n = ctrl.length - 1;
    const t0 = knots[deg], t1 = knots[n + 1];
    let len = 0;
    for (let i = 1; i < ctrl.length; i++) len += Math.hypot(ctrl[i][0] - ctrl[i - 1][0], ctrl[i][1] - ctrl[i - 1][1]);
    const samples = Math.min(4000, Math.max(ctrl.length * 12, Math.ceil(len / Math.max(tol * 20, 0.2)), 24));
    const out = [];
    for (let s = 0; s <= samples; s++) {
      let t = t0 + (t1 - t0) * s / samples;
      if (s === samples) t = t1 - 1e-12 * Math.max(1, Math.abs(t1));
      let k = deg;
      while (k < n && t >= knots[k + 1]) k++;
      const dx = [], dy = [], dw = [];
      for (let j = 0; j <= deg; j++) {
        const i = k - deg + j;
        const wi = w ? w[i] : 1;
        dx[j] = ctrl[i][0] * wi; dy[j] = ctrl[i][1] * wi; dw[j] = wi;
      }
      for (let r = 1; r <= deg; r++) {
        for (let j = deg; j >= r; j--) {
          const i = k - deg + j;
          const den = knots[i + deg - r + 1] - knots[i];
          const a = den === 0 ? 0 : (t - knots[i]) / den;
          dx[j] = (1 - a) * dx[j - 1] + a * dx[j];
          dy[j] = (1 - a) * dy[j - 1] + a * dy[j];
          dw[j] = (1 - a) * dw[j - 1] + a * dw[j];
        }
      }
      out.push([dx[deg] / dw[deg], dy[deg] / dw[deg]]);
    }
    return out;
  }

  /* --------------------------------------------------------------- rozbijanie modelu */

  function explode(model, opts) {
    const tol = opts.tol || 0.05;
    const skipLayers = new Set((opts.skipLayers || []).map(s => s.toUpperCase()));
    const prims = [];
    const scale = opts.scale || 1;
    const root = [scale, 0, 0, scale, 0, 0];

    function addPoly(pts, closed, m) {
      const tpts = pts.map(p => tp(m, p));
      if (tpts.length >= 2) prims.push({ k: 'P', pts: tpts, closed: !!closed });
    }

    function addArc(c, r, a0, a1, m) {
      let sweep = normAngle(a1 - a0);
      if (sweep < 1e-9) sweep = TAU;
      if (isSimilarity(m)) {
        const s = Math.hypot(m[0], m[1]);
        const cc = tp(m, c);
        const p0 = tp(m, [c[0] + r * Math.cos(a0), c[1] + r * Math.sin(a0)]);
        const p1 = tp(m, [c[0] + r * Math.cos(a0 + sweep), c[1] + r * Math.sin(a0 + sweep)]);
        if (Math.abs(sweep - TAU) < 1e-9) { prims.push({ k: 'C', c: cc, r: r * s }); return; }
        let b0 = Math.atan2(p0[1] - cc[1], p0[0] - cc[0]), b1 = Math.atan2(p1[1] - cc[1], p1[0] - cc[0]);
        if (det(m) < 0) { const t = b0; b0 = b1; b1 = t; }
        b0 = normAngle(b0);
        let sw = normAngle(b1 - b0); if (sw < 1e-9) sw = sweep;
        prims.push({ k: 'A', c: cc, r: r * s, a0: b0, a1: b0 + sw });
      } else {
        const pts = arcPoints(c, r, a0, sweep, tol / 4, true);
        addPoly(pts, Math.abs(sweep - TAU) < 1e-9, m);
      }
    }

    function addBulgePoly(e, m) {
      const v = e.pts;
      const n = v.length;
      if (n < 2) return;
      const segs = e.closed ? n : n - 1;
      // Gdy brak łuków i przekształcenie podobieństwa – zachowujemy jako jeden zamknięty/otwarty wielobok z liniami
      for (let i = 0; i < segs; i++) {
        const p0 = v[i], p1 = v[(i + 1) % n];
        const b = p0[2] || 0;
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1e-12) continue;
        if (Math.abs(b) < 1e-12) {
          prims.push({ k: 'L', a: tp(m, p0), b: tp(m, p1) });
        } else {
          const th = 4 * Math.atan(b);
          const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
          const L = Math.hypot(dx, dy);
          const r = Math.abs(L / (2 * Math.sin(th / 2)));
          const h = (L / 2) / Math.tan(th / 2); // odległość środka cięciwy od środka okręgu (ze znakiem)
          const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
          const c = [mx - h * dy / L, my + h * dx / L];
          const s0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
          const s1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
          if (b > 0) addArc(c, r, s0, s1, m); else addArc(c, r, s1, s0, m);
        }
      }
    }

    function walk(entities, m, depth) {
      if (depth > 12) return;
      for (const e of entities) {
        if (e.layer && skipLayers.has(String(e.layer).toUpperCase())) continue;
        switch (e.t) {
          case 'line': prims.push({ k: 'L', a: tp(m, e.a), b: tp(m, e.b) }); break;
          case 'circle':
            if (e.r > 0) {
              if (isSimilarity(m)) prims.push({ k: 'C', c: tp(m, e.c), r: e.r * Math.hypot(m[0], m[1]) });
              else addPoly(arcPoints(e.c, e.r, 0, TAU, tol / 4, true).slice(0, -1), true, m);
            }
            break;
          case 'arc': if (e.r > 0) addArc(e.c, e.r, e.a0, e.a1, m); break;
          case 'poly': addBulgePoly(e, m); break;
          case 'ellipse': {
            const maj = e.maj, R = Math.hypot(maj[0], maj[1]);
            if (R <= 0) break;
            const ux = maj[0] / R, uy = maj[1] / R, rr = R * e.ratio;
            let sweep = e.a1 - e.a0; sweep = normAngle(sweep); if (sweep < 1e-9) sweep = TAU;
            const closed = Math.abs(sweep - TAU) < 1e-9;
            const n = arcSegments(rr, sweep, tol / 4) * Math.max(1, Math.ceil(R / Math.max(rr, 1e-9)));
            const pts = [];
            for (let i = 0; i <= n; i++) {
              if (closed && i === n) break;
              const t = e.a0 + sweep * i / n;
              const x = R * Math.cos(t), y = rr * Math.sin(t);
              pts.push([e.c[0] + x * ux - y * uy, e.c[1] + x * uy + y * ux]);
            }
            addPoly(pts, closed, m);
            break;
          }
          case 'spline': {
            const pts = evalSpline(e, tol);
            if (pts.length < 2) break;
            const closed = e.closed || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
            if (closed && pts.length > 2) pts.pop();
            addPoly(pts, closed, m);
            break;
          }
          case 'insert': {
            const b = model.blocks[e.name];
            if (!b) break;
            for (let r = 0; r < e.rows; r++) {
              for (let c = 0; c < e.cols; c++) {
                // T(p) · R(rot) · T(c*cs, r*rs) · S(sx,sy) · T(-base)
                const cos = Math.cos(e.rot), sin = Math.sin(e.rot);
                let mm = [1, 0, 0, 1, -b.base[0], -b.base[1]];
                mm = mul([e.sx, 0, 0, e.sy, 0, 0], mm);
                mm = mul([1, 0, 0, 1, c * e.cs, r * e.rs], mm);
                mm = mul([cos, sin, -sin, cos, 0, 0], mm);
                mm = mul([1, 0, 0, 1, e.p[0], e.p[1]], mm);
                walk(b.entities, mul(m, mm), depth + 1);
              }
            }
            break;
          }
        }
      }
    }
    walk(model.entities, root, 0);
    return prims;
  }

  /* --------------------------------------------------------------- dyskretyzacja i końce */

  function primEnds(p) {
    if (p.k === 'L') return [p.a, p.b];
    if (p.k === 'A') return [[p.c[0] + p.r * Math.cos(p.a0), p.c[1] + p.r * Math.sin(p.a0)], [p.c[0] + p.r * Math.cos(p.a1), p.c[1] + p.r * Math.sin(p.a1)]];
    if (p.k === 'P') return [p.pts[0], p.pts[p.pts.length - 1]];
    return null;
  }

  // Punkty prymitywu od początku do końca (z punktem startowym)
  function primPoints(p, tol, reversed) {
    let pts;
    if (p.k === 'L') pts = [p.a, p.b];
    else if (p.k === 'A') pts = arcPoints(p.c, p.r, p.a0, p.a1 - p.a0, tol, true);
    else if (p.k === 'C') pts = arcPoints(p.c, p.r, 0, TAU, tol, true).slice(0, -1);
    else pts = p.pts.slice();
    return reversed ? pts.reverse() : pts;
  }

  function primKey(p) {
    const r = v => Math.round(v * 1000);
    if (p.k === 'L') { const a = [r(p.a[0]), r(p.a[1])], b = [r(p.b[0]), r(p.b[1])]; return 'L' + (a < b ? a + '|' + b : b + '|' + a); }
    if (p.k === 'A') return 'A' + [r(p.c[0]), r(p.c[1]), r(p.r), r(p.a0), r(p.a1)].join(',');
    if (p.k === 'C') return 'C' + [r(p.c[0]), r(p.c[1]), r(p.r)].join(',');
    return null;
  }

  /* --------------------------------------------------------------- łączenie w kontury */

  function chain(prims, joinTol) {
    // usuń duplikaty i elementy zdegenerowane
    const seen = new Set();
    const list = [];
    for (const p of prims) {
      if (p.k === 'L' && Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) < 1e-9) continue;
      if ((p.k === 'A' || p.k === 'C') && p.r < 1e-9) continue;
      const key = primKey(p);
      if (key) { if (seen.has(key)) continue; seen.add(key); }
      list.push(p);
    }

    const loops = [];   // { pieces:[{p, rev}] }
    const open = [];
    const pieces = [];
    for (const p of list) {
      if (p.k === 'C' || (p.k === 'P' && p.closed)) loops.push({ pieces: [{ p, rev: false }], closed: true });
      else pieces.push({ p, ends: primEnds(p), used: false });
    }

    // indeks przestrzenny końców
    const cell = Math.max(joinTol * 2, 1e-6);
    const grid = new Map();
    const ck = (x, y) => Math.floor(x / cell) + ':' + Math.floor(y / cell);
    pieces.forEach((pc, i) => {
      for (let e = 0; e < 2; e++) {
        const q = pc.ends[e];
        const k = ck(q[0], q[1]);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([i, e]);
      }
    });
    function findNear(pt, exclude) {
      const cx = Math.floor(pt[0] / cell), cy = Math.floor(pt[1] / cell);
      let best = null, bd = joinTol;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const arr = grid.get((cx + dx) + ':' + (cy + dy));
        if (!arr) continue;
        for (const [i, e] of arr) {
          if (pieces[i].used || i === exclude) continue;
          const q = pieces[i].ends[e];
          const d = Math.hypot(q[0] - pt[0], q[1] - pt[1]);
          if (d <= bd) { bd = d; best = [i, e]; }
        }
      }
      return best;
    }

    for (let s = 0; s < pieces.length; s++) {
      if (pieces[s].used) continue;
      pieces[s].used = true;
      const seq = [{ p: pieces[s].p, rev: false }];
      let head = pieces[s].ends[0], tail = pieces[s].ends[1];
      // rozbudowa w przód
      for (;;) {
        if (Math.hypot(tail[0] - head[0], tail[1] - head[1]) <= joinTol && seq.length > 1) break;
        const f = findNear(tail, -1);
        if (!f) break;
        const pc = pieces[f[0]]; pc.used = true;
        const rev = f[1] === 1;
        seq.push({ p: pc.p, rev });
        tail = pc.ends[rev ? 0 : 1];
      }
      let closed = seq.length > 1 && Math.hypot(tail[0] - head[0], tail[1] - head[1]) <= joinTol;
      if (!closed && seq.length === 1 && (seq[0].p.k === 'A' || seq[0].p.k === 'P') && Math.hypot(tail[0] - head[0], tail[1] - head[1]) <= joinTol) closed = true;
      // rozbudowa wstecz
      if (!closed) {
        for (;;) {
          const f = findNear(head, -1);
          if (!f) break;
          const pc = pieces[f[0]]; pc.used = true;
          const rev = f[1] === 0;
          seq.unshift({ p: pc.p, rev });
          head = pc.ends[rev ? 1 : 0];
          if (Math.hypot(tail[0] - head[0], tail[1] - head[1]) <= joinTol) { closed = true; break; }
        }
      }
      (closed ? loops : open).push({ pieces: seq, closed });
    }
    return { loops, open };
  }

  function chainPoints(ch, tol) {
    const out = [];
    for (const { p, rev } of ch.pieces) {
      const pts = primPoints(p, tol, rev);
      for (let i = 0; i < pts.length; i++) {
        if (out.length && i === 0) {
          const l = out[out.length - 1];
          if (Math.hypot(l[0] - pts[0][0], l[1] - pts[0][1]) < 1e-9) continue;
        }
        out.push(pts[i]);
      }
    }
    if (ch.closed && out.length > 2) {
      const a = out[0], b = out[out.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) out.pop();
    }
    return out;
  }

  /* --------------------------------------------------------------- budowa detali */

  let partCounter = 0;

  function buildParts(model, name, opts) {
    const tol = opts.tol || 0.05;
    const joinTol = opts.joinTol || 0.05;
    const prims = explode(model, opts);
    const { loops, open } = chain(prims, joinTol);
    const warnings = [];

    let contours = loops.map(l => {
      const pts = chainPoints(l, tol);
      const area = polyArea(pts);
      return { pts, area: Math.abs(area), bb: bboxOf(pts), prims: l.pieces.map(x => x.p), parent: -1, depth: 0 };
    }).filter(c => c.pts.length >= 3 && c.area > 1e-6);

    contours.sort((a, b) => b.area - a.area);
    for (let i = 0; i < contours.length; i++) {
      const ci = contours[i];
      for (let j = i - 1; j >= 0; j--) { // najmniejszy zawierający
        const cj = contours[j];
        if (cj.area <= ci.area) continue;
        if (ci.bb.minx < cj.bb.minx - 1e-6 || ci.bb.maxx > cj.bb.maxx + 1e-6 || ci.bb.miny < cj.bb.miny - 1e-6 || ci.bb.maxy > cj.bb.maxy + 1e-6) continue;
        // test kilku punktów – większość decyduje
        let ins = 0, tot = 0;
        const step = Math.max(1, Math.floor(ci.pts.length / 5));
        for (let k = 0; k < ci.pts.length && tot < 5; k += step, tot++) if (pointInPoly(ci.pts[k], cj.pts)) ins++;
        if (ins * 2 > tot) { ci.parent = j; break; }
      }
    }
    for (let i = 0; i < contours.length; i++) {
      let d = 0, p = contours[i].parent;
      while (p >= 0) { d++; p = contours[p].parent; }
      contours[i].depth = d;
    }

    const outers = [];
    contours.forEach((c, i) => {
      if (c.depth % 2 === 0) outers.push({ idx: i, c, holes: [], marks: [] });
    });
    const outerOf = new Map(outers.map(o => [o.idx, o]));
    contours.forEach(c => {
      if (c.depth % 2 === 1 && outerOf.has(c.parent)) outerOf.get(c.parent).holes.push(c);
    });

    // Elementy otwarte (grawer, linie gięcia itp.) przypisujemy do detalu, w którym leżą
    let orphan = 0;
    for (const ch of open) {
      const pts = chainPoints(ch, tol);
      if (!pts.length) continue;
      const probe = pts[Math.floor(pts.length / 2)];
      let owner = null;
      for (let i = outers.length - 1; i >= 0; i--) { // od najmniejszych
        if (pointInPoly(probe, outers[i].c.pts)) { owner = outers[i]; break; }
      }
      if (owner) owner.marks.push(...ch.pieces.map(x => x.p));
      else orphan++;
    }
    if (orphan) warnings.push(orphan + ' niezamkniętych elementów poza obrysem zostało pominiętych');
    if (!outers.length) warnings.push('Nie znaleziono zamkniętych konturów');

    const parts = outers.map((o, k) => {
      const outer = polyArea(o.c.pts) < 0 ? o.c.pts.slice().reverse() : o.c.pts.slice();
      const holes = o.holes.map(h => (polyArea(h.pts) > 0 ? h.pts.slice().reverse() : h.pts.slice()));
      const bb = o.c.bb;
      const dx = -bb.minx, dy = -bb.miny;
      const mv = p => [p[0] + dx, p[1] + dy];
      const prims = [...o.c.prims, ...o.holes.flatMap(h => h.prims)].map(p => translatePrim(p, dx, dy));
      const marks = o.marks.map(p => translatePrim(p, dx, dy));
      const area = o.c.area - o.holes.reduce((s, h) => s + h.area, 0);
      return {
        id: 'p' + (++partCounter),
        name: outers.length > 1 ? name + ' #' + (k + 1) : name,
        outer: outer.map(mv), holes: holes.map(h => h.map(mv)), prims, marks,
        w: bb.maxx - bb.minx, h: bb.maxy - bb.miny, area, qty: 1, rot: 'global'
      };
    });

    return { parts: mergeIdentical(parts), warnings };
  }

  // Identyczne detale z jednego pliku łączymy w jedną pozycję z ilością
  function mergeIdentical(parts) {
    const out = [];
    for (const p of parts) {
      const twin = out.find(q => Math.abs(q.area - p.area) < 1e-3 * Math.max(1, p.area) && Math.abs(q.w - p.w) < 1e-3 && Math.abs(q.h - p.h) < 1e-3 && q.outer.length === p.outer.length && q.holes.length === p.holes.length);
      if (twin) twin.qty++;
      else out.push(p);
    }
    if (out.length === 1 && parts.length > 1) out[0].name = out[0].name.replace(/ #1$/, '');
    return out;
  }

  function translatePrim(p, dx, dy) {
    const m = q => [q[0] + dx, q[1] + dy];
    if (p.k === 'L') return { k: 'L', a: m(p.a), b: m(p.b) };
    if (p.k === 'A') return { k: 'A', c: m(p.c), r: p.r, a0: p.a0, a1: p.a1 };
    if (p.k === 'C') return { k: 'C', c: m(p.c), r: p.r };
    return { k: 'P', pts: p.pts.map(m), closed: p.closed };
  }

  // Detal z prostego wielokąta (prostokąt, koło, kształty przykładowe)
  function partFromPolygons(name, outer, holes, primsOverride) {
    const bb = bboxOf(outer);
    const dx = -bb.minx, dy = -bb.miny;
    const mv = p => [p[0] + dx, p[1] + dy];
    if (polyArea(outer) < 0) outer = outer.slice().reverse();
    holes = (holes || []).map(h => (polyArea(h) > 0 ? h.slice().reverse() : h));
    const prims = primsOverride ? primsOverride.map(p => translatePrim(p, dx, dy))
      : [outer, ...holes].map(r => ({ k: 'P', pts: r.map(mv), closed: true }));
    return {
      id: 'p' + (++partCounter), name, outer: outer.map(mv), holes: holes.map(h => h.map(mv)), prims, marks: [],
      w: bb.maxx - bb.minx, h: bb.maxy - bb.miny,
      area: Math.abs(polyArea(outer)) - holes.reduce((s, h) => s + Math.abs(polyArea(h)), 0), qty: 1, rot: 'global'
    };
  }

  function nextId() { return 'p' + (++partCounter); }

  global.Geometry = {
    polyArea, bboxOf, pointInPoly, explode, chain, buildParts, partFromPolygons, primPoints, arcPoints, nextId, mul, tp
  };
})(typeof window !== 'undefined' ? window : globalThis);
