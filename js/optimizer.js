/*
 * Optymalizator: algorytm genetyczny (wariant "steady-state") nad kolejnością wkładania detali.
 * Ocena każdego osobnika (pełne rozmieszczenie) odbywa się równolegle w Web Workerach;
 * każdy worker utrzymuje własną pamięć podręczną wielokątów NFP.
 */
(function (global) {
  'use strict';

  // Kod wykonywany wewnątrz workera
  function workerMain() {
    const ClipperLib = ClipperFactory();
    const Core = NestCoreFactory(ClipperLib);
    let nester = null;
    self.onmessage = function (ev) {
      const m = ev.data;
      try {
        if (m.cmd === 'init') {
          nester = Core.createNester(m.parts, m.sheets, m.params);
          self.postMessage({ id: m.id, ok: true });
        } else if (m.cmd === 'eval') {
          const t0 = Date.now();
          const result = nester.nest(m.order);
          result.ms = Date.now() - t0;
          self.postMessage({ id: m.id, result, stats: nester.stats() });
        }
      } catch (err) {
        self.postMessage({ id: m.id, error: String(err && err.stack || err) });
      }
    };
  }

  let workerUrl = null;
  function getWorkerUrl() {
    if (!workerUrl) {
      const src = [ClipperFactory.toString(), NestCoreFactory.toString(), '(' + workerMain.toString() + ')();'].join('\n;\n');
      workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return workerUrl;
  }

  // Zastępczy "worker" w wątku głównym (gdy przeglądarka nie pozwala na Web Workery)
  function InlineWorker() {
    const ClipperLib = global.ClipperLib || ClipperFactory();
    const Core = NestCoreFactory(ClipperLib);
    let nester = null;
    this.onmessage = null;
    this.postMessage = (m) => {
      setTimeout(() => {
        let reply;
        try {
          if (m.cmd === 'init') { nester = Core.createNester(m.parts, m.sheets, m.params); reply = { id: m.id, ok: true }; }
          else { const t0 = Date.now(); const result = nester.nest(m.order); result.ms = Date.now() - t0; reply = { id: m.id, result, stats: nester.stats() }; }
        } catch (err) { reply = { id: m.id, error: String(err && err.stack || err) }; }
        if (this.onmessage) this.onmessage({ data: reply });
      }, 0);
    };
    this.terminate = () => { this.onmessage = null; };
  }

  function makeWorker() {
    try { return new Worker(getWorkerUrl()); }
    catch (e) { return new InlineWorker(); }
  }

  /* ---------------------------------------------------------------- GA */

  function shuffleSome(arr, n, rnd) {
    for (let k = 0; k < n; k++) {
      const i = Math.floor(rnd() * arr.length);
      const r = rnd();
      if (r < 0.5) { // zamiana z sąsiadem
        const j = Math.min(arr.length - 1, i + 1);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      } else if (r < 0.8) { // zamiana dowolnej pary
        const j = Math.floor(rnd() * arr.length);
        [arr[i], arr[j]] = [arr[j], arr[i]];
      } else { // przeniesienie elementu
        const j = Math.floor(rnd() * arr.length);
        const [x] = arr.splice(i, 1); arr.splice(j, 0, x);
      }
    }
    return arr;
  }

  // Krzyżowanie z zachowaniem porządku (OX)
  function orderCrossover(a, b, rnd) {
    const n = a.length;
    if (n < 3) return a.slice();
    let i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i > j) [i, j] = [j, i];
    const child = new Array(n).fill(-1);
    const used = new Set();
    for (let k = i; k <= j; k++) { child[k] = a[k]; used.add(a[k]); }
    let pos = (j + 1) % n;
    for (let k = 0; k < n; k++) {
      const g = b[(j + 1 + k) % n];
      if (used.has(g)) continue;
      child[pos] = g; pos = (pos + 1) % n;
    }
    return child;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /**
   * opts: { parts:[{outer,holes,rots,qty,area,w,h}], sheets, params, threads, timeLimit (s), popSize,
   *         onProgress(info), onBest(result), onDone(info) }
   */
  function Optimizer(opts) {
    this.opts = opts;
    this.workers = [];
    this.running = false;
  }

  Optimizer.prototype.start = function () {
    const o = this.opts;
    const parts = o.parts;
    const inst = [];
    parts.forEach((p, i) => { for (let k = 0; k < p.qty; k++) inst.push(i); });
    if (!inst.length) throw new Error('Brak detali do rozmieszczenia');
    this.inst = inst;
    const rnd = mulberry32(Date.now() & 0xffffffff);
    this.rnd = rnd;

    const N = inst.length;
    const ids = inst.map((_, i) => i);
    const by = f => ids.slice().sort((a, b) => f(inst[b]) - f(inst[a]) || a - b);
    const seeds = [
      by(pi => parts[pi].area),
      by(pi => Math.max(parts[pi].w, parts[pi].h)),
      by(pi => parts[pi].w * parts[pi].h),
      by(pi => parts[pi].h),
      by(pi => parts[pi].w),
    ];
    this.queue = seeds.slice();
    this.population = [];   // { perm, fitness, result }
    this.seen = new Map();  // klucz kolejności typów → fitness
    this.best = null;
    this.evals = 0;
    this.dupStreak = 0;
    this.t0 = performance.now();
    this.popSize = o.popSize || Math.min(30, Math.max(10, Math.round(N / 2)));
    this.running = true;
    this.pending = 0;
    this.lastImprove = this.t0;

    const threads = Math.max(1, Math.min(o.threads || 4, N));
    const payload = {
      cmd: 'init',
      parts: parts.map(p => ({ outer: p.outer, holes: p.holes, rots: p.rots })),
      sheets: o.sheets, params: o.params
    };
    let msgId = 0;
    for (let w = 0; w < threads; w++) {
      const worker = makeWorker();
      const slot = { worker, busy: true, perm: null };
      worker.onmessage = (ev) => this._onMessage(slot, ev.data);
      worker.onerror = (ev) => { if (ev.preventDefault) ev.preventDefault(); this._fail(new Error(ev.message || 'Błąd wątku obliczeniowego')); };
      worker.postMessage(Object.assign({ id: ++msgId }, payload));
      this.workers.push(slot);
    }
    this.timer = setInterval(() => this._tick(), 250);
  };

  Optimizer.prototype._fail = function (err) {
    if (!this.running) return;
    this.stop();
    if (this.opts.onError) this.opts.onError(err);
  };

  Optimizer.prototype._key = function (perm) {
    let k = '';
    for (const i of perm) k += this.inst[i] + ',';
    return k;
  };

  Optimizer.prototype._nextPerm = function () {
    while (this.queue.length) {
      const p = this.queue.shift();
      if (!this.seen.has(this._key(p))) return p;
    }
    const pop = this.population;
    if (!pop.length) return null;
    const rnd = this.rnd;
    const pick = () => { // turniej
      const a = pop[Math.floor(rnd() * pop.length)], b = pop[Math.floor(rnd() * pop.length)];
      return a.fitness <= b.fitness ? a : b;
    };
    for (let attempt = 0; attempt < 30; attempt++) {
      let child;
      if (rnd() < 0.7 && pop.length > 1) child = orderCrossover(pick().perm, pick().perm, rnd);
      else child = pick().perm.slice();
      const strength = 1 + Math.floor(rnd() * rnd() * Math.max(2, child.length / 4));
      shuffleSome(child, strength, rnd);
      if (!this.seen.has(this._key(child))) { this.dupStreak = 0; return child; }
      this.dupStreak++;
    }
    return null;
  };

  Optimizer.prototype._dispatch = function () {
    if (!this.running) return;
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const perm = this._nextPerm();
      if (!perm) break;
      this.seen.set(this._key(perm), null);
      slot.busy = true; slot.perm = perm;
      slot.worker.postMessage({ id: 0, cmd: 'eval', order: perm.map(i => this.inst[i]) });
    }
    if (this.workers.every(s => !s.busy)) this._finish('exhausted');
  };

  Optimizer.prototype._onMessage = function (slot, m) {
    if (!this.running) return;
    if (m.error) { this._fail(new Error(m.error)); return; }
    slot.busy = false;
    if (m.result) {
      this.evals++;
      this.lastStats = m.stats;
      const ind = { perm: slot.perm, fitness: m.result.fitness, result: m.result };
      this.seen.set(this._key(slot.perm), ind.fitness);
      const pop = this.population;
      pop.push(ind);
      pop.sort((a, b) => a.fitness - b.fitness);
      if (pop.length > this.popSize) pop.pop();
      if (!this.best || ind.fitness < this.best.fitness - 1e-6) {
        this.best = ind;
        this.lastImprove = performance.now();
        if (this.opts.onBest) this.opts.onBest(ind.result, this._info());
      }
    }
    this._dispatch();
  };

  Optimizer.prototype._info = function () {
    return {
      evals: this.evals, elapsed: (performance.now() - this.t0) / 1000, timeLimit: this.opts.timeLimit,
      nfp: this.lastStats ? this.lastStats.nfpCount : 0, threads: this.workers.length
    };
  };

  Optimizer.prototype._tick = function () {
    if (!this.running) return;
    const info = this._info();
    if (this.opts.onProgress) this.opts.onProgress(info);
    if (info.elapsed >= this.opts.timeLimit && this.best) this._finish('time');
    else if (this.dupStreak > 400) this._finish('exhausted');
  };

  Optimizer.prototype._finish = function (reason) {
    if (!this.running) return;
    const info = this._info();
    this.stop();
    if (this.opts.onDone) this.opts.onDone(Object.assign(info, { reason }), this.best && this.best.result);
  };

  Optimizer.prototype.stop = function () {
    this.running = false;
    clearInterval(this.timer);
    for (const s of this.workers) { try { s.worker.terminate(); } catch (_) { /* nic */ } }
    this.workers = [];
  };

  Optimizer.prototype.finishNow = function () { this._finish('user'); };

  global.Optimizer = Optimizer;
})(typeof window !== 'undefined' ? window : globalThis);
