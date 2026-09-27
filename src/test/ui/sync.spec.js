// Cobertura nueva: fija que requestSync delega a chrome.runtime.sendMessage cuando existe, y usa
// syncNow() con dedup en memoria cuando no.
//
// No se agrega aquí un test del camino sin chrome.runtime porque llamaría a syncNow() real contra
// Supabase — ese camino ya está cubierto end-to-end por integration/sync-cron.spec.js.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("ui/sync: detección de entorno", () => {
  afterEach(() => { delete globalThis.chrome; });

  it("con chrome.runtime, delega al service worker", async () => {
    let sent = null;
    globalThis.chrome = { runtime: { sendMessage: async msg => { sent = msg; return { ok: true }; } } };
    const { requestSync } = await import("../../app/ui/sync.js?withchrome");
    await requestSync();
    assert.deepEqual(sent, { type: "sync" });
  });

  it("con chrome.runtime, propaga el error si la sync falla", async () => {
    globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: "boom" }) } };
    const { requestSync } = await import("../../app/ui/sync.js?withchrome-fail");
    await assert.rejects(() => requestSync(), /boom/);
  });
});
