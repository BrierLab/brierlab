// A small gradient-boosted tree classifier, written out in full so the whole
// model can be read, rerun and checked without installing anything.
// Log loss, histogram splits, Newton leaf values, row subsampling.

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Deterministic random numbers, so a retrain on the same data gives the same model.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cut points per feature at evenly spaced quantiles of the training values.
function binEdges(X, maxBins) {
  const d = X[0].length;
  const edges = [];
  for (let j = 0; j < d; j++) {
    const v = X.map((r) => r[j]).sort((a, b) => a - b);
    const uniq = [...new Set(v)];
    let cuts;
    if (uniq.length <= maxBins) {
      cuts = uniq.slice(0, -1).map((u, i) => (u + uniq[i + 1]) / 2);
    } else {
      cuts = [];
      for (let b = 1; b < maxBins; b++) {
        const c = v[Math.floor((b * v.length) / maxBins)];
        if (!cuts.length || c > cuts[cuts.length - 1]) cuts.push(c);
      }
    }
    edges.push(cuts);
  }
  return edges;
}

const binOf = (cuts, x) => {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x > cuts[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

export function fit(X, y, opts = {}) {
  const o = { trees: 300, depth: 3, rate: 0.04, subsample: 0.7, minLeaf: 25, lambda: 2, maxBins: 24, seed: 7, ...opts };
  const n = X.length;
  const d = X[0].length;
  const edges = binEdges(X, o.maxBins);
  const B = X.map((r) => Uint8Array.from(r, (x, j) => binOf(edges[j], x)));
  const rand = rng(o.seed);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const base = Math.log(mean / (1 - mean));
  const F = new Float64Array(n).fill(base);
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  const trees = [];

  const grow = (rows, depth) => {
    let G = 0;
    let H = 0;
    for (const i of rows) {
      G += g[i];
      H += h[i];
    }
    const leaf = { v: (-G / (H + o.lambda)) * o.rate };
    if (depth >= o.depth || rows.length < 2 * o.minLeaf) return leaf;
    const parent = (G * G) / (H + o.lambda);
    let best = null;
    for (let j = 0; j < d; j++) {
      const nb = edges[j].length + 1;
      if (nb < 2) continue;
      const gs = new Float64Array(nb);
      const hs = new Float64Array(nb);
      const cs = new Int32Array(nb);
      for (const i of rows) {
        const b = B[i][j];
        gs[b] += g[i];
        hs[b] += h[i];
        cs[b]++;
      }
      let gl = 0;
      let hl = 0;
      let cl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += gs[b];
        hl += hs[b];
        cl += cs[b];
        if (cl < o.minLeaf || rows.length - cl < o.minLeaf) continue;
        const gain = (gl * gl) / (hl + o.lambda) + ((G - gl) * (G - gl)) / (H - hl + o.lambda) - parent;
        if (!best || gain > best.gain) best = { gain, j, b };
      }
    }
    if (!best || best.gain <= 1e-9) return leaf;
    const left = [];
    const right = [];
    for (const i of rows) (B[i][best.j] <= best.b ? left : right).push(i);
    return { f: best.j, t: edges[best.j][best.b], gain: best.gain, l: grow(left, depth + 1), r: grow(right, depth + 1) };
  };

  const walk = (node, bins) => {
    while (node.f !== undefined) node = bins[node.f] <= binOf(edges[node.f], node.t) ? node.l : node.r;
    return node.v;
  };

  for (let t = 0; t < o.trees; t++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(F[i]);
      g[i] = p - y[i];
      h[i] = Math.max(p * (1 - p), 1e-6);
    }
    const rows = [];
    for (let i = 0; i < n; i++) if (rand() < o.subsample) rows.push(i);
    const tree = grow(rows, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += walk(tree, B[i]);
  }
  return { base, trees, opts: o };
}

export function predict(model, x, upTo = model.trees.length) {
  let z = model.base;
  for (let t = 0; t < upTo; t++) {
    let node = model.trees[t];
    while (node.f !== undefined) node = x[node.f] <= node.t ? node.l : node.r;
    z += node.v;
  }
  return sigmoid(z);
}

// Total split gain credited to each feature: a rough view of what the model leans on.
export function importance(model, names) {
  const total = names.map(() => 0);
  const visit = (node) => {
    if (node.f === undefined) return;
    total[node.f] += node.gain;
    visit(node.l);
    visit(node.r);
  };
  model.trees.forEach(visit);
  const sum = total.reduce((s, v) => s + v, 0) || 1;
  return names.map((name, j) => ({ name, share: total[j] / sum })).sort((a, b) => b.share - a.share);
}
