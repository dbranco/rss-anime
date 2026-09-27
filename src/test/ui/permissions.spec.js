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
    let requested = null;
    globalThis.chrome = { permissions: { request: async o => { requested = o; return true; }, contains: async () => true } };
    const mod = await import("../../app/ui/permissions.js?withchrome");
    // OJO: permissions.js importa "./state.js" con un specifier SIN query, así que su `prov()`
    // interno lee siempre la instancia de state.js "plana" (sin query) — la misma en todo este
    // archivo, cacheada por Node desde la primera vez que se cargó. Para que este test vea el
    // provider que empuja aquí, hay que importar state.js igual, SIN query (no "?withchrome":
    // eso crearía una instancia nueva y distinta, con su propio array `providers` vacío, que
    // permissions.js nunca vería).
    const state = await import("../../app/ui/state.js");
    state.providers.push({ id: "mock", base_url: "http://127.0.0.1:8001" });
    mod.setWatchlistCache([{ provider: "mock" }]);
    await mod.ensurePermissions();
    assert.deepEqual(requested, { origins: ["http://127.0.0.1/*"] });
  });
});
