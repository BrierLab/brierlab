// Statistical baseline: logistic regression on registration-record features,
// trained on trials whose results were posted before the test window and
// applied to the test cases. No language model involved.
// Usage: node src/baseline.mjs <train_cases.jsonl> <test_cases.jsonl> <out.jsonl>
import { readFileSync, writeFileSync } from "node:fs";

const [trainPath, testPath, outPath] = process.argv.slice(2);
if (!trainPath || !testPath || !outPath) {
  console.error("usage: node src/baseline.mjs <train_cases.jsonl> <test_cases.jsonl> <out.jsonl>");
  process.exit(1);
}

const load = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Terminated trials are left out of training: their recorded enrollment is
// the small number actually enrolled, which reveals the ending.
const train = load(trainPath).filter((c) => c.ruleLabel != null && c.status !== "TERMINATED");
const test = load(testPath);
const names = Object.keys(train[0].features);

const mean = names.map((n) => train.reduce((s, c) => s + c.features[n], 0) / train.length);
const sd = names.map((n, j) => {
  const v = train.reduce((s, c) => s + (c.features[n] - mean[j]) ** 2, 0) / train.length;
  return Math.sqrt(v) || 1;
});
const vector = (c) => names.map((n, j) => (c.features[n] - mean[j]) / sd[j]);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Plain gradient descent with a light ridge penalty; the problem is tiny.
const X = train.map(vector);
const y = train.map((c) => c.ruleLabel);
let w = names.map(() => 0);
let bias = 0;
const rate = 0.1;
const ridge = 0.01;
for (let step = 0; step < 3000; step++) {
  const gradW = names.map(() => 0);
  let gradB = 0;
  for (let i = 0; i < X.length; i++) {
    const err = sigmoid(bias + X[i].reduce((s, x, j) => s + x * w[j], 0)) - y[i];
    gradB += err;
    for (let j = 0; j < w.length; j++) gradW[j] += err * X[i][j];
  }
  bias -= (rate * gradB) / X.length;
  w = w.map((wj, j) => wj - rate * (gradW[j] / X.length + ridge * wj));
}

// Stamped like a model forecast, so baseline rows can be sealed alongside them.
const madeAt = new Date().toISOString();
const lines = test.map((c) => {
  const x = vector(c);
  const probability = sigmoid(bias + x.reduce((s, v, j) => s + v * w[j], 0));
  return JSON.stringify({ nct: c.nct, probability, model: `logistic-v1(n=${train.length})`, madeAt });
});
writeFileSync(outPath, lines.join("\n") + "\n");

const baseRate = y.reduce((s, v) => s + v, 0) / y.length;
console.log(`trained on ${train.length} trials, base rate ${baseRate.toFixed(3)}`);
console.log("weights (per standard deviation):");
for (const [j, n] of names.entries()) console.log(`  ${n.padEnd(24)} ${w[j].toFixed(3)}`);
console.log(`wrote ${lines.length} predictions to ${outPath}`);
