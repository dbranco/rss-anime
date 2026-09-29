// Cobertura nueva (Task 9): resolveAndPlay/resolveSlug de src/app/ui/resolve.js (Task 6). Plan A
// resuelve un solo sitio (el primero configurado en "players" para el idioma del usuario en pista
// SUB) de forma perezosa: busca por título la primera vez, deja elegir el resultado correcto, y
// cachea el slug elegido en item.players["lang|sub"] para no volver a buscar. Usa el mismo
// mock_site.py (8001) que ya monta src/test/run.sh para engine.search/episodePlayers — no hace
// falta un mock nuevo.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { JSDOM } from "jsdom";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, { timeout = 3000, step = 10 } = {}) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: timeout");
    await sleep(step);
  }
};

const providerRule = JSON.parse(fs.readFileSync(new URL("../mock-provider.json", import.meta.url), "utf8"))[0];

describe("ui/resolve: resolveAndPlay / resolveSlug", () => {
  let dom, n = 0;

  beforeEach(() => {
    dom = new JSDOM('<div id="playerBox"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    const data = {};
    globalThis.chrome = { storage: { local: {
      get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
      set: async o => { Object.assign(data, structuredClone(o)); }
    } } }; // sin chrome.permissions: ensurePermissions() es un no-op (ver ui/permissions.spec.js)
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.document; delete globalThis.DOMParser; });

  // Cada test importa su propia instancia de resolve.js/store.js (?nN) para no compartir estado
  // de módulo entre tests (mismo patrón que src/test/tmdb.spec.js y ui/permissions.spec.js).
  const load = async () => {
    n += 1;
    const store = await import(`../../app/store.js?resolve${n}`);
    const resolve = await import(`../../app/ui/resolve.js?resolve${n}`);
    return { store, resolve };
  };

  it('sin ningún rule configurado para el idioma → mensaje claro sin reventar', async () => {
    const { store, resolve } = await load();
    await store.set("players", {}); // ninguna entrada para "es-ES"
    const box = dom.window.document.getElementById("playerBox");
    const item = { tmdb_id: 1, title: "Re:Zero", players: {} };
    await assert.doesNotReject(() => resolve.resolveAndPlay(item, 1, box));
    assert.match(box.textContent, /No hay ningún sitio de reproducción configurado/);
  });

  it("con un rule configurado y sin slug cacheado → busca y expone los resultados para elegir", async () => {
    const { store, resolve } = await load();
    const list = await import(`../../app/list.js?resolve${n}`);
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    const item = { tmdb_id: 2, media_type: "tv", title: "Re:Zero", poster_path: null, players: {} };
    await list.add(item);

    const box = dom.window.document.getElementById("playerBox");
    const done = resolve.resolveAndPlay(item, 3, box); // no se espera todavía: se queda colgado hasta elegir

    await waitFor(() => box.querySelector("button"));
    const options = [...box.querySelectorAll("button")];
    assert.equal(options.length, 1, "expone los resultados de la búsqueda para elegir");
    assert.equal(options[0].textContent, "Re:Zero");
    options[0].onclick(); // dom.js#btn() asigna onclick como propiedad, no via addEventListener

    await done; // ahora sí se completa: siguió resolviendo servidores tras la elección
    assert.ok(box.querySelector("select"), "renderPlayerPicker montó los selects de track/servidor");
    const watchlist = await store.get("watchlist", []);
    const saved = watchlist.find(w => w.tmdb_id === 2);
    assert.deepEqual(saved.players["es-ES|sub"], { providerId: providerRule.id, slug: "re-zero" },
      "el slug elegido queda cacheado en item.players para no volver a buscar");
  });

  it("sin resultados con item.title pero original_title sí matchea → reintenta y resuelve", async () => {
    const { store, resolve } = await load();
    const list = await import(`../../app/list.js?resolve${n}`);
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    const item = {
      tmdb_id: 4, media_type: "tv", title: "Título que no existe en el catálogo",
      original_title: "Re:Zero", poster_path: null, players: {}
    };
    await list.add(item);

    const box = dom.window.document.getElementById("playerBox");
    const done = resolve.resolveAndPlay(item, 3, box);

    await waitFor(() => box.querySelector("button"));
    const options = [...box.querySelectorAll("button")];
    assert.equal(options.length, 1, "el reintento con original_title sí encontró un resultado");
    options[0].onclick();

    await done;
    assert.ok(box.querySelector("select"), "resolvió el player tras el reintento");
  });

  it("sin resultados con title ni original_title, pero sí con el título romaji de TMDB → reintenta y resuelve", async () => {
    const { store, resolve } = await load();
    const list = await import(`../../app/list.js?resolve${n}`);
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    await store.set("tmdb_key", "test-key");

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.includes("api.themoviedb.org")) {
        if (u.includes("/tv/5/alternative_titles")) {
          return { ok: true, json: async () => ({ results: [
            { iso_3166_1: "JP", title: "No coincide con el catálogo", type: "" },
            { iso_3166_1: "JP", title: "Re:Zero", type: "romaji" }
          ] }) };
        }
        if (u.includes("/tv/5")) return { ok: true, json: async () => ({ name: "Título que no existe", origin_country: ["JP"] }) };
        throw new Error("URL TMDB inesperada: " + u);
      }
      return realFetch(url, opts);
    };

    try {
      const item = {
        tmdb_id: 5, media_type: "tv", title: "Título que no existe en el catálogo",
        original_title: "Tampoco existe este título", poster_path: null, players: {}
      };
      await list.add(item);

      const box = dom.window.document.getElementById("playerBox");
      const done = resolve.resolveAndPlay(item, 3, box);

      await waitFor(() => box.querySelector("button"));
      const options = [...box.querySelectorAll("button")];
      assert.equal(options.length, 1, "el reintento con el título romaji de TMDB encontró un resultado");
      options[0].onclick();

      await done;
      assert.ok(box.querySelector("select"), "resolvió el player tras el 3er intento (romaji)");
    } finally { globalThis.fetch = realFetch; }
  });

  it("con slug ya cacheado en item.players → no vuelve a buscar (usa el slug directo)", async () => {
    const { store, resolve } = await load();
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    // Título que el catálogo del mock no encontraría — si resolveSlug volviera a buscar en vez de
    // usar el slug cacheado, esto terminaría en "Sin resultados en mock", no en el player.
    const item = {
      tmdb_id: 3, title: "Título que no existe en el catálogo",
      players: { "es-ES|sub": { providerId: providerRule.id, slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box); // se resuelve sola: nunca hay elección pendiente
    assert.ok(box.querySelector("select"), "fue directo a episodePlayers con el slug cacheado, sin buscar");
  });
});
