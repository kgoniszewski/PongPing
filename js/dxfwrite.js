/*
 * Eksport rozkroju do DXF (format R12 / AC1009 – czytany przez praktycznie każdy CAD/CAM).
 * Geometria detali jest przenoszona dokładnie: łuki i okręgi pozostają łukami i okręgami.
 * Warstwy: ARKUSZ (obrys blachy), CIECIE (kontury), GRAWER (elementy otwarte), OPISY (nazwy).
 */
(function (global) {
  'use strict';

  const R2D = 180 / Math.PI;

  function fmt(v) { return (Math.abs(v) < 1e-9 ? 0 : v).toFixed(4).replace(/\.?0+$/, ''); }

  function Writer() { this.out = []; }
  Writer.prototype.g = function (code, val) { this.out.push(String(code), typeof val === 'number' ? fmt(val) : String(val)); };

  function header(w) {
    w.g(0, 'SECTION'); w.g(2, 'HEADER');
    w.g(9, '$ACADVER'); w.g(1, 'AC1009');
    w.g(9, '$INSUNITS'); w.g(70, 4);
    w.g(0, 'ENDSEC');
    w.g(0, 'SECTION'); w.g(2, 'TABLES');
    w.g(0, 'TABLE'); w.g(2, 'LAYER'); w.g(70, 4);
    for (const [name, color] of [['ARKUSZ', 8], ['CIECIE', 7], ['GRAWER', 3], ['OPISY', 4]]) {
      w.g(0, 'LAYER'); w.g(2, name); w.g(70, 0); w.g(62, color); w.g(6, 'CONTINUOUS');
    }
    w.g(0, 'ENDTAB');
    w.g(0, 'ENDSEC');
    w.g(0, 'SECTION'); w.g(2, 'ENTITIES');
  }
  function footer(w) { w.g(0, 'ENDSEC'); w.g(0, 'EOF'); }

  function line(w, layer, a, b) {
    w.g(0, 'LINE'); w.g(8, layer);
    w.g(10, a[0]); w.g(20, a[1]); w.g(30, 0); w.g(11, b[0]); w.g(21, b[1]); w.g(31, 0);
  }
  function poly(w, layer, pts, closed) {
    w.g(0, 'POLYLINE'); w.g(8, layer); w.g(66, 1); w.g(10, 0); w.g(20, 0); w.g(30, 0); w.g(70, closed ? 1 : 0);
    for (const p of pts) { w.g(0, 'VERTEX'); w.g(8, layer); w.g(10, p[0]); w.g(20, p[1]); w.g(30, 0); }
    w.g(0, 'SEQEND'); w.g(8, layer);
  }
  function text(w, layer, p, h, s) {
    w.g(0, 'TEXT'); w.g(8, layer); w.g(10, p[0]); w.g(20, p[1]); w.g(30, 0); w.g(40, h);
    w.g(1, s.replace(/[\r\n]/g, ' ')); w.g(72, 1); w.g(73, 2); w.g(11, p[0]); w.g(21, p[1]); w.g(31, 0);
  }

  function writePrim(w, layer, p, T) {
    const { c, s, dx, dy } = T;
    const tp = q => [q[0] * c - q[1] * s + dx, q[0] * s + q[1] * c + dy];
    if (p.k === 'L') line(w, layer, tp(p.a), tp(p.b));
    else if (p.k === 'C') { const cc = tp(p.c); w.g(0, 'CIRCLE'); w.g(8, layer); w.g(10, cc[0]); w.g(20, cc[1]); w.g(30, 0); w.g(40, p.r); }
    else if (p.k === 'A') {
      const cc = tp(p.c);
      let a0 = (p.a0 + T.th) * R2D, a1 = (p.a1 + T.th) * R2D;
      a0 = ((a0 % 360) + 360) % 360; a1 = ((a1 % 360) + 360) % 360;
      w.g(0, 'ARC'); w.g(8, layer); w.g(10, cc[0]); w.g(20, cc[1]); w.g(30, 0); w.g(40, p.r); w.g(50, a0); w.g(51, a1);
    } else if (p.k === 'P') poly(w, layer, p.pts.map(tp), p.closed);
  }

  /**
   * sheets: [{ W, H, offsetX, offsetY, placements:[{ part, deg, dx, dy }] }]
   */
  function build(sheets, opts) {
    opts = opts || {};
    const w = new Writer();
    header(w);
    for (const sh of sheets) {
      const ox = sh.offsetX || 0, oy = sh.offsetY || 0;
      poly(w, 'ARKUSZ', [[ox, oy], [ox + sh.W, oy], [ox + sh.W, oy + sh.H], [ox, oy + sh.H]], true);
      if (sh.title) text(w, 'OPISY', [ox + sh.W / 2, oy + sh.H + Math.max(10, sh.H * 0.02)], Math.max(8, sh.H * 0.02), sh.title);
      for (const pl of sh.placements) {
        const th = pl.deg * Math.PI / 180;
        const T = { th, c: Math.cos(th), s: Math.sin(th), dx: pl.dx + ox, dy: pl.dy + oy };
        for (const p of pl.part.prims) writePrim(w, 'CIECIE', p, T);
        for (const p of pl.part.marks || []) writePrim(w, 'GRAWER', p, T);
        if (opts.labels) {
          const ctr = [pl.part.w / 2, pl.part.h / 2];
          const cpt = [ctr[0] * T.c - ctr[1] * T.s + T.dx, ctr[0] * T.s + ctr[1] * T.c + T.dy];
          const hgt = Math.max(2, Math.min(20, Math.min(pl.part.w, pl.part.h) * 0.12));
          text(w, 'OPISY', cpt, hgt, pl.part.name);
        }
      }
    }
    footer(w);
    return w.out.join('\r\n') + '\r\n';
  }

  global.DxfWrite = { build };
})(typeof window !== 'undefined' ? window : globalThis);
