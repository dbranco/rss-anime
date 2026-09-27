// "Parte que ejercita sync.js directamente" de tests/test-sync-cron.mjs.
//
// NOTA de la migración: en el script original, la ÚNICA aserción de tests/test-sync-cron.mjs que
// no depende de una segunda "máquina" (propagación) es la del signUp de la máquina A
// (`assert.equal((await signUp(...)).confirmed, true)`, línea 35). Todo lo demás — saveAppProviders,
// syncNow, searchPublicGroups, rateGroup, signOut/ACCOUNT_KEYS — solo se comprueba de verdad
// verificando que otra máquina recibe lo que la primera subió, así que es inherentemente un
// escenario multiusuario y se ha portado tal cual a integration/sync-cron.spec.js (Step 8), que
// conserva TODAS las aserciones originales del archivo sin recortar ninguna.
//
// Este archivo añade una comprobación mínima, autocontenida, de signUp() usando una cuenta propia
// (distinta a "dbranco@test.dev"/"otra@test.dev" de integration/sync-cron.spec.js) para no
// compartir estado con el mock de Supabase que usa ese otro spec — signUp no toca ninguna tabla
// aparte del USERS interno del mock, así que no hay riesgo de interferencia entre archivos.
// Requiere src/test/mock_supabase.py (8002) en marcha.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const SB = "http://127.0.0.1:8002";

let set, signUp;

before(async () => {
  globalThis.chrome = { storage: { local: (() => {
    const data = {};
    return {
      get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
      set: async o => { Object.assign(data, structuredClone(o)); }
    };
  })() } };
  ({ set } = await import("../app/store.js"));
  ({ signUp } = await import("../app/sync.js"));
  await set("supabase", { url: SB, anonKey: "anon" });
});

describe("sync.signUp", () => {
  it("da de alta una cuenta nueva y devuelve confirmed:true", async () => {
    assert.equal((await signUp("sync-spec@test.dev", "secreto123")).confirmed, true);
  });
});
