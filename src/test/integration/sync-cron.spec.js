// Ported from tests/test-sync-cron.mjs — prueba dos "máquinas" sincronizando por Supabase falso
// y el cron generando el RSS. Requiere src/test/mock_site.py (8001, ya no usado desde la
// migración a TMDB — engine/mock_site solo lo necesitan resolve.spec.js/engine.spec.js) y
// src/test/mock_supabase.py (8002) en marcha. Todas las aserciones del script original se
// conservan aquí, agrupadas por escenario en describe/it (ver src/test/sync.spec.js para la nota
// sobre por qué prácticamente todo el archivo original vive aquí y no allí: cada aserción de
// sync.js en el script original solo tiene sentido verificada por propagación entre dos o más
// máquinas).
//
// Identidad tmdb_id (Tasks 1-8): watchlist/steps ya no usan {provider, slug}; app_config sube
// players/tmdb_key en vez de providers. El cron (subproceso aparte via execFileSync, no comparte
// globalThis con este proceso) llama a la TMDB real para el calendario de episodios — se
// intercepta con src/test/tmdb_fetch_stub.mjs, cargado con `node --import` vía NODE_OPTIONS y
// alimentado con un JSON en disco (TMDB_SHIM_DATA), en vez de pegarle a la TMDB real o levantar
// un tercer servidor mock. El mismo módulo se usa también EN este proceso (installTmdbFetchStub
// directo) para las llamadas a tmdb.getShow que dispara repairGroup() al suscribirse a un grupo.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installTmdbFetchStub } from "../tmdb_fetch_stub.mjs";

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
let signUp, signIn, signOut, syncNow, saveAppPlayers, searchPublicGroups, rateGroup, ACCOUNT_KEYS;
let add, mutate, live;
let addGroup, addStep, liveGroups;
let renameGroup, removeGroup;
let missingSteps, repairGroup, setPublic, subscribe, unsubscribe, liveSubscriptions, currentStep, markUpTo;
let players;

let grupo;
let feedUrl;
let gLong, gOther;
let cFeedUrl;

// tmdb_id fijos para las series usadas en este archivo (no hay TMDB real: los datos que "TMDB"
// devuelve para ellos los sirve el stub de arriba, tanto en este proceso como en el del cron).
const RE_ZERO = 9001, LONGRUN = 9002, DANDADAN = 9003, FRIEREN = 9004;
const TMDB_KEY = "test-key";
// Los episodios usan la forma cruda de la API de TMDB (episode_number, no number): el stub
// simula la respuesta HTTP tal cual, y es tmdb.js#getSeasonEpisodes quien la traduce.
const SHOWS = {
  [RE_ZERO]: { name: "Re:Zero", poster_path: null,
    episodes: [1, 2, 3].map(n => ({ episode_number: n, name: `Ep ${n}`, air_date: `2020-01-0${n}` })) },
  // Rango contiguo 1..30: el cron (Task 9 fix) ya solo comprueba el episodio last+1, así que
  // necesita que ese número exista de verdad en el mock para cada `last` que usan los tests de
  // abajo — nada mira los pasos de grupo (ver más abajo, "visibilidad"), lo único que decide qué
  // aparece en el feed de cada usuario es su propio `last` en watchlist.
  [LONGRUN]: { name: "Long Run", poster_path: null,
    episodes: Array.from({ length: 30 }, (_, i) => i + 1)
      .map(n => ({ episode_number: n, name: `Ep ${n}`, air_date: "2020-01-01" })) },
  [DANDADAN]: { name: "Dandadan", poster_path: null,
    episodes: [1, 2, 3].map(n => ({ episode_number: n, name: `Ep ${n}`, air_date: `2020-01-0${n}` })) }
  // FRIEREN: nunca entra a la watchlist de nadie en este archivo (paso de grupo colgando, nadie
  // se suscribe a "Saga Fate"), así que no hace falta darle datos de TMDB.
};
const TMDB_SHIM_FILE = path.join(os.tmpdir(), `tmdb-shim-sync-cron-${process.pid}.json`);
fs.writeFileSync(TMDB_SHIM_FILE, JSON.stringify(SHOWS));
after(() => { fs.rmSync(TMDB_SHIM_FILE, { force: true }); }); // no dejar el JSON huérfano en el tmpdir

const env = () => ({
  ...process.env, SUPABASE_URL: SB, SUPABASE_SERVICE_KEY: "service-key", SHOW_URL: "1",
  TMDB_SHIM_DATA: TMDB_SHIM_FILE,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${new URL("../tmdb_fetch_stub.mjs", import.meta.url).href}`]
    .filter(Boolean).join(" ")
});
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
  ({ signUp, signIn, signOut, syncNow, saveAppPlayers, searchPublicGroups, rateGroup, ACCOUNT_KEYS } =
    await import("../../app/sync.js"));
  ({ add, mutate, live } = await import("../../app/list.js"));
  ({ addGroup, addStep, live: liveGroups, renameGroup, removeGroup, missingSteps, repairGroup, setPublic,
     subscribe, unsubscribe, liveSubscriptions, currentStep, markUpTo } = await import("../../app/groups.js"));

  // Cubre las llamadas a tmdb.getShow que este PROCESO hace (repairGroup vía subscribe()); el
  // subproceso del cron usa la misma pieza pero instalada aparte (ver NODE_OPTIONS en env()).
  installTmdbFetchStub(SHOWS);

  const providerRule = JSON.parse(fs.readFileSync(new URL("../mock-provider.json", import.meta.url), "utf8"))[0];
  players = { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } };
});

describe("integración A/B: admin sube providers y una serie, crea un grupo", () => {
  it("A (admin): cuenta nueva, se marca admin, sube providers y una serie", async () => {
    use(A);
    await set("supabase", { url: SB, anonKey: "anon" });
    assert.equal((await signUp("dbranco@test.dev", "secreto123")).confirmed, true);
    await seedAdmin((await get("session")).user.id);
    await saveAppPlayers(players, TMDB_KEY);
    await add({ tmdb_id: RE_ZERO, media_type: "tv", title: "Re:Zero", poster_path: null });
    await syncNow();
  });

  it("A crea un grupo con un paso", async () => {
    grupo = await addGroup("Mi maratón");
    await addStep(grupo.id, { tmdb_id: RE_ZERO, media_type: "tv", from: 1, to: 3 });
    await syncNow();
  });

  it("B: inicia sesión y debe recibir todo", async () => {
    use(B);
    await set("supabase", { url: SB, anonKey: "anon" });
    await signIn("dbranco@test.dev", "secreto123");
    await syncNow();
    assert.deepEqual(await get("players", {}), players);
    assert.equal(await get("tmdb_key", null), TMDB_KEY);
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
    await mutate(RE_ZERO, it => { it.last = 1; });
    await syncNow();
    use(A); await syncNow();
    assert.equal(live(await get("watchlist", []))[0].last, 1);
  });

  it("A borra -> B lo ve borrado; A vuelve a añadir -> B lo recupera", async () => {
    use(A);
    await mutate(RE_ZERO, it => { it.deleted = true; });
    await syncNow();
    use(B); await syncNow();
    assert.equal(live(await get("watchlist", [])).length, 0);
    use(A); await add({ tmdb_id: RE_ZERO, media_type: "tv", title: "Re:Zero", poster_path: null });
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
  it("cron: debe encontrar SOLO el próximo episodio (last=1 => ep 2), no adelantarse a ep 3, y no duplicar en la segunda pasada", async () => {
    // Task 9 fix (Finding 4): el cron ya no escanea el resto de la temporada, solo comprueba
    // last+1 — así una serie con varios episodios ya emitidos no dispara una ráfaga de avisos.
    const out = run();
    feedUrl = out.match(/Feed: (\S+)/)[1];
    let xml = await (await fetch(feedUrl)).text();
    assert.match(xml, /Re:Zero — episodio 2/);
    assert.doesNotMatch(xml, /Re:Zero — episodio 1</);
    assert.doesNotMatch(xml, /Re:Zero — episodio 3/, "el cron ya no mira más allá de last+1 en una sola pasada");
    assert.equal(count(xml), 1);
    run();
    xml = await (await fetch(feedUrl)).text();
    assert.equal(count(xml), 1, "sin duplicados en la segunda pasada");
    assert.match(feedUrl, new RegExp(await get("feed_token")));
  });

  it("serie de catálogo largo: solo se avisa del episodio siguiente a `last`, no de todos los ya emitidos", async () => {
    // Se añade DESPUÉS del bloque anterior para no alterar su recuento (así el count==1 de arriba
    // sigue siendo válido: longrun todavía no está en la watchlist de A en ese punto).
    // LONGRUN tiene 30 episodios ya emitidos en el mock; A la añade recién (last=0 por defecto,
    // SIN marcar nada como visto — un test posterior comprueba justo que A nunca tocó su `last`).
    // El cron (Task 9 fix, Finding 4) solo debe recoger el episodio 1 en esta pasada, no los 30 de
    // golpe — exactamente el escenario de "ráfaga de notificaciones" que describe ese finding.
    // El cron nunca consulta grupos (Task 8, commit 40820ae, quitó checkGroupEpisode() sin
    // sustituir su función de filtrado): el paso de grupo de abajo es solo para que los tests
    // posteriores (grupos públicos) tengan un paso "longrun" con el que trabajar.
    use(A);
    await add({ tmdb_id: LONGRUN, media_type: "tv", title: "Long Run", poster_path: null });
    gLong = await addGroup("Maratón larga");
    await addStep(gLong.id, { tmdb_id: LONGRUN, media_type: "tv", from: 20, to: 20 });
    await syncNow();

    run();
    let xml = await (await fetch(feedUrl)).text();
    assert.match(xml, /Long Run — episodio 1</);
    assert.doesNotMatch(xml, /Long Run — episodio 2/, "un solo episodio por pasada, no los 30 ya emitidos de golpe");
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
    assert.deepEqual(await get("players", {}), players);
    assert.equal(await get("is_admin", false), false);
    // OJO: este mensaje lo inventa src/test/mock_supabase.py, no es el que devuelve PostgREST real.
    // Esto prueba la lógica del mock (y que el cliente propaga el error), no el RLS de Postgres.
    await assert.rejects(() => saveAppPlayers({ hacked: true }, "hack-key"), /solo admin/);
  });

  it("C también puede USAR los providers compartidos aunque no pueda escribirlos", async () => {
    // C añade una serie a su propia lista y comprueba que el cron (que ahora lee app_config una
    // sola vez, no por usuario) también le resuelve episodios nuevos a ella. C nunca escribió
    // players en su user_settings, así que un cron que volviera a leerlos por usuario le daría
    // un feed vacío.
    use(C);
    await add({ tmdb_id: DANDADAN, media_type: "tv", title: "Dandadan", poster_path: null });
    await syncNow();
    run();
    cFeedUrl = `${SB}/storage/v1/object/public/feeds/${await get("feed_token")}.xml`;
    const cXml = await (await fetch(cFeedUrl)).text();
    assert.match(cXml, /Dandadan — episodio 1/);
    assert.equal(count(cXml), 1, "el cron (Task 9 fix) solo agrega el próximo episodio, no toda la temporada del mock");
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
    await addStep(gOther.id, { tmdb_id: FRIEREN, media_type: "tv", from: 1, to: 1 });
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
    assert.ok(live(await get("watchlist", [])).find(w => w.tmdb_id === LONGRUN),
      "suscribirse repara sola la lista de C para el paso de 'longrun'");
    await syncNow();

    const cSub = (await get("subscribed_groups", [])).find(g => g.name === "Maratón larga");
    assert.ok(cSub, "C ve el grupo suscrito en su caché de solo lectura");
    const curC = currentStep(cSub, live(await get("watchlist", [])));
    assert.equal(curC.next, 20); // mismo paso "longrun 20-20" que definió A
    await markUpTo(curC.step, 20);
    assert.equal(live(await get("watchlist", [])).find(w => w.tmdb_id === LONGRUN).last, 20,
      "el progreso de C en 'longrun' es suyo, independiente del de A");
    await syncNow();

    use(A);
    await syncNow();
    assert.equal(live(await get("watchlist", [])).find(w => w.tmdb_id === LONGRUN)?.last ?? 0, 0,
      "A nunca marcó 'longrun' como visto — el progreso propio de C en su suscripción no le pisa nada");

    use(C);
    await rateGroup(found2[0].user_id, found2[0].id, 5);
    const rated = await searchPublicGroups("Maratón");
    assert.equal(rated[0].rating_avg, 5);
    assert.equal(rated[0].rating_count, 1);
  });

  it("visibilidad: despublicar corta la caché de suscripciones; el feed de C sigue siendo suyo", async () => {
    // Visibilidad: si A despublica el grupo, la suscripción de C sigue viva pero la caché de solo
    // lectura (subscribed_groups) deja de traerlo — eso lo decide sync.js/RLS, nada que ver con el
    // cron. El cron en sí YA NO consulta grupos en absoluto (Task 8, commit 40820ae, quitó
    // checkGroupEpisode() sin sustituir su función de filtrado — Task 7, 8dd552e, solo había
    // quitado engine.episodes(); ver cron/generate-feed.mjs): ahora solo mira `last` por ítem de
    // watchlist, así que el próximo episodio de 'longrun' (last=20 para C, ver el bloque anterior)
    // sigue llegando al feed de C esté o no público el grupo que originó ese ítem — una vez que
    // repairGroup() deja un show en tu lista (por suscripción o a mano), el cron lo sigue igual,
    // con independencia de aquello. El paso de grupo `from:30,to:30` de abajo es deliberadamente
    // ignorado por el cron (no consulta grupos): sirve para demostrar justo eso.
    //
    // Nota histórica: antes del fix del Finding 4 (Task 9), el cron no tenía tope de episodios por
    // pasada, así que este mismo escenario también habría mostrado el episodio 30 en una sola
    // pasada (ráfaga). Con el tope de "solo el próximo episodio" ya en vigor, el feed de C avanza
    // de uno en uno (episodio 21, el siguiente a su `last`=20), no directo al 30.
    use(A);
    await setPublic(gLong.id, false);
    await addStep(gLong.id, { tmdb_id: LONGRUN, media_type: "tv", from: 30, to: 30 });
    await syncNow();

    use(C);
    await syncNow();
    assert.equal((await get("subscribed_groups", [])).length, 0, "un grupo despublicado sale de la caché");
    assert.equal(liveSubscriptions(await get("group_subscriptions", [])).length, 1,
      "la suscripción sigue viva: la UI pinta el hueco 'Grupo ya no disponible.' con su botón de baja");
    run();
    let cXml2 = await (await fetch(cFeedUrl)).text();
    assert.match(cXml2, /Long Run — episodio 21/,
      "el cron sigue viendo el ítem propio de C (repairGroup ya lo dejó en su watchlist normal) y solo avanza al siguiente episodio (last=20); no distingue por grupo");

    // A lo vuelve a publicar: subscribed_groups lo recupera (la caché sí depende del estado del
    // grupo); el feed de C, que nunca dejó de incluirlo, no cambia.
    use(A);
    await setPublic(gLong.id, true);
    await syncNow();
    use(C);
    await syncNow();
    assert.equal((await get("subscribed_groups", [])).length, 1, "al republicar, la caché lo recupera");
    run();
    cXml2 = await (await fetch(cFeedUrl)).text();
    assert.match(cXml2, /Long Run — episodio 21/);
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
