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
const { signUp, signIn, syncNow, saveAppProviders } = await import("../extension/sync.js");
const { add, mutate, live } = await import("../extension/list.js");
const providers = JSON.parse(fs.readFileSync(new URL("./mock-provider.json", import.meta.url), "utf8"));

// Da de alta a un usuario como admin usando la service key (bypassa RLS, igual que hace
// la persona real por SQL Editor con la cuenta de Postgres).
const seedAdmin = uid => fetch(`${SB}/rest/v1/admins?on_conflict=user_id`, {
  method: "POST",
  headers: { Authorization: "Bearer service-key", "Content-Type": "application/json" },
  body: JSON.stringify([{ user_id: uid }])
});

// Máquina A: cuenta nueva, se marca admin, sube providers (config de la app) y una serie
use(A);
await set("supabase", { url: SB, anonKey: "anon" });
assert.equal((await signUp("dbranco@test.dev", "secreto123")).confirmed, true);
await seedAdmin((await get("session")).user.id);
await saveAppProviders(providers);
await add({ provider: "mock", slug: "re-zero", title: "Re:Zero", link: "http://127.0.0.1:8001/blabla/re-zero", image: null });
await syncNow();
console.log("A (admin) subió providers y lista");

// A crea un grupo con un paso
const { addGroup, addStep, live: liveGroups } = await import("../extension/groups.js");
const grupo = await addGroup("Mi maratón");
await addStep(grupo.id, { provider: "mock", slug: "re-zero", from: 1, to: 3 });
await syncNow();
console.log("A subió un grupo");

// Máquina B: inicia sesión y debe recibir todo
use(B);
await set("supabase", { url: SB, anonKey: "anon" });
await signIn("dbranco@test.dev", "secreto123");
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(await get("is_admin", false), true); // misma cuenta que A: también admin
assert.equal(live(await get("watchlist", [])).length, 1);
assert.ok(await get("feed_token"));
const groupsB = liveGroups(await get("groups", []));
assert.equal(groupsB.length, 1);
assert.equal(groupsB[0].name, "Mi maratón");
assert.equal(groupsB[0].steps[0].to, 3);
console.log("B recibió el grupo");

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

// B renombra el grupo → A lo recibe; luego A lo borra → B lo ve borrado
use(B);
const { renameGroup, removeGroup } = await import("../extension/groups.js");
await renameGroup(grupo.id, "Maratón definitivo");
await syncNow();
use(A); await syncNow();
assert.equal((await get("groups", []))[0].name, "Maratón definitivo");
await removeGroup(grupo.id);
await syncNow();
use(B); await syncNow();
assert.equal(liveGroups(await get("groups", [])).length, 0);
console.log("grupo: edición y borrado propagados");

// Cron: debe encontrar ep 2 y 3 (last=1), publicar el feed y no duplicar en la segunda pasada
const env = { ...process.env, SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: "service-key", SHOW_URL: "1" };
const run = () => execFileSync("node", ["cron/generate-feed.mjs"], { env }).toString();
const out = run();
const feedUrl = out.match(/Feed: (\S+)/)[1];
let xml = await (await fetch(feedUrl)).text();
assert.match(xml, /Re:Zero — episodio 2/);
assert.match(xml, /Re:Zero — episodio 3/);
assert.doesNotMatch(xml, /Re:Zero — episodio 1</);
const count = s => (s.match(/<item>/g) || []).length;
assert.equal(count(xml), 2);
run();
xml = await (await fetch(feedUrl)).text();
assert.equal(count(xml), 2, "sin duplicados en la segunda pasada");
assert.match(feedUrl, new RegExp(await get("feed_token")));
console.log("cron OK:", count(xml), "items; feed en la URL del feed_token");

// Grupo: pide el episodio 20 de una serie larga que el chequeo normal (ventana de 5) no mira.
// Se añade DESPUÉS del bloque anterior para no alterar su recuento (así el count==2 de arriba
// sigue siendo válido: longrun todavía no existe en ese punto).
use(A);
await add({ provider: "mock", slug: "longrun", title: "Long Run", link: "x", image: null });
const { addGroup: addGroup2, addStep: addStep2 } = await import("../extension/groups.js");
const gLong = await addGroup2("Maratón larga");
await addStep2(gLong.id, { provider: "mock", slug: "longrun", from: 20, to: 20 });
await syncNow();

run();
xml = await (await fetch(feedUrl)).text();
assert.match(xml, /Maratón larga: Long Run — episodio 20/);
const countAfterGroup = count(xml);
console.log("grupo: cron encontró el episodio 20 vía grupo,", countAfterGroup, "items en total");

run();
xml = await (await fetch(feedUrl)).text();
assert.equal(count(xml), countAfterGroup, "sin duplicados en la segunda pasada del grupo");
console.log("grupo: sin duplicados en la segunda pasada");

// Máquina C: cuenta distinta, NO admin — recibe los providers en solo lectura y no puede escribir
const C = machine();
use(C);
await set("supabase", { url: SB, anonKey: "anon" });
assert.equal((await signUp("otra@test.dev", "secreto123")).confirmed, true);
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(await get("is_admin", false), false);
// OJO: este mensaje lo inventa tests/mock_supabase.py, no es el que devuelve PostgREST real.
// Esto prueba la lógica del mock (y que el cliente propaga el error), no el RLS de Postgres.
await assert.rejects(() => saveAppProviders([{ id: "hack" }]), /solo admin/);
console.log("C (no admin) recibió providers en solo lectura y no pudo escribir");

// C también puede USAR los providers compartidos aunque no pueda escribirlos: añade una serie
// a su propia lista y comprueba que el cron (que ahora lee app_config una sola vez, no por
// usuario) también le resuelve episodios nuevos a ella. C nunca escribió providers en su
// user_settings, así que un cron que volviera a leerlos por usuario le daría un feed vacío.
await add({ provider: "mock", slug: "dandadan", title: "Dandadan", link: "http://127.0.0.1:8001/blabla/dandadan", image: null });
await syncNow();
run();
const cFeedUrl = `${SB}/storage/v1/object/public/feeds/${await get("feed_token")}.xml`;
const cXml = await (await fetch(cFeedUrl)).text();
assert.match(cXml, /Dandadan — episodio 1/);
assert.equal(count(cXml), 3, "los 3 episodios del mock para la lista de C");
console.log("C (no admin) también recibe episodios nuevos vía los providers compartidos");

console.log("TODO OK");
