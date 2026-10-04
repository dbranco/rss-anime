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

  it("item.player_pref.track='dub' usa la caché de dub, no la de sub", async () => {
    const { store, resolve } = await load();
    await store.set("players", {
      "es-ES": {
        sub: [{ id: providerRule.id, rule: providerRule }],
        dub: [{ id: "mock-dub", rule: { ...providerRule, id: "mock-dub" } }]
      }
    });
    // Título que el catálogo del mock no encontraría — si resolveSlug usara la clave "es-ES|sub"
    // (o buscara en vez de usar la caché), esto no terminaría en el player.
    const item = {
      tmdb_id: 7, title: "Título que no existe en el catálogo",
      player_pref: { track: "dub" },
      players: { "es-ES|dub": { providerId: "mock-dub", slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.ok(box.querySelector("select"), "usó el slug cacheado bajo la clave 'es-ES|dub'");
  });

  it("con varios proveedores para el mismo lang+track, usa el que indica item.player_pref.providerId", async () => {
    const { store, resolve } = await load();
    const otherRule = { ...providerRule, id: "mock-other" };
    await store.set("players", {
      "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }, { id: otherRule.id, rule: otherRule }], dub: [] }
    });
    // Cacheado bajo "mock-other": si chosenRule() devolviera el primer proveedor (providerRule,
    // id "mock") en vez de respetar player_pref.providerId, el chequeo de caché de resolveSlug
    // (cached.providerId === entry.id) fallaría y volvería a buscar — y sin resultados, no
    // llegaría a mostrar el player.
    const item = {
      tmdb_id: 8, title: "Título que no existe en el catálogo",
      player_pref: { providerId: "mock-other" },
      players: { "es-ES|sub": { providerId: "mock-other", slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.ok(box.querySelector("select"), "resolvió usando el proveedor cacheado (mock-other), no el primero");
  });

  it("player_pref.providerId apunta a un proveedor que ya no existe → cae al primero configurado", async () => {
    const { store, resolve } = await load();
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    const item = {
      tmdb_id: 9, title: "Título que no existe en el catálogo",
      player_pref: { providerId: "no-existe-ya" },
      players: { "es-ES|sub": { providerId: providerRule.id, slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.ok(box.querySelector("select"), "cayó al primer proveedor configurado y usó su slug cacheado");
  });

  it("provider con episode.embed_blocked → enlace 'abrir en pestaña nueva' en vez de iframe", async () => {
    const { store, resolve } = await load();
    const blockedRule = { ...providerRule, episode: { ...providerRule.episode, embed_blocked: true } };
    await store.set("players", { "es-ES": { sub: [{ id: blockedRule.id, rule: blockedRule }], dub: [] } });
    const item = {
      tmdb_id: 6, title: "Título que no existe en el catálogo",
      players: { "es-ES|sub": { providerId: blockedRule.id, slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.equal(box.querySelector("iframe"), null, "no debe embeber un iframe para este provider");
    const a = box.querySelector("a");
    assert.ok(a, "debe mostrar un enlace en su lugar");
    assert.equal(a.target, "_blank");
    assert.equal(a.rel, "noopener");
    // Enlaza a la página del episodio en el sitio original, NO al servidor embebible scrapeado
    // (engine.episodePlayers()'s server.url) — sitios como meusanimes.blog rechazan el acceso
    // directo a ese servidor si no detectan que viene de una página de su propio dominio.
    assert.equal(a.href, "http://127.0.0.1:8001/blabla/re-zero/1");
  });

  it('slug cacheado sin servidores (título equivocado) → ofrece "Probar con otro resultado" y, al elegir otro, resuelve', async () => {
    const { store, resolve } = await load();
    const list = await import(`../../app/list.js?resolve${n}`);
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    // "no-existe" no es ninguna de las series del mock: episodePlayers() no encontrará embeds y
    // devolverá null, igual que pasaría en producción si el resultado elegido en la búsqueda
    // (ej. en un provider portugués) no era en realidad la serie buscada.
    const item = {
      tmdb_id: 10, title: "Re:Zero",
      players: { "es-ES|sub": { providerId: providerRule.id, slug: "no-existe" } }
    };
    await list.add(item);

    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.match(box.textContent, /no tiene servidores/, "avisa que el slug cacheado no tiene servidores");
    const retryBtn = [...box.querySelectorAll("button")].find(b => b.textContent.includes("Probar con otro resultado"));
    assert.ok(retryBtn, "ofrece un botón para reintentar con otro resultado en vez de dejar un callejón sin salida");

    retryBtn.onclick(); // dom.js#btn() asigna onclick como propiedad, no via addEventListener
    await waitFor(() => box.querySelector("button")?.textContent === "Re:Zero");
    const options = [...box.querySelectorAll("button")];
    assert.equal(options.length, 1, "vuelve a buscar de cero (ignorando la caché) y expone resultados para elegir");
    options[0].onclick();

    await waitFor(() => box.querySelector("select"));
    const watchlist = await store.get("watchlist", []);
    const saved = watchlist.find(w => w.tmdb_id === 10);
    assert.deepEqual(saved.players["es-ES|sub"], { providerId: providerRule.id, slug: "re-zero" },
      "sobreescribe el slug cacheado malo con el nuevo elegido");
  });
});
