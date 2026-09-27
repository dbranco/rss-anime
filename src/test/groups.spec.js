// Ported from tests/test-groups.mjs — everything except the "--- CRUD ---" step-CRUD block
// (that part lives in src/test/list.spec.js). Needs DOMParser because groups.js uses engine.js
// (repairGroup intenta una búsqueda real antes de caer al placeholder del slug).
// Needs src/test/mock_site.py (8001) running for the "repairGroup con provider real" case.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

let nextNeeded, currentStep, itinerary;
let get, set, add, live;
let addGroup, addStep, markUpTo, unmarkFrom;
let missingSteps, repairGroup, setPublic, subscribe, unsubscribe, liveSubscriptions;

before(async () => {
  globalThis.DOMParser = new JSDOM("").window.DOMParser;
  ({ nextNeeded, currentStep, itinerary } = await import("../app/groups.js"));

  const data = {};
  globalThis.chrome = { storage: { local: {
    get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async o => { Object.assign(data, structuredClone(o)); }
  } } };
  ({ get, set } = await import("../app/store.js"));
  ({ add, live } = await import("../app/list.js"));
  ({ addGroup, addStep, markUpTo, unmarkFrom, missingSteps, repairGroup, setPublic, subscribe, unsubscribe, liveSubscriptions } =
    await import("../app/groups.js"));
});

describe("groups.nextNeeded", () => {
  it("caso simple", () => {
    assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 0), 1);
    assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 3), 4);
    assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 5), null); // completo
  });

  it("con exclusión, salta el número excluido", () => {
    assert.equal(nextNeeded({ from: 21, to: 50, exclude: [25] }, 24), 26);
  });

  it("si solo quedan excluidos hasta `to`, cuenta como completo", () => {
    assert.equal(nextNeeded({ from: 1, to: 3, exclude: [1, 2, 3] }, 0), null);
  });
});

describe("groups.currentStep", () => {
  const g1 = {
    steps: [
      { provider: "p", slug: "a", from: 1, to: 3, exclude: [] },
      { provider: "p", slug: "b", from: 1, to: 5, exclude: [] }
    ]
  };
  const wl1 = [{ provider: "p", slug: "a", last: 1 }, { provider: "p", slug: "b", last: 0 }];

  it("el primer paso incompleto es el actual", () => {
    const cur = currentStep(g1, wl1);
    assert.equal(cur.step.slug, "a");
    assert.equal(cur.next, 2);
  });

  it("salta al siguiente paso cuando el primero ya está completo", () => {
    const wl2 = [{ provider: "p", slug: "a", last: 3 }, { provider: "p", slug: "b", last: 0 }];
    const cur = currentStep(g1, wl2);
    assert.equal(cur.step.slug, "b");
    assert.equal(cur.next, 1);
  });

  it("grupo entero completo -> null", () => {
    const wl3 = [{ provider: "p", slug: "a", last: 3 }, { provider: "p", slug: "b", last: 5 }];
    assert.equal(currentStep(g1, wl3), null);
  });

  it("grupo sin pasos -> null", () => {
    assert.equal(currentStep({ steps: [] }, wl1), null);
  });

  it("ítem del paso no está en la watchlist (borrado) — no debe crashear, trata `last` como 0 y deja `item` undefined", () => {
    const cur2 = currentStep(g1, []);
    assert.equal(cur2.step.slug, "a");
    assert.equal(cur2.item, undefined);
    assert.equal(cur2.next, 1);
  });
});

describe("groups.itinerary", () => {
  // aplana los pasos en episodios individuales, con su propio número por título
  // (no uno global acumulado), en el orden serie 1-5, película, serie 6-10 del enunciado real.
  const g2 = {
    steps: [
      { provider: "p", slug: "serie", from: 1, to: 5, exclude: [] },
      { provider: "p", slug: "peli", from: 1, to: 1, exclude: [] },
      { provider: "p", slug: "serie", from: 6, to: 10, exclude: [] }
    ]
  };
  const wl4 = [{ provider: "p", slug: "serie", last: 6 }, { provider: "p", slug: "peli", last: 0 }];

  it("aplana en el orden correcto con el número de episodio por título", () => {
    const it_ = itinerary(g2, wl4);
    assert.equal(it_.length, 11); // 5 + 1 + 5, aplanado
    assert.deepEqual(it_.map(e => e.episode), [1, 2, 3, 4, 5, 1, 6, 7, 8, 9, 10]);
    assert.equal(it_[5].step.slug, "peli"); // posición 6 del itinerario = la película
    // "serie" comparte last=6 entre sus dos tramos: los 1-5 del primer tramo y el 6 del segundo
    // (que es el mismo episodio 6 real) quedan vistos; el resto del segundo tramo (7-10), no.
    assert.deepEqual(it_.map(e => e.seen), [true, true, true, true, true, false, true, false, false, false, false]);
  });

  it("ítem del paso ausente del watchlist: no crashea, trata last como 0", () => {
    assert.equal(itinerary({ steps: [{ provider: "p", slug: "x", from: 1, to: 2, exclude: [] }] }, []).length, 2);
  });
});

describe("groups.markUpTo / unmarkFrom", () => {
  before(async () => {
    await add({ provider: "p", slug: "serie", title: "Serie", link: "x", image: null });
  });

  it("markUpTo: monótono, nunca retrocede last aunque se le pida un episodio anterior", async () => {
    let it2 = await markUpTo({ provider: "p", slug: "serie" }, 5);
    assert.equal(it2.last, 5);
    it2 = await markUpTo({ provider: "p", slug: "serie" }, 3); // "hacia atrás": no debe bajar el last
    assert.equal(it2.last, 5);
    it2 = await markUpTo({ provider: "p", slug: "serie" }, 8);
    assert.equal(it2.last, 8);
  });

  it("unmarkFrom: retrocede last a justo antes del episodio dado, nunca lo sube", async () => {
    let it2 = await unmarkFrom({ provider: "p", slug: "serie" }, 5); // last=8 -> 4 (justo antes del 5)
    assert.equal(it2.last, 4);
    it2 = await unmarkFrom({ provider: "p", slug: "serie" }, 10); // "hacia delante": no debe subir el last
    assert.equal(it2.last, 4);
  });
});

describe("groups.missingSteps / repairGroup", () => {
  let g3;

  it("missingSteps detecta pasos sin entrada en watchlist, repairGroup los crea", async () => {
    g3 = await addGroup("Grupo con huecos");
    await addStep(g3.id, { provider: "p", slug: "serie" }); // ya está en watchlist (se añadió arriba)
    await addStep(g3.id, { provider: "p", slug: "nueva", from: 1, to: 3 }); // no está
    // addStep mutó una copia del grupo dentro de "groups" (chrome.storage.local falso hace
    // structuredClone en get/set); hay que releer para ver los steps recién añadidos.
    const freshG3 = () => get("groups", []).then(gs => gs.find(x => x.id === g3.id));

    let wl = live(await get("watchlist", []));
    const miss = missingSteps(await freshG3(), wl);
    assert.equal(miss.length, 1);
    assert.equal(miss[0].slug, "nueva");

    await repairGroup(await freshG3(), wl);
    wl = live(await get("watchlist", []));
    assert.ok(wl.find(w => w.provider === "p" && w.slug === "nueva"));
    assert.equal(missingSteps(await freshG3(), wl).length, 0, "tras reparar ya no faltan pasos");
  });

  it("repairGroup con un provider real (mock) configurado usa el título/imagen reales de la búsqueda", async () => {
    // repairGroup con un provider real (mock) configurado: si la búsqueda encuentra el
    // slug exacto, usa su título/imagen reales en vez del placeholder derivado del slug.
    await set("providers", JSON.parse(fs.readFileSync(new URL("./mock-provider.json", import.meta.url), "utf8")));
    const g4 = await addGroup("Con provider real");
    await addStep(g4.id, { provider: "mock", slug: "frieren", from: 1, to: 1 });
    await repairGroup(await get("groups", []).then(gs => gs.find(x => x.id === g4.id)), live(await get("watchlist", [])));
    const frierenItem = live(await get("watchlist", [])).find(w => w.provider === "mock" && w.slug === "frieren");
    assert.ok(frierenItem, "repairGroup creó la entrada");
    assert.equal(frierenItem.title, "Frieren", "usó el título real de la búsqueda, no el del slug");
    assert.equal(frierenItem.visible, false, "sigue creándose oculta");
  });

  it("setPublic marca el grupo como público", async () => {
    await setPublic(g3.id, true);
    assert.equal((await get("groups", [])).find(x => x.id === g3.id).public, true);
  });
});

describe("groups.subscribe / unsubscribe", () => {
  it("subscribe: repara sola la lista del suscriptor y deja la suscripción activa", async () => {
    const otherOwnerGroup = { user_id: "owner-uuid", id: "grupo-ajeno", name: "Ajeno",
      steps: [{ provider: "p", slug: "ajena", from: 1, to: 1, exclude: [] }] };
    await subscribe(otherOwnerGroup, live(await get("watchlist", [])));
    assert.ok(live(await get("watchlist", [])).find(w => w.provider === "p" && w.slug === "ajena"));
    let subs = liveSubscriptions(await get("group_subscriptions", []));
    assert.equal(subs.length, 1);
    assert.equal(subs[0].owner_id, "owner-uuid");

    await unsubscribe("owner-uuid", "grupo-ajeno");
    subs = liveSubscriptions(await get("group_subscriptions", []));
    assert.equal(subs.length, 0, "borrado lógico: ya no aparece en liveSubscriptions");
  });
});
