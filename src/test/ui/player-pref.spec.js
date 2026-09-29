// Cobertura del componente compartido de player-pref.js (Task 2 del plan de
// docs/superpowers/specs/2026-09-29-playback-cascade-design.md): tres <select> encadenados
// (idioma → pista → proveedor) que listan solo combinaciones configuradas de verdad en
// app_config.players, y persisten la elección en item.player_pref vía mutate().
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, { timeout = 3000, step = 10 } = {}) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: timeout");
    await sleep(step);
  }
};

describe("ui/player-pref: renderPlayerPrefSelectors", () => {
  let dom, n = 0;

  beforeEach(() => {
    dom = new JSDOM('<div id="box"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    const data = {};
    globalThis.chrome = { storage: { local: {
      get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
      set: async o => { Object.assign(data, structuredClone(o)); }
    } } };
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.document; });

  const load = async () => {
    n += 1;
    const store = await import(`../../app/store.js?playerpref${n}`);
    const list = await import(`../../app/list.js?playerpref${n}`);
    const pp = await import(`../../app/ui/player-pref.js?playerpref${n}`);
    return { store, list, pp };
  };

  it("sin ningún provider configurado → no renderiza nada", async () => {
    const { store, pp } = await load();
    await store.set("players", {});
    const item = { tmdb_id: 1, title: "Re:Zero" };
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await sleep(30);
    assert.equal(box.querySelectorAll("select").length, 0);
  });

  it("con una combinación configurada → 3 selects preseleccionados, sin player_pref previo", async () => {
    const { store, pp } = await load();
    await store.set("players", { "es-ES": { sub: [{ id: "animeav1", rule: { name: "AnimeAV1" } }], dub: [] } });
    await store.set("lang_pref", "es-ES");
    const item = { tmdb_id: 2, title: "Re:Zero" };
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await waitFor(() => box.querySelectorAll("select").length === 3);
    const [langSel, trackSel, providerSel] = box.querySelectorAll("select");
    assert.equal(langSel.value, "es-ES");
    assert.equal(trackSel.value, "sub");
    assert.equal(providerSel.value, "animeav1");
    assert.deepEqual([...trackSel.options].map(o => o.value), ["sub"], "dub no tiene providers, no debe listarse");
  });

  it("cambiar el idioma repuebla pista/proveedor y persiste en item.player_pref vía mutate", async () => {
    const { store, list, pp } = await load();
    await store.set("players", {
      "es-ES": { sub: [{ id: "animeav1", rule: { name: "AnimeAV1" } }], dub: [] },
      "pt-PT": {
        sub: [{ id: "meusanimes", rule: { name: "Meus Animes" } }],
        dub: [{ id: "meusanimes-dub", rule: { name: "Meus Animes Dub" } }]
      }
    });
    await store.set("lang_pref", "es-ES");
    const item = { tmdb_id: 3, title: "Re:Zero" };
    await list.add(item);
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await waitFor(() => box.querySelectorAll("select").length === 3);
    const [langSel, trackSel, providerSel] = box.querySelectorAll("select");

    langSel.value = "pt-PT";
    langSel.onchange();
    await waitFor(() => [...trackSel.options].length === 2);
    assert.deepEqual([...trackSel.options].map(o => o.value).sort(), ["dub", "sub"]);
    assert.equal(providerSel.value, "meusanimes", "pista se resetea a la primera disponible (sub) al cambiar de idioma");

    // persist() dentro de onchange no se puede await-ear desde aquí (el handler la dispara sin
    // devolverla) y waitFor() solo soporta predicados síncronos (ver su definición arriba) —
    // esperar con sleep en vez de forzar un waitFor con predicado async, que pasaría de largo.
    await sleep(50);
    const watchlist = await store.get("watchlist", []);
    const saved = watchlist.find(w => w.tmdb_id === 3);
    assert.deepEqual(saved.player_pref, { lang: "pt-PT", track: "sub", providerId: "meusanimes" });
    assert.deepEqual(item.player_pref, { lang: "pt-PT", track: "sub", providerId: "meusanimes" },
      "sincroniza la referencia item tras mutate (mismo patrón que episode-panel.js)");
  });

  it("con player_pref ya guardado, preselecciona ese proveedor entre varios configurados", async () => {
    const { store, pp } = await load();
    await store.set("players", {
      "es-ES": { sub: [{ id: "animeav1", rule: { name: "AnimeAV1" } }, { id: "otro", rule: { name: "Otro" } }], dub: [] }
    });
    const item = { tmdb_id: 4, title: "Re:Zero", player_pref: { lang: "es-ES", track: "sub", providerId: "otro" } };
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await waitFor(() => box.querySelectorAll("select").length === 3);
    const providerSel = box.querySelectorAll("select")[2];
    assert.equal(providerSel.value, "otro");
  });
});
