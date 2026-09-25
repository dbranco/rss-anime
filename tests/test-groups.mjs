// node tests/test-groups.mjs — sin mocks, funciones puras.
import assert from "node:assert/strict";
import { nextNeeded, currentStep } from "../extension/groups.js";

// nextNeeded: caso simple
assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 0), 1);
assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 3), 4);
assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 5), null); // completo

// nextNeeded: con exclusión, salta el número excluido
assert.equal(nextNeeded({ from: 21, to: 50, exclude: [25] }, 24), 26);
// nextNeeded: si solo quedan excluidos hasta `to`, cuenta como completo
assert.equal(nextNeeded({ from: 1, to: 3, exclude: [1, 2, 3] }, 0), null);

console.log("nextNeeded OK");

// currentStep: el primer paso incompleto es el actual
const g1 = {
  steps: [
    { provider: "p", slug: "a", from: 1, to: 3, exclude: [] },
    { provider: "p", slug: "b", from: 1, to: 5, exclude: [] }
  ]
};
const wl1 = [{ provider: "p", slug: "a", last: 1 }, { provider: "p", slug: "b", last: 0 }];
let cur = currentStep(g1, wl1);
assert.equal(cur.step.slug, "a");
assert.equal(cur.next, 2);

// currentStep: salta al siguiente paso cuando el primero ya está completo
const wl2 = [{ provider: "p", slug: "a", last: 3 }, { provider: "p", slug: "b", last: 0 }];
cur = currentStep(g1, wl2);
assert.equal(cur.step.slug, "b");
assert.equal(cur.next, 1);

// currentStep: grupo entero completo → null
const wl3 = [{ provider: "p", slug: "a", last: 3 }, { provider: "p", slug: "b", last: 5 }];
assert.equal(currentStep(g1, wl3), null);

// currentStep: grupo sin pasos → null
assert.equal(currentStep({ steps: [] }, wl1), null);

// currentStep: ítem del paso no está en la watchlist (borrado) — no debe crashear,
// trata `last` como 0 y deja `item` undefined para que la UI pueda avisar
const cur2 = currentStep(g1, []);
assert.equal(cur2.step.slug, "a");
assert.equal(cur2.item, undefined);
assert.equal(cur2.next, 1);

console.log("currentStep OK");
console.log("TODO OK");
