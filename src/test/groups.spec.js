// Ported from tests/test-groups.mjs — everything except the "--- CRUD ---" step-CRUD block
// (that part lives in src/test/list.spec.js). Needs DOMParser because groups.js uses engine.js
// (repairGroup intenta una búsqueda real antes de caer al placeholder del slug).
// Identidad tmdb_id (Task 4): un paso de grupo es {tmdb_id, media_type, from, to, exclude}, ya no
// {provider, slug}. repairGroup ya no busca en un provider vía engine.js: pide el detalle exacto
// a TMDB por tmdb_id (tmdb.getShow) — se mockea igual que src/test/tmdb.spec.js (Task 1):
// sembrando tmdb_key y stubeando fetch (aquí, vía el helper compartido tmdb_fetch_stub.mjs).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installTmdbFetchStub } from "./tmdb_fetch_stub.mjs";

let nextNeeded, currentStep, itinerary;
let get, set, add, live;
let addGroup, addStep, markUpTo, unmarkFrom;
let missingSteps, repairGroup, setPublic, subscribe, unsubscribe, liveSubscriptions;

// tmdb_id "conocido" por el stub de TMDB (repairGroup usa su título/poster reales); cualquier
// otro tmdb_id no listado aquí simula "TMDB no lo encontró" (404), y repairGroup cae al
// placeholder `#${tmdb_id}` — mismo camino que "sin conexión".
const FRIEREN = 4001;
const SHOWS = { [FRIEREN]: { name: "Frieren", poster_path: "/frieren.jpg" } };

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

  await set("tmdb_key", "test-key");
  installTmdbFetchStub(SHOWS);
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
      { tmdb_id: 201, media_type: "tv", from: 1, to: 3, exclude: [] },
      { tmdb_id: 202, media_type: "tv", from: 1, to: 5, exclude: [] }
    ]
  };
  const wl1 = [{ tmdb_id: 201, last: 1 }, { tmdb_id: 202, last: 0 }];

  it("el primer paso incompleto es el actual", () => {
    const cur = currentStep(g1, wl1);
    assert.equal(cur.step.tmdb_id, 201);
    assert.equal(cur.next, 2);
  });

  it("salta al siguiente paso cuando el primero ya está completo", () => {
    const wl2 = [{ tmdb_id: 201, last: 3 }, { tmdb_id: 202, last: 0 }];
    const cur = currentStep(g1, wl2);
    assert.equal(cur.step.tmdb_id, 202);
    assert.equal(cur.next, 1);
  });

  it("grupo entero completo -> null", () => {
    const wl3 = [{ tmdb_id: 201, last: 3 }, { tmdb_id: 202, last: 5 }];
    assert.equal(currentStep(g1, wl3), null);
  });

  it("grupo sin pasos -> null", () => {
    assert.equal(currentStep({ steps: [] }, wl1), null);
  });

  it("ítem del paso no está en la watchlist (borrado) — no debe crashear, trata `last` como 0 y deja `item` undefined", () => {
    const cur2 = currentStep(g1, []);
    assert.equal(cur2.step.tmdb_id, 201);
    assert.equal(cur2.item, undefined);
    assert.equal(cur2.next, 1);
  });
});

describe("groups.itinerary", () => {
  // aplana los pasos en episodios individuales, con su propio número por título
  // (no uno global acumulado), en el orden serie 1-5, película, serie 6-10 del enunciado real.
  const g2 = {
    steps: [
      { tmdb_id: 301, media_type: "tv", from: 1, to: 5, exclude: [] },
      { tmdb_id: 302, media_type: "movie", from: 1, to: 1, exclude: [] },
      { tmdb_id: 301, media_type: "tv", from: 6, to: 10, exclude: [] }
    ]
  };
  const wl4 = [{ tmdb_id: 301, last: 6 }, { tmdb_id: 302, last: 0 }];

  it("aplana en el orden correcto con el número de episodio por título", () => {
    const it_ = itinerary(g2, wl4);
    assert.equal(it_.length, 11); // 5 + 1 + 5, aplanado
    assert.deepEqual(it_.map(e => e.episode), [1, 2, 3, 4, 5, 1, 6, 7, 8, 9, 10]);
    assert.equal(it_[5].step.tmdb_id, 302); // posición 6 del itinerario = la película
    // "serie" (tmdb_id 301) comparte last=6 entre sus dos tramos: los 1-5 del primer tramo y el 6
    // del segundo (que es el mismo episodio 6 real) quedan vistos; el resto del segundo tramo
    // (7-10), no.
    assert.deepEqual(it_.map(e => e.seen), [true, true, true, true, true, false, true, false, false, false, false]);
  });

  it("ítem del paso ausente del watchlist: no crashea, trata last como 0", () => {
    assert.equal(itinerary({ steps: [{ tmdb_id: 999, media_type: "tv", from: 1, to: 2, exclude: [] }] }, []).length, 2);
  });
});

describe("groups.markUpTo / unmarkFrom", () => {
  const SERIE = 401;
  before(async () => {
    await add({ tmdb_id: SERIE, media_type: "tv", title: "Serie", poster_path: null });
  });

  it("markUpTo: monótono, nunca retrocede last aunque se le pida un episodio anterior", async () => {
    let it2 = await markUpTo({ tmdb_id: SERIE }, 5);
    assert.equal(it2.last, 5);
    it2 = await markUpTo({ tmdb_id: SERIE }, 3); // "hacia atrás": no debe bajar el last
    assert.equal(it2.last, 5);
    it2 = await markUpTo({ tmdb_id: SERIE }, 8);
    assert.equal(it2.last, 8);
  });

  it("unmarkFrom: retrocede last a justo antes del episodio dado, nunca lo sube", async () => {
    let it2 = await unmarkFrom({ tmdb_id: SERIE }, 5); // last=8 -> 4 (justo antes del 5)
    assert.equal(it2.last, 4);
    it2 = await unmarkFrom({ tmdb_id: SERIE }, 10); // "hacia delante": no debe subir el last
    assert.equal(it2.last, 4);
  });
});

describe("groups.missingSteps / repairGroup", () => {
  const SERIE = 401; // el mismo tmdb_id que el bloque anterior: "ya está en watchlist"
  const NUEVA = 402; // desconocido para el stub de TMDB: repairGroup cae al placeholder
  let g3;

  it("missingSteps detecta pasos sin entrada en watchlist, repairGroup los crea", async () => {
    g3 = await addGroup("Grupo con huecos");
    await addStep(g3.id, { tmdb_id: SERIE, media_type: "tv" }); // ya está en watchlist (se añadió arriba)
    await addStep(g3.id, { tmdb_id: NUEVA, media_type: "tv", from: 1, to: 3 }); // no está
    // addStep mutó una copia del grupo dentro de "groups" (chrome.storage.local falso hace
    // structuredClone en get/set); hay que releer para ver los steps recién añadidos.
    const freshG3 = () => get("groups", []).then(gs => gs.find(x => x.id === g3.id));

    let wl = live(await get("watchlist", []));
    const miss = missingSteps(await freshG3(), wl);
    assert.equal(miss.length, 1);
    assert.equal(miss[0].tmdb_id, NUEVA);

    await repairGroup(await freshG3(), wl);
    wl = live(await get("watchlist", []));
    const nuevaItem = wl.find(w => w.tmdb_id === NUEVA);
    assert.ok(nuevaItem, "repairGroup creó la entrada aunque TMDB no conociera el id");
    assert.equal(nuevaItem.title, `#${NUEVA}`, "TMDB (mock) no lo tiene: placeholder derivado del tmdb_id");
    assert.equal(missingSteps(await freshG3(), wl).length, 0, "tras reparar ya no faltan pasos");
  });

  it("repairGroup con tmdb.getShow exitoso usa el título/imagen reales de TMDB", async () => {
    // Si TMDB conoce el tmdb_id exacto del paso, repairGroup usa su título/poster reales en vez
    // del placeholder `#${tmdb_id}` — no hay ambigüedad posible (a diferencia de una búsqueda por
    // texto contra un provider), así que no hace falta ningún "adivinar": o hay una respuesta
    // única y correcta, o no hay ninguna.
    const g4 = await addGroup("Con TMDB real");
    await addStep(g4.id, { tmdb_id: FRIEREN, media_type: "tv", from: 1, to: 1 });
    await repairGroup(await get("groups", []).then(gs => gs.find(x => x.id === g4.id)), live(await get("watchlist", [])));
    const frierenItem = live(await get("watchlist", [])).find(w => w.tmdb_id === FRIEREN);
    assert.ok(frierenItem, "repairGroup creó la entrada");
    assert.equal(frierenItem.title, "Frieren", "usó el título real de TMDB, no el placeholder");
    assert.equal(frierenItem.poster_path, "/frieren.jpg");
    assert.equal(frierenItem.visible, false, "sigue creándose oculta");
  });

  it("setPublic marca el grupo como público", async () => {
    await setPublic(g3.id, true);
    assert.equal((await get("groups", [])).find(x => x.id === g3.id).public, true);
  });
});

describe("groups.subscribe / unsubscribe", () => {
  const AJENA = 601; // desconocido para el stub de TMDB: repairGroup cae al placeholder, no importa
  it("subscribe: repara sola la lista del suscriptor y deja la suscripción activa", async () => {
    const otherOwnerGroup = { user_id: "owner-uuid", id: "grupo-ajeno", name: "Ajeno",
      steps: [{ tmdb_id: AJENA, media_type: "tv", from: 1, to: 1, exclude: [] }] };
    await subscribe(otherOwnerGroup, live(await get("watchlist", [])));
    assert.ok(live(await get("watchlist", [])).find(w => w.tmdb_id === AJENA));
    let subs = liveSubscriptions(await get("group_subscriptions", []));
    assert.equal(subs.length, 1);
    assert.equal(subs[0].owner_id, "owner-uuid");

    await unsubscribe("owner-uuid", "grupo-ajeno");
    subs = liveSubscriptions(await get("group_subscriptions", []));
    assert.equal(subs.length, 0, "borrado lógico: ya no aparece en liveSubscriptions");
  });
});
