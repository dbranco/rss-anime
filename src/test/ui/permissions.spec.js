// Cobertura nueva: fija el comportamiento central de la Tarea 3 — ensurePermissions es un no-op
// sin chrome.permissions, y hace la petición real cuando existe.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

describe("ui/permissions: detección de entorno", () => {
  let dom;
  beforeEach(() => {
    dom = new JSDOM('<div id="permBanner" hidden></div><button id="grantPerms"></button>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    delete globalThis.chrome;
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.document; });

  it("sin chrome.permissions, ensurePermissions no hace nada", async () => {
    const { ensurePermissions } = await import("../../app/ui/permissions.js?nochrome");
    await assert.doesNotReject(() => ensurePermissions());
  });

  it("sin chrome.permissions, updatePermBanner no toca el banner", async () => {
    const { updatePermBanner } = await import("../../app/ui/permissions.js?nochrome2");
    await updatePermBanner();
    assert.equal(dom.window.document.querySelector("#permBanner").hidden, true);
  });

  it("con chrome.permissions, ensurePermissions pide los orígenes de la watchlist", async () => {
    // Hallazgo de la revisión de Task 5: state.js quedó reducido a getLangPref/setLangPref (ya no
    // hay array plano de providers), y permissions.js ya no exporta watchlistCache/
    // setWatchlistCache — ahora lee la config de sitios directo de "players" (store.js), sembrada
    // por chrome.storage.local como en el resto de este archivo. allOrigins() siempre añade
    // TMDB_ORIGIN además de cada base_url de "players" (ver src/app/ui/permissions.js, Task 5).
    let requested = null;
    const players = { "es-ES": { sub: [{ id: "mock", rule: { base_url: "http://127.0.0.1:8001" } }], dub: [] } };
    globalThis.chrome = {
      storage: { local: { get: async k => (k === "players" ? { players } : {}), set: async () => {} } },
      permissions: { request: async o => { requested = o; return true; }, contains: async () => true }
    };
    const mod = await import("../../app/ui/permissions.js?withchrome");
    await mod.ensurePermissions();
    assert.deepEqual(new Set(requested.origins), new Set(["http://127.0.0.1/*", "https://api.themoviedb.org/*"]));
  });
});
