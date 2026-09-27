// Ported from tests/test-groups.mjs — the "--- CRUD (con chrome.storage.local falso...) ---"
// block, which sets up list.js (add/live) alongside groups.js to exercise step CRUD on a group.
// Needs DOMParser because groups.js (used here to build the group) uses engine.js.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let get, addGroup, renameGroup, removeGroup, addStep, removeStep, moveStep, liveGroups;
let g;

before(async () => {
  globalThis.DOMParser = new JSDOM("").window.DOMParser;
  // --- CRUD (con chrome.storage.local falso, mismo patrón que test-sync-cron.mjs) ---
  const data = {};
  globalThis.chrome = { storage: { local: {
    get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async o => { Object.assign(data, structuredClone(o)); }
  } } };
  ({ get } = await import("../app/store.js"));
  await import("../app/list.js"); // add/live: cargados aquí igual que en el original, se usan en groups.spec.js
  ({ addGroup, renameGroup, removeGroup, addStep, removeStep, moveStep, live: liveGroups } =
    await import("../app/groups.js"));
});

describe("groups: CRUD de pasos (addGroup/addStep/moveStep/removeStep/renameGroup/removeGroup)", () => {
  it("addGroup crea un grupo vacío, visible en liveGroups", async () => {
    g = await addGroup("Star Wars cronológico");
    assert.equal(liveGroups(await get("groups", [])).length, 1);
    assert.equal(g.steps.length, 0);
  });

  it("addStep añade pasos con los defaults from/to/exclude", async () => {
    await addStep(g.id, { provider: "imdb", slug: "sw4" });
    await addStep(g.id, { provider: "imdb", slug: "sw5" });
    await addStep(g.id, { provider: "animeav1", slug: "clone-wars", from: 1, to: 20 });
    const groups = await get("groups", []);
    assert.equal(groups[0].steps.length, 3);
    assert.deepEqual(groups[0].steps[0], { provider: "imdb", slug: "sw4", from: 1, to: 1, exclude: [] });
  });

  it("moveStep intercambia dos pasos", async () => {
    await moveStep(g.id, 0, 1); // sw4 <-> sw5
    const groups = await get("groups", []);
    assert.equal(groups[0].steps[0].slug, "sw5");
    assert.equal(groups[0].steps[1].slug, "sw4");
  });

  it("removeStep quita un paso por índice", async () => {
    await removeStep(g.id, 2); // quita clone-wars
    const groups = await get("groups", []);
    assert.equal(groups[0].steps.length, 2);
  });

  it("renameGroup cambia el nombre", async () => {
    await renameGroup(g.id, "SW orden cronológico");
    const groups = await get("groups", []);
    assert.equal(groups[0].name, "SW orden cronológico");
  });

  it("removeGroup es un borrado lógico: sigue en storage pero no en liveGroups", async () => {
    await removeGroup(g.id);
    const groups = await get("groups", []);
    assert.equal(liveGroups(groups).length, 0); // borrado lógico, sigue en storage
    assert.equal(groups.length, 1);
  });
});
