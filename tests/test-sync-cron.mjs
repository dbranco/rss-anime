// Prueba dos "máquinas" sincronizando por Supabase falso y el cron generando el RSS.
// Requiere tests/mock_site.py (8001) y tests/mock_supabase.py (8002) en marcha.
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const SB = "http://127.0.0.1:8002";
const machine = () => { // chrome.storage.local falso: una "máquina"
  const data = {};
  return { storage: { local: {
    get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async o => { Object.assign(data, structuredClone(o)); }
  } } };
};
const A = machine(), B = machine();
const use = m => { globalThis.chrome = m; };

const { get, set } = await import("../extension/store.js");
const { signUp, signIn, syncNow } = await import("../extension/sync.js");
const { add, mutate, live } = await import("../extension/list.js");
const providers = JSON.parse(fs.readFileSync(new URL("./mock-provider.json", import.meta.url), "utf8"));

// Máquina A: cuenta nueva, providers y una serie
use(A);
await set("supabase", { url: SB, anonKey: "anon" });
assert.equal((await signUp("dbranco@test.dev", "secreto123")).confirmed, true);
await set("providers", providers);
await set("providers_updated_at", new Date().toISOString());
await add({ provider: "mock", slug: "re-zero", title: "Re:Zero", link: "http://127.0.0.1:8001/blabla/re-zero", image: null });
await syncNow();
console.log("A subió providers y lista");

// Máquina B: inicia sesión y debe recibir todo
use(B);
await set("supabase", { url: SB, anonKey: "anon" });
await signIn("dbranco@test.dev", "secreto123");
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(live(await get("watchlist", [])).length, 1);
assert.ok(await get("feed_token"));
console.log("B recibió providers, lista y feed_token");

// B marca visto hasta el ep 1 → A lo recibe
await mutate("mock", "re-zero", it => { it.last = 1; });
await syncNow();
use(A); await syncNow();
assert.equal(live(await get("watchlist", []))[0].last, 1);
console.log("A recibió last=1");

// A borra → B lo ve borrado; A vuelve a añadir → B lo recupera
await mutate("mock", "re-zero", it => { it.deleted = true; });
await syncNow();
use(B); await syncNow();
assert.equal(live(await get("watchlist", [])).length, 0);
use(A); await add({ provider: "mock", slug: "re-zero", title: "Re:Zero", link: "x", image: null });
await syncNow();
use(B); await syncNow();
const back = live(await get("watchlist", []));
assert.equal(back.length, 1);
assert.equal(back[0].last, 1, "el progreso se conserva al volver a añadir");
console.log("borrado y restauración propagados");

// Cron: debe encontrar ep 2 y 3 (last=1), publicar el feed y no duplicar en la segunda pasada
const env = { ...process.env, SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: "service-key", SHOW_URL: "1" };
const run = () => execFileSync("node", ["cron/generate-feed.mjs"], { env }).toString();
const out = run();
const feedUrl = out.match(/Feed: (\S+)/)[1];
let xml = await (await fetch(feedUrl)).text();
assert.match(xml, /Re:Zero — episodio 2/);
assert.match(xml, /Re:Zero — episodio 3/);
assert.doesNotMatch(xml, /episodio 1</);
const count = s => (s.match(/<item>/g) || []).length;
assert.equal(count(xml), 2);
run();
xml = await (await fetch(feedUrl)).text();
assert.equal(count(xml), 2, "sin duplicados en la segunda pasada");
assert.match(feedUrl, new RegExp(await get("feed_token")));
console.log("cron OK:", count(xml), "items; feed en la URL del feed_token");
console.log("TODO OK");
