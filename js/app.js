/* Interfejs aplikacji „Rozkrój Blach”. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.setAttribute('style', v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

  const nf = (v, d = 0) => Number(v).toLocaleString('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const ClipperLib = window.ClipperLib || ClipperFactory();
  window.ClipperLib = ClipperLib;

  /* ================================================================ stan */
  const state = {
    parts: [],
    sheets: [{ w: 2500, h: 1250, count: '' }],
    optimizer: null,
    run: null,        // { snapshot, result, info }
    note: null,       // komunikat informacyjny (np. o przykładowych detalach)
  };

  const SETTINGS_KEY = 'rozkroj.settings.v1';
  const PARTS_KEY = 'rozkroj.parts.v1';
  const settingIds = ['impUnits', 'impTol', 'impSkip', 'matSel', 'thick', 'pSpacing', 'pMargin', 'pRot', 'pStrategy', 'pTime', 'pThreads', 'pSimplify', 'pHoles', 'dxfLabels'];

  function saveSettings() {
    try {
      const s = { sheets: state.sheets };
      for (const id of settingIds) { const n = $(id); s[id] = n.type === 'checkbox' ? n.checked : n.value; }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch (_) { /* brak dostępu do pamięci przeglądarki */ }
  }
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!s) return;
      if (Array.isArray(s.sheets) && s.sheets.length) state.sheets = s.sheets;
      for (const id of settingIds) if (id in s) { const n = $(id); if (n.type === 'checkbox') n.checked = !!s[id]; else n.value = s[id]; }
    } catch (_) { /* ignoruj */ }
  }
  let savePartsTimer = null;
  function saveParts() {
    clearTimeout(savePartsTimer);
    savePartsTimer = setTimeout(() => {
      try {
        const data = JSON.stringify(state.parts);
        if (data.length < 4.5e6) localStorage.setItem(PARTS_KEY, data);
        else localStorage.removeItem(PARTS_KEY);
      } catch (_) { /* ignoruj (np. przekroczony limit) */ }
    }, 300);
  }
  function loadParts() {
    try {
      const p = JSON.parse(localStorage.getItem(PARTS_KEY) || 'null');
      return Array.isArray(p) ? p : null;
    } catch (_) { return null; }
  }

  /* ================================================================ kolory i rysowanie */
  const colorOf = i => `hsl(${(i * 137.508 + 18) % 360} 52% 60%)`;

  function ringD(pts, T) {
    let d = '';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = T ? p[0] * T.c - p[1] * T.s + T.dx : p[0];
      const y = T ? p[0] * T.s + p[1] * T.c + T.dy : p[1];
      d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
    }
    return d + 'Z';
  }
  const partD = (part, T) => ringD(part.outer, T) + part.holes.map(h => ringD(h, T)).join('');

  function marksD(part, T) {
    let d = '';
    for (const p of part.marks || []) {
      const pts = Geometry.primPoints(p, 0.2, false);
      d += ringD(pts, T).slice(0, -1);
      if (p.k === 'C' || (p.k === 'P' && p.closed)) d += 'Z';
    }
    return d;
  }

  function thumb(part, color) {
    const pad = Math.max(part.w, part.h) * 0.06;
    const s = svgEl('svg', { class: 'part-thumb', viewBox: `${-pad} ${-pad} ${part.w + 2 * pad} ${part.h + 2 * pad}`, 'aria-hidden': 'true', style: `--pc:${color}` });
    const g = svgEl('g', { transform: `translate(0 ${part.h}) scale(1 -1)` });
    g.append(svgEl('path', { d: partD(part) }));
    s.append(g);
    return s;
  }

  /* ================================================================ detale */
  const ROT_LABELS = { global: 'wg ustawień', '0': 'bez obrotu', '180': '0°/180°', '90': 'co 90°' };

  function renderParts() {
    const ul = $('partsList');
    ul.textContent = '';
    state.parts.forEach((p, i) => {
      const color = colorOf(i);
      const qty = el('input', { type: 'number', min: '0', step: '1', value: p.qty, 'aria-label': 'Ilość: ' + p.name, id: 'qty-' + p.id });
      qty.addEventListener('change', () => { p.qty = Math.max(0, Math.round(+qty.value || 0)); qty.value = p.qty; updatePartsMeta(); saveParts(); });
      const rot = el('select', { 'aria-label': 'Obrót: ' + p.name, id: 'rot-' + p.id });
      for (const [v, l] of Object.entries(ROT_LABELS)) rot.append(el('option', { value: v, selected: p.rot === v }, l));
      rot.addEventListener('change', () => { p.rot = rot.value; saveParts(); });
      const del = el('button', { class: 'part-del', type: 'button', title: 'Usuń detal', 'aria-label': 'Usuń ' + p.name }, '×');
      del.addEventListener('click', () => { state.parts.splice(i, 1); renderParts(); saveParts(); });
      const li = el('li', { class: 'part', 'data-pid': p.id },
        thumb(p, color),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'part-name', title: p.name + (p.file ? ' (' + p.file + ')' : '') }, p.name),
          el('div', { class: 'part-dims', title: `pole ${nf(p.area / 100, 1)} cm², otwory: ${p.holes.length}` }, `${nf(p.w, 0)} × ${nf(p.h, 0)} mm`)
        ),
        qty, rot, del);
      li.addEventListener('mouseenter', () => highlight(p.id));
      li.addEventListener('mouseleave', () => highlight(null));
      ul.append(li);
    });
    updatePartsMeta();
  }

  function updatePartsMeta() {
    const n = state.parts.reduce((s, p) => s + p.qty, 0);
    const a = state.parts.reduce((s, p) => s + p.qty * p.area, 0);
    $('partsMeta').textContent = state.parts.length ? `${state.parts.length} poz. · ${nf(n)} szt. · ${nf(a / 1e6, 2)} m²` : '';
    $('partsBulk').hidden = state.parts.length < 2;
  }

  function highlight(pid) {
    document.querySelectorAll('.sheet-list .sheet-svg').forEach(svg => {
      svg.classList.toggle('dim', !!pid);
      svg.querySelectorAll('.sv-part').forEach(p => p.classList.toggle('hl', !!pid && p.dataset.pid === pid));
    });
  }

  function importOpts() {
    return {
      tol: Math.max(0.005, +$('impTol').value || 0.05),
      joinTol: Math.max(0.01, Math.min(0.5, (+$('impTol').value || 0.05) * 2)),
      skipLayers: $('impSkip').value.split(',').map(s => s.trim()).filter(Boolean)
    };
  }

  function logLine(text, kind) {
    const n = el('div', { class: 'log-line ' + (kind || '') }, text);
    $('importLog').append(n);
    return n;
  }

  async function importFiles(files) {
    const list = Array.from(files).filter(f => /\.(dxf|dwg)$/i.test(f.name));
    const skipped = files.length - list.length;
    if (!list.length) { logLine(skipped ? 'Brak plików DXF/DWG w wybranych elementach.' : 'Nie wybrano plików.', 'warn'); return; }
    $('importLog').textContent = '';
    state.note = null;
    if (state.parts.length && state.parts.every(p => p.sample)) state.parts = [];
    let added = 0;
    for (const f of list) {
      const name = (f.webkitRelativePath || f.relPath || f.name).replace(/\.(dxf|dwg)$/i, '');
      const line = logLine(`${f.name} – wczytywanie…`, 'busy');
      try {
        let model;
        if (/\.dwg$/i.test(f.name)) {
          line.textContent = `${f.name} – ładowanie modułu DWG (pierwszy raz może potrwać)…`;
          model = await CadParse.parseDWG(await f.arrayBuffer());
        } else {
          model = CadParse.parseDXF(await f.text());
        }
        const opts = importOpts();
        opts.scale = CadParse.unitFactor(model.insunits, $('impUnits').value);
        const { parts, warnings } = Geometry.buildParts(model, name.split('/').pop(), opts);
        const big = parts.reduce((m, p) => Math.max(m, p.w, p.h), 0);
        if (big > 20000) warnings.push(`detal ma ${nf(big / 1000, 1)} m – sprawdź jednostki w „Opcjach importu”`);
        else if (big > 0 && big < 2 && $('impUnits').value === 'auto') warnings.push(`detal ma tylko ${nf(big, 2)} mm – sprawdź jednostki w „Opcjach importu”`);
        for (const p of parts) { p.file = f.name; state.parts.push(p); }
        added += parts.length;
        line.className = 'log-line' + (warnings.length ? ' warn' : '');
        line.textContent = `${f.name} – ${parts.length ? parts.length + (parts.length === 1 ? ' detal' : ' detale') : 'brak detali'}${warnings.length ? ' · ' + warnings.join('; ') : ''}`;
      } catch (err) {
        line.className = 'log-line err';
        line.textContent = `${f.name} – błąd: ${err.message || err}`;
        console.error(err);
      }
      renderParts();
    }
    if (skipped) logLine(`Pominięto ${skipped} plików innego typu.`, '');
    if (added) saveParts();
    // automatycznie zwijaj log, jeśli wszystko poszło dobrze
    if ($('importLog').querySelectorAll('.err,.warn').length === 0 && list.length > 3) {
      $('importLog').textContent = '';
      logLine(`Wczytano ${list.length} plików, ${added} detali.`);
    }
  }

  // Rekurencyjny odczyt folderów przeciągniętych na stronę
  async function entriesToFiles(entries) {
    const out = [];
    async function walk(entry, path) {
      if (entry.isFile) {
        await new Promise(res => entry.file(f => { f.relPath = path + f.name; out.push(f); res(); }, () => res()));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise(res => reader.readEntries(res, () => res([])));
          if (!batch.length) break;
          for (const e of batch) await walk(e, path + entry.name + '/');
        }
      }
    }
    for (const e of entries) if (e) await walk(e, '');
    return out;
  }

  function addSimplePart(name, outer, holes, prims, qty) {
    const p = Geometry.partFromPolygons(name, outer, holes, prims);
    p.qty = qty;
    state.note = null;
    if (state.parts.length && state.parts.every(x => x.sample)) state.parts = [];
    state.parts.push(p);
    renderParts(); saveParts();
  }

  /* ================================================================ arkusze */
  function renderSheets() {
    const ul = $('sheetsList');
    ul.textContent = '';
    state.sheets.forEach((s, i) => {
      const mk = (key, label, attrs) => {
        const inp = el('input', Object.assign({ type: 'number', value: s[key], 'aria-label': label + ' arkusza ' + (i + 1), id: `sheet-${key}-${i}` }, attrs));
        inp.addEventListener('change', () => { s[key] = inp.value === '' ? '' : +inp.value; saveSettings(); });
        return inp;
      };
      const del = el('button', { class: 'part-del', type: 'button', title: 'Usuń arkusz', 'aria-label': 'Usuń arkusz ' + (i + 1), disabled: state.sheets.length === 1 }, '×');
      del.addEventListener('click', () => { state.sheets.splice(i, 1); renderSheets(); saveSettings(); });
      ul.append(el('li', { class: 'sheet-row' },
        mk('w', 'Długość X', { min: '1', step: 'any' }), mk('h', 'Szerokość Y', { min: '1', step: 'any' }),
        mk('count', 'Liczba sztuk', { min: '0', step: '1', placeholder: '∞' }), del));
    });
  }

  /* ================================================================ parametry */
  function readParams() {
    return {
      spacing: Math.max(0, +$('pSpacing').value || 0),
      margin: Math.max(0, +$('pMargin').value || 0),
      rotStep: +$('pRot').value || 0,
      strategy: $('pStrategy').value,
      timeLimit: Math.max(1, +$('pTime').value || 30),
      threads: Math.max(1, Math.min(32, +$('pThreads').value || defaultThreads())),
      simplify: Math.max(0.01, +$('pSimplify').value || 0.25),
      fillHoles: $('pHoles').checked,
      thick: Math.max(0, +$('thick').value || 0),
      density: +$('matSel').value || 7.85,
    };
  }
  function defaultThreads() { return Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)); }

  function rotsFor(part, step) {
    let r;
    if (part.rot === '0') r = [0];
    else if (part.rot === '180') r = [0, 180];
    else if (part.rot === '90') r = [0, 90, 180, 270];
    else if (!step) r = [0];
    else { r = []; for (let a = 0; a < 360 - 1e-9; a += step) r.push(a); }
    if (isRound(part)) r = [0]; // obrys okrągły – obrót nic nie zmienia
    return r;
  }
  function isRound(p) {
    if (Math.abs(p.w - p.h) > 0.01 * p.w || p.outer.length < 16) return false;
    const a = Math.abs(Geometry.polyArea(p.outer));
    return Math.abs(a - Math.PI * p.w * p.h / 4) < 0.004 * a;
  }

  /* ================================================================ uruchomienie */
  let renderTimer = null, pendingRender = null;

  function run(override) {
    if (state.optimizer) return;
    const P = readParams();
    if (override && override.timeLimit) P.timeLimit = override.timeLimit;
    const active = state.parts.filter(p => p.qty > 0);
    hideAlert();
    if (!active.length) { showAlert('Dodaj detale i podaj ich ilość (krok 1).', true); return; }
    const sheets = state.sheets
      .map(s => ({ w: +s.w, h: +s.h, count: s.count === '' || s.count == null ? -1 : Math.max(0, Math.round(+s.count)) }))
      .filter(s => s.w > 0 && s.h > 0 && s.count !== 0);
    if (!sheets.length) { showAlert('Podaj co najmniej jeden arkusz o dodatnich wymiarach (krok 2).', true); return; }

    const snapshot = {
      parts: active.map(p => Object.assign({}, p, { rots: rotsFor(p, P.rotStep), color: colorOf(state.parts.indexOf(p)) })),
      sheets, params: P
    };
    state.run = { snapshot, result: null, info: null, done: false };
    $('sheetList').textContent = '';
    $('bom').textContent = '';
    $('summary').textContent = '';
    setRunning(true);

    const opt = new Optimizer({
      parts: snapshot.parts, sheets,
      params: { spacing: P.spacing, margin: P.margin, simplify: P.simplify, strategy: P.strategy, fillHoles: P.fillHoles, scale: 100 },
      threads: P.threads, timeLimit: P.timeLimit,
      onBest: (result, info) => { state.run.result = result; state.run.info = info; scheduleRender(); },
      onProgress: info => { state.run.info = info; updateProgress(info); },
      onDone: (info) => {
        state.optimizer = null; state.run.info = info; state.run.done = true;
        setRunning(false); renderResult();
        $('topStats').textContent = `${nf(info.evals)} wariantów · ${nf(info.elapsed, 1)} s · ${info.threads} wątk.`;
      },
      onError: err => {
        state.optimizer = null; setRunning(false);
        showAlert('Błąd obliczeń: ' + (err.message || err), true);
        console.error(err);
      }
    });
    state.optimizer = opt;
    try { opt.start(); }
    catch (err) { state.optimizer = null; setRunning(false); showAlert(err.message, true); }
  }

  function scheduleRender() {
    if (renderTimer) { pendingRender = true; return; }
    renderResult();
    renderTimer = setTimeout(() => { renderTimer = null; if (pendingRender) { pendingRender = false; renderResult(); } }, 500);
  }

  function setRunning(on) {
    $('runBtn').hidden = on;
    $('stopBtn').hidden = !on;
    $('progress').hidden = !on;
    $('toolbar').hidden = on || !(state.run && state.run.result);
    if (on) updateProgress({ elapsed: 0, timeLimit: readParams().timeLimit, evals: 0, nfp: 0 });
  }

  function updateProgress(info) {
    const pct = Math.min(100, info.elapsed / info.timeLimit * 100);
    $('progressFill').style.width = pct.toFixed(1) + '%';
    const r = state.run && state.run.result;
    const best = r ? ` · najlepszy: ${r.sheets.length} ark., ${nf(utilization(r, state.run.snapshot).util * 100, 1)} %` : '';
    $('progressText').textContent = `Optymalizacja: ${nf(info.elapsed, 1)} / ${nf(info.timeLimit)} s · sprawdzone warianty: ${nf(info.evals)}${best}`;
  }

  function showAlert(msg, isError) { const a = $('alert'); a.hidden = false; a.className = 'alert' + (isError ? '' : ' info'); a.textContent = msg; }
  function hideAlert() { $('alert').hidden = true; }

  /* ================================================================ wyniki */
  function utilization(result, snap) {
    let partsArea = 0, sheetArea = 0, usedArea = 0;
    const st = snap.params.strategy;
    result.sheets.forEach((s, i) => {
      const def = snap.sheets[s.t];
      sheetArea += def.w * def.h;
      for (const pl of s.placements) partsArea += snap.parts[pl.pi].area;
      const isLast = i === result.sheets.length - 1;
      if (isLast && st === 'x') usedArea += Math.min(def.w, s.usedX + snap.params.spacing) * def.h;
      else if (isLast && st === 'y') usedArea += Math.min(def.h, s.usedY + snap.params.spacing) * def.w;
      else usedArea += def.w * def.h;
    });
    return { partsArea, sheetArea, usedArea, util: sheetArea ? partsArea / sheetArea : 0, utilUsed: usedArea ? partsArea / usedArea : 0 };
  }

  function renderResult() {
    const run = state.run;
    if (!run || !run.result) return;
    const { snapshot: snap, result } = run;
    const P = snap.params;
    const U = utilization(result, snap);
    const total = snap.parts.reduce((s, p) => s + p.qty, 0);
    const kg = a => a * P.thick * P.density * 1e-6;

    // --- podsumowanie
    const byType = {};
    result.sheets.forEach(s => { byType[s.t] = (byType[s.t] || 0) + 1; });
    const typeTxt = Object.entries(byType).map(([t, n]) => `${n}× ${nf(snap.sheets[t].w)}×${nf(snap.sheets[t].h)}`).join(', ');
    const waste = U.sheetArea - U.partsArea;
    const last = result.sheets[result.sheets.length - 1];
    let remnantTxt = '—', remnantSub = 'tryb zwartej grupy';
    if (last && (P.strategy === 'x' || P.strategy === 'y')) {
      const d = snap.sheets[last.t];
      const rl = P.strategy === 'x' ? d.w - last.usedX - P.spacing : d.h - last.usedY - P.spacing;
      if (rl > 1) {
        remnantTxt = P.strategy === 'x' ? `${nf(rl)} × ${nf(d.h)}` : `${nf(d.w)} × ${nf(rl)}`;
        remnantSub = 'mm, na ostatnim arkuszu';
      } else { remnantTxt = 'brak'; remnantSub = 'ostatni arkusz zajęty w całości'; }
    }
    const kpi = (label, value, sub, cls, extra) => el('div', { class: 'kpi ' + (cls || '') },
      el('span', { class: 'kpi-label' }, label), value, sub ? el('span', { class: 'kpi-sub' }, sub) : null, extra || null);
    const valEl = (v, unit) => { const n = el('span', { class: 'kpi-value' }, v); if (unit) n.append(el('small', null, unit)); return n; };
    const meter = el('div', { class: 'meter' }, el('i', { style: `width:${(U.util * 100).toFixed(1)}%` }));
    const sm = $('summary');
    sm.textContent = '';
    sm.append(
      kpi('Arkusze', valEl(nf(result.sheets.length)), typeTxt),
      kpi('Wykorzystanie blachy', valEl(nf(U.util * 100, 1), '%'), `bez resztki: ${nf(U.utilUsed * 100, 1)} %`, '', meter),
      kpi('Odpad', valEl(nf(waste / 1e6, 2), 'm²'), P.thick > 0 ? `${nf(kg(waste), 1)} kg z ${nf(kg(U.sheetArea), 1)} kg blachy` : 'podaj grubość, aby policzyć masę'),
      kpi('Rozmieszczone detale', valEl(`${nf(result.placedCount)} / ${nf(total)}`), result.unplaced.length ? `${result.unplaced.length} nie zmieściło się` : 'wszystkie', result.unplaced.length ? 'is-bad' : 'is-good'),
      kpi('Resztka do ponownego użycia', valEl(remnantTxt), remnantSub)
    );

    // --- ostrzeżenie o niezmieszczonych
    if (result.unplaced.length) {
      const cnt = {};
      result.unplaced.forEach(pi => { cnt[pi] = (cnt[pi] || 0) + 1; });
      showAlert('Nie zmieściły się: ' + Object.entries(cnt).map(([pi, n]) => `${snap.parts[pi].name} (${n} szt.)`).join(', ') +
        '. Dodaj arkusze, zwiększ ich limit albo sprawdź, czy detal mieści się w arkuszu z uwzględnieniem marginesu.', true);
    } else if (state.note) showAlert(state.note, false);
    else hideAlert();

    // --- arkusze
    const list = $('sheetList');
    list.textContent = '';
    result.sheets.forEach((s, i) => list.append(sheetCard(s, i, result, snap)));

    // --- zestawienie
    renderBOM(result, snap);
    $('toolbar').hidden = !!state.optimizer;
  }

  function sheetSVG(s, snap, idx) {
    const d = snap.sheets[s.t];
    const P = snap.params;
    const W = d.w, H = d.h;
    const fs = Math.max(W, H) * 0.018;
    const pad = fs * 2.2;
    const svg = svgEl('svg', { class: 'sheet-svg', viewBox: `${-pad} ${-pad} ${W + pad * 1.4} ${H + pad * 1.4}`, role: 'img', 'aria-label': `Arkusz ${idx + 1}: ${W} × ${H} mm, ${s.placements.length} detali` });
    const defs = svgEl('defs');
    const hid = 'hatch' + idx + Math.random().toString(36).slice(2, 6);
    const pat = svgEl('pattern', { id: hid, width: fs * 0.8, height: fs * 0.8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    pat.append(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: fs * 0.8, class: 'sv-hatch', 'stroke-width': fs * 0.08 }));
    defs.append(pat);
    svg.append(defs);
    // wymiary
    const t1 = svgEl('text', { x: W / 2, y: -fs * 0.7, 'font-size': fs, 'text-anchor': 'middle', class: 'sv-dim' }); t1.textContent = `${nf(W)} mm`;
    const t2 = svgEl('text', { x: -fs * 0.7, y: H / 2, 'font-size': fs, 'text-anchor': 'middle', class: 'sv-dim', transform: `rotate(-90 ${-fs * 0.7} ${H / 2})` }); t2.textContent = `${nf(H)} mm`;
    svg.append(t1);
    const g = svgEl('g', { transform: `translate(0 ${H}) scale(1 -1)` });
    g.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, class: 'sv-sheet', 'stroke-width': Math.max(W, H) * 0.0015 }));
    // resztka
    if (P.strategy === 'x' && s.usedX + P.spacing < W - 1) {
      const x0 = s.usedX + P.spacing;
      g.append(svgEl('rect', { x: x0, y: 0, width: W - x0, height: H, class: 'sv-remnant', fill: `url(#${hid})` }));
    } else if (P.strategy === 'y' && s.usedY + P.spacing < H - 1) {
      const y0 = s.usedY + P.spacing;
      g.append(svgEl('rect', { x: 0, y: y0, width: W, height: H - y0, class: 'sv-remnant', fill: `url(#${hid})` }));
    }
    if (P.margin > 0) g.append(svgEl('rect', { x: P.margin, y: P.margin, width: W - 2 * P.margin, height: H - 2 * P.margin, class: 'sv-margin', 'stroke-width': Math.max(W, H) * 0.001 }));
    for (const pl of s.placements) {
      const part = snap.parts[pl.pi];
      const th = pl.deg * Math.PI / 180;
      const T = { c: Math.cos(th), s: Math.sin(th), dx: pl.dx, dy: pl.dy };
      const path = svgEl('path', { d: partD(part, T), class: 'sv-part', style: `--pc:${part.color}`, 'data-pid': part.id });
      const title = svgEl('title'); title.textContent = `${part.name} · obrót ${nf(pl.deg)}° · X ${nf(pl.dx, 1)} Y ${nf(pl.dy, 1)}`;
      path.append(title);
      g.append(path);
      const md = marksD(part, T);
      if (md) g.append(svgEl('path', { d: md, class: 'sv-mark' }));
    }
    svg.append(g, t2);
    return svg;
  }

  function sheetCard(s, i, result, snap) {
    const d = snap.sheets[s.t];
    const P = snap.params;
    let pa = 0;
    for (const pl of s.placements) pa += snap.parts[pl.pi].area;
    const facts = [
      ['detale', nf(s.placements.length)],
      ['wykorzystanie', nf(pa / (d.w * d.h) * 100, 1) + ' %'],
    ];
    if (P.strategy === 'x') facts.push(['zajęta długość X', nf(Math.min(d.w, s.usedX + P.spacing)) + ' mm']);
    if (P.strategy === 'y') facts.push(['zajęta szerokość Y', nf(Math.min(d.h, s.usedY + P.spacing)) + ' mm']);
    if (P.thick > 0) facts.push(['masa detali', nf(pa * P.thick * P.density * 1e-6, 1) + ' kg']);
    const svg = sheetSVG(s, snap, i);
    svg.addEventListener('click', () => openZoom(s, i, result, snap));
    const dxfBtn = el('button', { class: 'btn btn-sm', type: 'button' }, 'DXF');
    dxfBtn.addEventListener('click', () => exportDXF([i]));
    const zoomBtn = el('button', { class: 'btn btn-sm btn-ghost', type: 'button' }, 'Powiększ');
    zoomBtn.addEventListener('click', () => openZoom(s, i, result, snap));
    return el('article', { class: 'sheet-card' },
      el('div', { class: 'sheet-head' },
        el('h3', null, `Arkusz ${i + 1} z ${result.sheets.length}`),
        el('div', { class: 'sheet-facts' }, el('span', null, `${nf(d.w)} × ${nf(d.h)} mm`), ...facts.map(([k, v]) => el('span', null, k + ': ', el('b', null, v)))),
        el('div', { class: 'sheet-actions' }, zoomBtn, dxfBtn)),
      el('div', { class: 'sheet-view' }, svg));
  }

  function openZoom(s, i, result, snap) {
    const dlg = $('zoomDlg');
    $('zoomTitle').textContent = `Arkusz ${i + 1} z ${result.sheets.length} · ${nf(snap.sheets[s.t].w)} × ${nf(snap.sheets[s.t].h)} mm`;
    const body = $('zoomBody');
    body.textContent = '';
    body.append(sheetSVG(s, snap, 1000 + i));
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function renderBOM(result, snap) {
    const per = snap.parts.map(() => result.sheets.map(() => 0));
    result.sheets.forEach((s, si) => s.placements.forEach(pl => { per[pl.pi][si]++; }));
    const showSheets = result.sheets.length <= 12;
    const head = el('tr', null, el('th', null, 'Detal'), el('th', { class: 'num' }, 'Wymiary [mm]'), el('th', { class: 'num' }, 'Zamówione'), el('th', { class: 'num' }, 'Rozmieszczone'),
      ...(showSheets ? result.sheets.map((_, i) => el('th', { class: 'num' }, 'Ark. ' + (i + 1))) : []), el('th', null, 'Status'));
    const rows = snap.parts.map((p, pi) => {
      const placed = per[pi].reduce((a, b) => a + b, 0);
      return el('tr', null,
        el('td', null, el('span', { class: 'swatch', style: `--pc:${p.color}` }), p.name),
        el('td', { class: 'num' }, `${nf(p.w, 1)} × ${nf(p.h, 1)}`),
        el('td', { class: 'num' }, nf(p.qty)),
        el('td', { class: 'num' }, nf(placed)),
        ...(showSheets ? per[pi].map(n => el('td', { class: 'num' }, n ? nf(n) : '·')) : []),
        el('td', null, el('span', { class: 'pill ' + (placed === p.qty ? 'ok' : 'miss') }, placed === p.qty ? 'komplet' : `brak ${p.qty - placed}`)));
    });
    const bom = $('bom');
    bom.textContent = '';
    bom.append(el('h3', null, 'Zestawienie detali'), el('div', { class: 'table-wrap' }, el('table', null, el('thead', null, head), el('tbody', null, rows))));
  }

  /* ================================================================ eksport */
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function exportDXF(indexes) {
    const run = state.run;
    if (!run || !run.result) return;
    const { snapshot: snap, result } = run;
    const idx = indexes || result.sheets.map((_, i) => i);
    let oy = 0;
    const sheets = idx.map(i => {
      const s = result.sheets[i], d = snap.sheets[s.t];
      const out = {
        W: d.w, H: d.h, offsetX: 0, offsetY: oy, title: `ARKUSZ ${i + 1} - ${d.w} x ${d.h}`,
        placements: s.placements.map(pl => ({ part: snap.parts[pl.pi], deg: pl.deg, dx: pl.dx, dy: pl.dy }))
      };
      oy += d.h + Math.max(100, d.h * 0.15);
      return out;
    });
    if (indexes && indexes.length === 1) { sheets[0].offsetY = 0; }
    const txt = DxfWrite.build(sheets, { labels: $('dxfLabels').checked });
    const stamp = new Date().toISOString().slice(0, 10);
    download(indexes && indexes.length === 1 ? `rozkroj_${stamp}_arkusz${indexes[0] + 1}.dxf` : `rozkroj_${stamp}_wszystkie.dxf`, txt, 'application/dxf');
  }

  function exportCSV() {
    const run = state.run;
    if (!run || !run.result) return;
    const { snapshot: snap, result } = run;
    const rows = [['Arkusz', 'Format [mm]', 'Detal', 'Obrot [deg]', 'X [mm]', 'Y [mm]', 'Pole [mm2]']];
    result.sheets.forEach((s, i) => {
      const d = snap.sheets[s.t];
      s.placements.forEach(pl => {
        const p = snap.parts[pl.pi];
        rows.push([i + 1, `${d.w}x${d.h}`, p.name, pl.deg, pl.dx.toFixed(2), pl.dy.toFixed(2), p.area.toFixed(0)]);
      });
    });
    const U = utilization(result, snap);
    rows.push([]);
    rows.push(['Wykorzystanie [%]', (U.util * 100).toFixed(2)]);
    rows.push(['Liczba arkuszy', result.sheets.length]);
    const csv = '﻿' + rows.map(r => r.map(v => { const s = String(v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
    download(`rozkroj_${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv');
  }

  /* ================================================================ zdarzenia */
  function bind() {
    $('fileInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    $('dirInput').addEventListener('change', e => { importFiles(e.target.files); e.target.value = ''; });
    const dz = $('dropzone');
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); } });
    ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { if (ev === 'dragleave' && e.relatedTarget) return; dz.classList.remove('over'); }));
    document.addEventListener('drop', async e => {
      e.preventDefault();
      dz.classList.remove('over');
      const items = e.dataTransfer.items;
      let files;
      if (items && items.length && items[0].webkitGetAsEntry) files = await entriesToFiles(Array.from(items).map(i => i.webkitGetAsEntry()));
      else files = Array.from(e.dataTransfer.files);
      importFiles(files);
    });

    $('samplesBtn').addEventListener('click', () => {
      state.parts = state.parts.filter(p => !p.sample).concat(Samples.build(Geometry, importOpts()));
      renderParts(); saveParts();
    });
    $('clearPartsBtn').addEventListener('click', () => { state.parts = []; $('importLog').textContent = ''; renderParts(); saveParts(); });
    $('bulkQtyBtn').addEventListener('click', () => {
      const q = Math.max(0, Math.round(+$('bulkQty').value || 0));
      state.parts.forEach(p => { p.qty = q; });
      renderParts(); saveParts();
    });

    $('addRectBtn').addEventListener('click', () => { $('rectForm').hidden = !$('rectForm').hidden; $('circleForm').hidden = true; });
    $('addCircleBtn').addEventListener('click', () => { $('circleForm').hidden = !$('circleForm').hidden; $('rectForm').hidden = true; });
    $('rectForm').addEventListener('submit', e => {
      e.preventDefault();
      const w = +$('rectW').value, h = +$('rectH').value, q = Math.max(1, Math.round(+$('rectQ').value || 1));
      if (!(w > 0 && h > 0)) return;
      addSimplePart(`Prostokąt ${nf(w)}×${nf(h)}`, [[0, 0], [w, 0], [w, h], [0, h]], [], [
        { k: 'L', a: [0, 0], b: [w, 0] }, { k: 'L', a: [w, 0], b: [w, h] }, { k: 'L', a: [w, h], b: [0, h] }, { k: 'L', a: [0, h], b: [0, 0] }], q);
    });
    $('circleForm').addEventListener('submit', e => {
      e.preventDefault();
      const D = +$('circD').value, dd = +$('circd').value || 0, q = Math.max(1, Math.round(+$('circQ').value || 1));
      if (!(D > 0) || dd >= D) return;
      const tol = importOpts().tol;
      const outer = Geometry.arcPoints([D / 2, D / 2], D / 2, 0, Math.PI * 2, tol, true).slice(0, -1);
      const holes = dd > 0 ? [Geometry.arcPoints([D / 2, D / 2], dd / 2, 0, Math.PI * 2, tol, true).slice(0, -1)] : [];
      const prims = [{ k: 'C', c: [D / 2, D / 2], r: D / 2 }].concat(dd > 0 ? [{ k: 'C', c: [D / 2, D / 2], r: dd / 2 }] : []);
      addSimplePart(dd > 0 ? `Pierścień Ø${nf(D)}/Ø${nf(dd)}` : `Krążek Ø${nf(D)}`, outer, holes, prims, q);
    });

    $('addSheetBtn').addEventListener('click', () => {
      const last = state.sheets[state.sheets.length - 1] || { w: 2500, h: 1250 };
      state.sheets.push({ w: last.w, h: last.h, count: '' });
      renderSheets(); saveSettings();
    });
    document.querySelectorAll('[data-sheet]').forEach(b => b.addEventListener('click', () => {
      const [w, h] = b.dataset.sheet.split('x').map(Number);
      // zamień jedyny arkusz albo dopisz nowy
      if (state.sheets.length === 1) state.sheets[0] = { w, h, count: state.sheets[0].count };
      else state.sheets.push({ w, h, count: '' });
      renderSheets(); saveSettings();
    }));

    for (const id of settingIds) $(id).addEventListener('change', saveSettings);

    $('runBtn').addEventListener('click', () => run());
    $('stopBtn').addEventListener('click', () => { if (state.optimizer) state.optimizer.finishNow(); });
    $('dxfAllBtn').addEventListener('click', () => exportDXF(null));
    $('csvBtn').addEventListener('click', exportCSV);
    $('zoomClose').addEventListener('click', () => $('zoomDlg').close());
    $('zoomDlg').addEventListener('click', e => { if (e.target === $('zoomDlg')) $('zoomDlg').close(); });
  }

  function showEmpty() {
    $('sheetList').append(el('div', { class: 'empty' },
      el('h3', null, 'Tu pojawi się rozkrój'),
      el('p', null, 'Wczytaj detale z plików DXF/DWG, ustaw ilości i format arkusza, a potem kliknij „Rozmieść detale”.')));
  }

  /* ================================================================ start */
  function init() {
    $('pThreads').placeholder = String(defaultThreads());
    loadSettings();
    bind();
    renderSheets();
    const saved = loadParts();
    if (saved && saved.length) {
      state.parts = saved;
      renderParts();
      showEmpty();
    } else {
      // Pierwsze uruchomienie: przykładowe detale i szybki rozkrój pokazowy
      state.parts = Samples.build(Geometry, importOpts());
      renderParts();
      state.note = 'To są przykładowe detale, rozłożone automatycznie na pokaz. Wczytaj własne pliki DXF/DWG, a przykłady znikną.';
      setTimeout(() => run({ timeLimit: 6 }), 50);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
