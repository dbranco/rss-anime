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

const { get, set } = await import("../src/app/store.js");
const { signUp, signIn, signOut, syncNow, saveAppProviders, searchPublicGroups, rateGroup, ACCOUNT_KEYS } =
  await import("../src/app/sync.js");
const { add, mutate, live } = await import("../src/app/list.js");
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
const { addGroup, addStep, live: liveGroups } = await import("../src/app/groups.js");
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
const { renameGroup, removeGroup } = await import("../src/app/groups.js");
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
const { addGroup: addGroup2, addStep: addStep2 } = await import("../src/app/groups.js");
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

// A hace público uno de sus grupos; C lo encuentra en Explorar, se suscribe (se repara
// sola su lista), marca progreso propio SIN tocar el de A, lo valora, y el cron le
// resuelve episodios nuevos de ese grupo suscrito en SU PROPIO feed.
use(A);
const { setPublic } = await import("../src/app/groups.js");
await setPublic(gLong.id, true); // "Maratón larga" (longrun, del bloque anterior)
// Segundo grupo público con un nombre claramente distinto: sin él, "buscar 'Maratón' devuelve 1"
// no distinguía "el filtro ilike funciona" de "el mock lo ignora y devuelve el único público".
// Su paso apunta a una serie que A no tiene en su lista, así que el cron lo salta (paso colgando).
const gOther = await addGroup2("Saga Fate");
await addStep2(gOther.id, { provider: "mock", slug: "frieren", from: 1, to: 1 });
await setPublic(gOther.id, true);
await syncNow();

use(C);
await syncNow();
const allPublic = await searchPublicGroups(""); // patrón "**": todo lo público
assert.equal(allPublic.length, 2, "los dos grupos públicos de A son descubribles");
const found2 = await searchPublicGroups("Maratón");
assert.equal(found2.length, 1, "ilike filtra de verdad: 'Maratón' no arrastra 'Saga Fate'");
assert.equal(found2[0].name, "Maratón larga");
assert.equal((await searchPublicGroups("Fate")).map(g => g.name).join(), "Saga Fate");

const { subscribe, currentStep: curStepC, markUpTo } = await import("../src/app/groups.js");
await subscribe(found2[0], live(await get("watchlist", [])));
assert.ok(live(await get("watchlist", [])).find(w => w.provider === "mock" && w.slug === "longrun"),
  "suscribirse repara sola la lista de C para el paso de 'longrun'");
await syncNow();

const cSub = (await get("subscribed_groups", [])).find(g => g.name === "Maratón larga");
assert.ok(cSub, "C ve el grupo suscrito en su caché de solo lectura");
const curC = curStepC(cSub, live(await get("watchlist", [])));
assert.equal(curC.next, 20); // mismo paso "longrun 20-20" que definió A
await markUpTo(curC.step, 20);
assert.equal(live(await get("watchlist", [])).find(w => w.slug === "longrun").last, 20,
  "el progreso de C en 'longrun' es suyo, independiente del de A");
await syncNow();

use(A);
await syncNow();
assert.equal(live(await get("watchlist", [])).find(w => w.slug === "longrun")?.last ?? 0, 0,
  "A nunca marcó 'longrun' como visto — el progreso propio de C en su suscripción no le pisa nada");

use(C);
await rateGroup(found2[0].user_id, found2[0].id, 5);
const rated = await searchPublicGroups("Maratón");
assert.equal(rated[0].rating_avg, 5);
assert.equal(rated[0].rating_count, 1);
console.log("grupo público: descubrir, suscribirse (con auto-reparación), progreso propio y valorar OK");

// Visibilidad: si A despublica el grupo, la suscripción de C sigue viva pero ni la caché de solo
// lectura ni el cron vuelven a traer nada de él. El paso nuevo es el 30 de 'longrun', fuera de la
// ventana MAX_AHEAD (C va por el 20), así que solo puede llegar al feed de C vía el grupo suscrito
// — es lo que hace que estas dos aserciones distingan el filtro de un no-op.
const { liveSubscriptions } = await import("../src/app/groups.js");
use(A);
await setPublic(gLong.id, false);
await addStep2(gLong.id, { provider: "mock", slug: "longrun", from: 30, to: 30 });
await syncNow();

use(C);
await syncNow();
assert.equal((await get("subscribed_groups", [])).length, 0, "un grupo despublicado sale de la caché");
assert.equal(liveSubscriptions(await get("group_subscriptions", [])).length, 1,
  "la suscripción sigue viva: la UI pinta el hueco 'Grupo ya no disponible.' con su botón de baja");
run();
let cXml2 = await (await fetch(cFeedUrl)).text();
assert.doesNotMatch(cXml2, /episodio 30/, "el cron no alimenta desde un grupo despublicado");

// A lo vuelve a publicar: el mismo episodio sí llega ahora (el filtro no está bloqueando todo).
use(A);
await setPublic(gLong.id, true);
await syncNow();
use(C);
await syncNow();
assert.equal((await get("subscribed_groups", [])).length, 1, "al republicar, la caché lo recupera");
run();
cXml2 = await (await fetch(cFeedUrl)).text();
// "Longrun" (no "Long Run"): el ítem de la lista de C lo creó repairGroup() al suscribirse,
// que deriva el título del slug (ver prettify() en groups.js).
assert.match(cXml2, /Maratón larga: Longrun — episodio 30/);
console.log("visibilidad: despublicar corta la caché y el feed del suscrito; republicar lo restaura");

// signOut() debe limpiar TODAS las claves de cuenta. La lista vive en ACCOUNT_KEYS y este test la
// recorre entera, así que cualquier clave nueva que se añada ahí queda cubierta sin tocar el test
// (así se colaron sin limpiar group_subscriptions/subscribed_groups en su día: fuga entre cuentas).
const D = machine();
use(D);
for (const k of Object.keys(ACCOUNT_KEYS)) await set(k, ["CENTINELA"]);
await set("session", { access_token: "tok-x", user: { id: "x", email: "x@test.dev" } });
await signOut();
// Se lee el almacenamiento falso a pelo, no con store.get(): get() convierte un null guardado en
// el valor por defecto, y aquí queremos distinguir "limpiada a null" de "no escrita".
for (const [k, empty] of Object.entries(ACCOUNT_KEYS)) {
  const cell = await D.storage.local.get(k);
  assert.ok(k in cell, `signOut() no escribió "${k}"`);
  assert.deepEqual(cell[k], empty, `signOut() no limpió "${k}"`);
}
assert.equal((await D.storage.local.get("session")).session, null);
assert.ok(Object.keys(ACCOUNT_KEYS).length >= 9, "ACCOUNT_KEYS no debería adelgazar sin motivo");
console.log("signOut limpió las", Object.keys(ACCOUNT_KEYS).length, "claves de ACCOUNT_KEYS y la sesión");

console.log("TODO OK");
