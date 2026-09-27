// Ported from tests/test-sync-cron.mjs — prueba dos "máquinas" sincronizando por Supabase falso
// y el cron generando el RSS. Requiere src/test/mock_site.py (8001) y src/test/mock_supabase.py
// (8002) en marcha. Todas las aserciones del script original se conservan aquí, agrupadas por
// escenario en describe/it (ver src/test/sync.spec.js para la nota sobre por qué prácticamente
// todo el archivo original vive aquí y no allí: cada aserción de sync.js en el script original
// solo tiene sentido verificada por propagación entre dos o más máquinas).
import { describe, it, before } from "node:test";
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

let A, B, use;
let get, set;
let signUp, signIn, signOut, syncNow, saveAppProviders, searchPublicGroups, rateGroup, ACCOUNT_KEYS;
let add, mutate, live;
let addGroup, addStep, liveGroups;
let renameGroup, removeGroup;
let missingSteps, repairGroup, setPublic, subscribe, unsubscribe, liveSubscriptions, currentStep, markUpTo;
let providers;

let grupo;
let feedUrl;
let gLong, gOther;
let cFeedUrl;

const env = () => ({ ...process.env, SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: "service-key", SHOW_URL: "1" });
const run = () => execFileSync("node", ["cron/generate-feed.mjs"], { env: env() }).toString();
const count = s => (s.match(/<item>/g) || []).length;

// Da de alta a un usuario como admin usando la service key (bypassa RLS, igual que hace la
// persona real por SQL Editor con la cuenta de Postgres).
const seedAdmin = uid => fetch(`${SB}/rest/v1/admins?on_conflict=user_id`, {
  method: "POST",
  headers: { Authorization: "Bearer service-key", "Content-Type": "application/json" },
  body: JSON.stringify([{ user_id: uid }])
});

before(async () => {
  A = machine(); B = machine();
  use = m => { globalThis.chrome = m; };

  ({ get, set } = await import("../../app/store.js"));
  ({ signUp, signIn, signOut, syncNow, saveAppProviders, searchPublicGroups, rateGroup, ACCOUNT_KEYS } =
    await import("../../app/sync.js"));
  ({ add, mutate, live } = await import("../../app/list.js"));
  ({ addGroup, addStep, live: liveGroups, renameGroup, removeGroup, missingSteps, repairGroup, setPublic,
     subscribe, unsubscribe, liveSubscriptions, currentStep, markUpTo } = await import("../../app/groups.js"));
  providers = JSON.parse(fs.readFileSync(new URL("../mock-provider.json", import.meta.url), "utf8"));
});

describe("integración A/B: admin sube providers y una serie, crea un grupo", () => {
  it("A (admin): cuenta nueva, se marca admin, sube providers y una serie", async () => {
    use(A);
    await set("supabase", { url: SB, anonKey: "anon" });
    assert.equal((await signUp("dbranco@test.dev", "secreto123")).confirmed, true);
    await seedAdmin((await get("session")).user.id);
    await saveAppProviders(providers);
    await add({ provider: "mock", slug: "re-zero", title: "Re:Zero", link: "http://127.0.0.1:8001/blabla/re-zero", image: null });
    await syncNow();
  });

  it("A crea un grupo con un paso", async () => {
    grupo = await addGroup("Mi maratón");
    await addStep(grupo.id, { provider: "mock", slug: "re-zero", from: 1, to: 3 });
    await syncNow();
  });

  it("B: inicia sesión y debe recibir todo", async () => {
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
  });
});

describe("integración A/B: propagación de progreso, borrado/restauración y edición de grupo", () => {
  it("B marca visto hasta el ep 1 -> A lo recibe", async () => {
    use(B);
    await mutate("mock", "re-zero", it => { it.last = 1; });
    await syncNow();
    use(A); await syncNow();
    assert.equal(live(await get("watchlist", []))[0].last, 1);
  });

  it("A borra -> B lo ve borrado; A vuelve a añadir -> B lo recupera", async () => {
    use(A);
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
  });

  it("B renombra el grupo -> A lo recibe; luego A lo borra -> B lo ve borrado", async () => {
    use(B);
    await renameGroup(grupo.id, "Maratón definitivo");
    await syncNow();
    use(A); await syncNow();
    assert.equal((await get("groups", []))[0].name, "Maratón definitivo");
    await removeGroup(grupo.id);
    await syncNow();
    use(B); await syncNow();
    assert.equal(liveGroups(await get("groups", [])).length, 0);
  });
});

describe("integración: cron encuentra episodios y publica el feed", () => {
  it("cron: debe encontrar ep 2 y 3 (last=1), publicar el feed y no duplicar en la segunda pasada", async () => {
    const out = run();
    feedUrl = out.match(/Feed: (\S+)/)[1];
    let xml = await (await fetch(feedUrl)).text();
    assert.match(xml, /Re:Zero — episodio 2/);
    assert.match(xml, /Re:Zero — episodio 3/);
    assert.doesNotMatch(xml, /Re:Zero — episodio 1</);
    assert.equal(count(xml), 2);
    run();
    xml = await (await fetch(feedUrl)).text();
    assert.equal(count(xml), 2, "sin duplicados en la segunda pasada");
    assert.match(feedUrl, new RegExp(await get("feed_token")));
  });

  it("grupo: pide el episodio 20 de una serie larga que el chequeo normal (ventana de 5) no mira", async () => {
    // Se añade DESPUÉS del bloque anterior para no alterar su recuento (así el count==2 de arriba
    // sigue siendo válido: longrun todavía no existe en ese punto).
    use(A);
    await add({ provider: "mock", slug: "longrun", title: "Long Run", link: "x", image: null });
    gLong = await addGroup("Maratón larga");
    await addStep(gLong.id, { provider: "mock", slug: "longrun", from: 20, to: 20 });
    await syncNow();

    run();
    let xml = await (await fetch(feedUrl)).text();
    assert.match(xml, /Maratón larga: Long Run — episodio 20/);
    const countAfterGroup = count(xml);

    run();
    xml = await (await fetch(feedUrl)).text();
    assert.equal(count(xml), countAfterGroup, "sin duplicados en la segunda pasada del grupo");
  });
});

describe("integración C (no admin): providers compartidos en solo lectura", () => {
  let C;

  it("C: cuenta distinta, NO admin, recibe los providers en solo lectura y no puede escribir", async () => {
    C = machine();
    use(C);
    await set("supabase", { url: SB, anonKey: "anon" });
    assert.equal((await signUp("otra@test.dev", "secreto123")).confirmed, true);
    await syncNow();
    assert.equal((await get("providers", [])).length, 1);
    assert.equal(await get("is_admin", false), false);
    // OJO: este mensaje lo inventa src/test/mock_supabase.py, no es el que devuelve PostgREST real.
    // Esto prueba la lógica del mock (y que el cliente propaga el error), no el RLS de Postgres.
    await assert.rejects(() => saveAppProviders([{ id: "hack" }]), /solo admin/);
  });

  it("C también puede USAR los providers compartidos aunque no pueda escribirlos", async () => {
    // C añade una serie a su propia lista y comprueba que el cron (que ahora lee app_config una
    // sola vez, no por usuario) también le resuelve episodios nuevos a ella. C nunca escribió
    // providers en su user_settings, así que un cron que volviera a leerlos por usuario le daría
    // un feed vacío.
    use(C);
    await add({ provider: "mock", slug: "dandadan", title: "Dandadan", link: "http://127.0.0.1:8001/blabla/dandadan", image: null });
    await syncNow();
    run();
    cFeedUrl = `${SB}/storage/v1/object/public/feeds/${await get("feed_token")}.xml`;
    const cXml = await (await fetch(cFeedUrl)).text();
    assert.match(cXml, /Dandadan — episodio 1/);
    assert.equal(count(cXml), 3, "los 3 episodios del mock para la lista de C");
  });

  it("grupo público: A publica, C lo descubre en Explorar, se suscribe, progresa por su cuenta y lo valora", async () => {
    // A hace público uno de sus grupos; C lo encuentra en Explorar, se suscribe (se repara sola su
    // lista), marca progreso propio SIN tocar el de A, lo valora, y el cron le resuelve episodios
    // nuevos de ese grupo suscrito en SU PROPIO feed.
    use(A);
    await setPublic(gLong.id, true); // "Maratón larga" (longrun, del bloque anterior)
    // Segundo grupo público con un nombre claramente distinto: sin él, "buscar 'Maratón' devuelve 1"
    // no distinguía "el filtro ilike funciona" de "el mock lo ignora y devuelve el único público".
    // Su paso apunta a una serie que A no tiene en su lista, así que el cron lo salta (paso colgando).
    gOther = await addGroup("Saga Fate");
    await addStep(gOther.id, { provider: "mock", slug: "frieren", from: 1, to: 1 });
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

    await subscribe(found2[0], live(await get("watchlist", [])));
    assert.ok(live(await get("watchlist", [])).find(w => w.provider === "mock" && w.slug === "longrun"),
      "suscribirse repara sola la lista de C para el paso de 'longrun'");
    await syncNow();

    const cSub = (await get("subscribed_groups", [])).find(g => g.name === "Maratón larga");
    assert.ok(cSub, "C ve el grupo suscrito en su caché de solo lectura");
    const curC = currentStep(cSub, live(await get("watchlist", [])));
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
  });

  it("visibilidad: despublicar corta la caché y el feed del suscrito; republicar lo restaura", async () => {
    // Visibilidad: si A despublica el grupo, la suscripción de C sigue viva pero ni la caché de
    // solo lectura ni el cron vuelven a traer nada de él. El paso nuevo es el 30 de 'longrun',
    // fuera de la ventana MAX_AHEAD (C va por el 20), así que solo puede llegar al feed de C vía
    // el grupo suscrito — es lo que hace que estas dos aserciones distingan el filtro de un no-op.
    use(A);
    await setPublic(gLong.id, false);
    await addStep(gLong.id, { provider: "mock", slug: "longrun", from: 30, to: 30 });
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
  });
});

describe("integración: signOut limpia todas las claves de cuenta (ACCOUNT_KEYS)", () => {
  it("signOut() debe limpiar TODAS las claves de cuenta", async () => {
    // La lista vive en ACCOUNT_KEYS y este test la recorre entera, así que cualquier clave nueva
    // que se añada ahí queda cubierta sin tocar el test (así se colaron sin limpiar
    // group_subscriptions/subscribed_groups en su día: fuga entre cuentas).
    const D = machine();
    use(D);
    for (const k of Object.keys(ACCOUNT_KEYS)) await set(k, ["CENTINELA"]);
    await set("session", { access_token: "tok-x", user: { id: "x", email: "x@test.dev" } });
    await signOut();
    // Se lee el almacenamiento falso a pelo, no con store.get(): get() convierte un null guardado
    // en el valor por defecto, y aquí queremos distinguir "limpiada a null" de "no escrita".
    for (const [k, empty] of Object.entries(ACCOUNT_KEYS)) {
      const cell = await D.storage.local.get(k);
      assert.ok(k in cell, `signOut() no escribió "${k}"`);
      assert.deepEqual(cell[k], empty, `signOut() no limpió "${k}"`);
    }
    assert.equal((await D.storage.local.get("session")).session, null);
    assert.ok(Object.keys(ACCOUNT_KEYS).length >= 9, "ACCOUNT_KEYS no debería adelgazar sin motivo");
  });
});
