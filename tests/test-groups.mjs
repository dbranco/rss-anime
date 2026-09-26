// node tests/test-groups.mjs — sin mocks, funciones puras.
import assert from "node:assert/strict";
import { nextNeeded, currentStep, itinerary } from "../extension/groups.js";

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

// itinerary: aplana los pasos en episodios individuales, con su propio número por título
// (no uno global acumulado), en el orden serie 1-5, película, serie 6-10 del enunciado real.
const g2 = {
  steps: [
    { provider: "p", slug: "serie", from: 1, to: 5, exclude: [] },
    { provider: "p", slug: "peli", from: 1, to: 1, exclude: [] },
    { provider: "p", slug: "serie", from: 6, to: 10, exclude: [] }
  ]
};
const wl4 = [{ provider: "p", slug: "serie", last: 6 }, { provider: "p", slug: "peli", last: 0 }];
const it = itinerary(g2, wl4);
assert.equal(it.length, 11); // 5 + 1 + 5, aplanado
assert.deepEqual(it.map(e => e.episode), [1, 2, 3, 4, 5, 1, 6, 7, 8, 9, 10]);
assert.equal(it[5].step.slug, "peli"); // posición 6 del itinerario = la película
// "serie" comparte last=6 entre sus dos tramos: los 1-5 del primer tramo y el 6 del segundo
// (que es el mismo episodio 6 real) quedan vistos; el resto del segundo tramo (7-10), no.
assert.deepEqual(it.map(e => e.seen), [true, true, true, true, true, false, true, false, false, false, false]);
// ítem del paso ausente del watchlist: no crashea, trata last como 0
assert.equal(itinerary({ steps: [{ provider: "p", slug: "x", from: 1, to: 2, exclude: [] }] }, []).length, 2);

console.log("itinerary OK");

// --- CRUD (con chrome.storage.local falso, mismo patrón que test-sync-cron.mjs) ---
const data = {};
globalThis.chrome = { storage: { local: {
  get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
  set: async o => { Object.assign(data, structuredClone(o)); }
} } };
const { get } = await import("../extension/store.js");
const { add } = await import("../extension/list.js");
const { addGroup, renameGroup, removeGroup, addStep, removeStep, moveStep, markUpTo, unmarkFrom, live: liveGroups } =
  await import("../extension/groups.js");

const g = await addGroup("Star Wars cronológico");
assert.equal(liveGroups(await get("groups", [])).length, 1);
assert.equal(g.steps.length, 0);

await addStep(g.id, { provider: "imdb", slug: "sw4" });
await addStep(g.id, { provider: "imdb", slug: "sw5" });
await addStep(g.id, { provider: "animeav1", slug: "clone-wars", from: 1, to: 20 });
let groups = await get("groups", []);
assert.equal(groups[0].steps.length, 3);
assert.deepEqual(groups[0].steps[0], { provider: "imdb", slug: "sw4", from: 1, to: 1, exclude: [] });

await moveStep(g.id, 0, 1); // sw4 <-> sw5
groups = await get("groups", []);
assert.equal(groups[0].steps[0].slug, "sw5");
assert.equal(groups[0].steps[1].slug, "sw4");

await removeStep(g.id, 2); // quita clone-wars
groups = await get("groups", []);
assert.equal(groups[0].steps.length, 2);

await renameGroup(g.id, "SW orden cronológico");
groups = await get("groups", []);
assert.equal(groups[0].name, "SW orden cronológico");

await removeGroup(g.id);
groups = await get("groups", []);
assert.equal(liveGroups(groups).length, 0); // borrado lógico, sigue en storage
assert.equal(groups.length, 1);

console.log("CRUD OK");

// markUpTo: monótono, nunca retrocede last aunque se le pida un episodio anterior
await add({ provider: "p", slug: "serie", title: "Serie", link: "x", image: null });
let it2 = await markUpTo({ provider: "p", slug: "serie" }, 5);
assert.equal(it2.last, 5);
it2 = await markUpTo({ provider: "p", slug: "serie" }, 3); // "hacia atrás": no debe bajar el last
assert.equal(it2.last, 5);
it2 = await markUpTo({ provider: "p", slug: "serie" }, 8);
assert.equal(it2.last, 8);

console.log("markUpTo OK");

// unmarkFrom: retrocede last a justo antes del episodio dado, nunca lo sube
it2 = await unmarkFrom({ provider: "p", slug: "serie" }, 5); // last=8 -> 4 (justo antes del 5)
assert.equal(it2.last, 4);
it2 = await unmarkFrom({ provider: "p", slug: "serie" }, 10); // "hacia delante": no debe subir el last
assert.equal(it2.last, 4);

console.log("unmarkFrom OK");
console.log("TODO OK");
