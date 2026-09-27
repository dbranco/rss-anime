// Cobertura nueva: nunca existía un test que ejercitara explícitamente el fallback de store.js
// entre chrome.storage.local y localStorage. Es exactamente el mecanismo del que depende toda la
// fusión de las Tareas 2-4, así que se fija aquí.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

describe("store: fallback chrome.storage.local / localStorage", () => {
  let dom;
  beforeEach(() => {
    dom = new JSDOM("", { url: "http://localhost" });
    globalThis.localStorage = dom.window.localStorage;
    delete globalThis.chrome;
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.localStorage; });

  it("sin chrome.storage, get/set usan localStorage", async () => {
    const { get, set } = await import("../app/store.js?nochrome");
    await set("k", { a: 1 });
    assert.deepEqual(await get("k", null), { a: 1 });
  });

  it("con chrome.storage.local presente, get/set lo usan en vez de localStorage", async () => {
    const backing = {};
    globalThis.chrome = { storage: { local: {
      get: async key => ({ [key]: backing[key] }),
      set: async obj => { Object.assign(backing, obj); }
    } } };
    const { get, set } = await import("../app/store.js?withchrome");
    await set("k2", { b: 2 });
    assert.deepEqual(await get("k2", null), { b: 2 });
    assert.equal(localStorage.getItem("k2"), null); // no tocó localStorage
  });
});
