/*
 * Przykładowe detale (zapisane tak, jak wyglądałyby po odczycie z DXF),
 * żeby narzędzie można było wypróbować bez własnych plików.
 */
(function (global) {
  'use strict';
  const DEG = Math.PI / 180;

  const circle = (x, y, r) => ({ t: 'circle', c: [x, y], r, layer: '0' });
  const poly = (pts, closed = true) => ({ t: 'poly', pts: pts.map(p => [p[0], p[1], p[2] || 0]), closed, layer: '0' });
  const line = (a, b, layer = 'GRAWER') => ({ t: 'line', a, b, layer });

  function slot(x1, x2, y, r) { // fasolka (otwór podłużny)
    return poly([[x1, y - r], [x2, y - r, 1], [x2, y + r], [x1, y + r, 1]]);
  }

  const T22 = Math.tan(22.5 * DEG); // wybrzuszenie łuku 90°

  const samples = [
    {
      name: 'Kołnierz DN250', qty: 6,
      entities: [circle(0, 0, 150), circle(0, 0, 62)].concat(
        Array.from({ length: 8 }, (_, i) => circle(115 * Math.cos(i * 45 * DEG + 22.5 * DEG), 115 * Math.sin(i * 45 * DEG + 22.5 * DEG), 9)))
    },
    {
      name: 'Wspornik kątowy', qty: 16,
      entities: [
        poly([[0, 0], [220, 0], [220, 60], [70, 60, -T22], [60, 70], [60, 160], [0, 160]]),
        circle(190, 30, 6.5), circle(30, 130, 6.5), line([10, 10], [50, 50])
      ]
    },
    {
      name: 'Płaskownik z fasolkami', qty: 12,
      entities: [
        poly([[8, 0], [292, 0, T22], [300, 8], [300, 72, T22], [292, 80], [8, 80, T22], [0, 72], [0, 8, T22]]),
        slot(30, 70, 40, 7), slot(230, 270, 40, 7)
      ]
    },
    {
      name: 'Żebro trójkątne', qty: 16,
      entities: [poly([[0, 0], [180, 0], [180, 20], [20, 150], [0, 150]]), circle(45, 40, 12)]
    },
    {
      name: 'Pierścień Ø200', qty: 4,
      entities: [circle(0, 0, 100), circle(0, 0, 76)]
    },
    {
      name: 'Podkładka Ø50', qty: 30,
      entities: [circle(0, 0, 25), circle(0, 0, 8.5)]
    },
    {
      name: 'Osłona łukowa', qty: 4,
      entities: [
        poly([[0, 0], [400, 0], [400, 160, 0.2], [0, 160]]),
        poly([[60, 40], [340, 40], [340, 90], [60, 90]]),
        circle(25, 25, 5), circle(375, 25, 5)
      ]
    }
  ];

  function build(Geometry, opts) {
    const parts = [];
    for (const s of samples) {
      const { parts: ps } = Geometry.buildParts({ entities: s.entities, blocks: {}, insunits: 4 }, s.name, opts);
      for (const p of ps) { p.qty = s.qty; p.sample = true; parts.push(p); }
    }
    return parts;
  }

  global.Samples = { build };
})(typeof window !== 'undefined' ? window : globalThis);
