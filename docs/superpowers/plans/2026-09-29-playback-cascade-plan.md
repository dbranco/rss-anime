# Elección de idioma/pista/proveedor por ítem ("Plan B") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar de asumir siempre idioma global + pista `sub` + primer proveedor configurado al resolver "Ver aquí" — cada ítem puede elegir explícitamente idioma/pista/proveedor, con esa elección persistida y con caché de resolución por combinación (no solo por idioma).

**Architecture:** `resolve.js` deja de leer `lang_pref` + `players[lang].sub[0]` directamente; lee `item.player_pref` (nuevo campo opcional, con fallback a los valores de hoy si está ausente) y usa `"<lang>|<track>"` como clave de caché en vez de `"<lang>|sub"` fija. Un componente nuevo y compartido (`player-pref.js`, tres `<select>` encadenados) se monta en `list-item.js` (ítems sueltos) y `group-card.js` (ítem actual de un grupo), y persiste la elección vía `mutate()`.

**Tech Stack:** JS nativo (ES modules, sin build step), `node:test` + `jsdom` para tests.

**Spec:** `docs/superpowers/specs/2026-09-29-playback-cascade-design.md`

## Global Constraints

- Sin build step: JS nativo, imports relativos con extensión `.js`.
- Cero migración de datos: `item.player_pref` ausente debe comportarse exactamente igual que hoy (idioma global, pista `sub`, primer proveedor).
- `resolveAndPlay(item, episode, playerBox)` mantiene su firma exacta — no cambia ningún call site en `episode-panel.js`.
- Los selectores nunca listan una combinación (idioma, pista o proveedor) que no exista de verdad en `app_config.players`.
- Cada task termina con la suite completa en verde (`bash src/test/run.sh`) antes de commitear.
- Sigue el patrón ya establecido en el repo para UI async-en-contenedor-síncrono: la función de render devuelve un `<div>` vacío de inmediato y lo rellena tras el `await` (ver `eps` en `list-item.js`), en vez de volver la función async y romper la firma síncrona de sus llamadores.
- Después de cualquier `mutate()` que modifique el `item` recibido por parámetro, sincronizar la referencia con `Object.assign(item, updated)` antes de usarla — un `mutate()` sin este paso dejó un bug real esta sesión (ver commit `9a293da`, "Desmarcar" no refrescaba hasta hacer refresh).

---

## File Structure

- `src/app/ui/resolve.js` — modificado: `firstRule` se reemplaza por `chosenLang`/`chosenTrack`/`chosenRule`; `resolveSlug` recibe `track` y usa `"<lang>|<track>"` como clave de caché.
- `src/app/ui/player-pref.js` — nuevo: `renderPlayerPrefSelectors(item, onChange)`, los tres selectores encadenados compartidos.
- `src/app/ui/list-item.js` — modificado: monta `renderPlayerPrefSelectors` bajo el título de cada card.
- `src/app/ui/group-card.js` — modificado: monta `renderPlayerPrefSelectors` para `cur.item` bajo la línea "Paso X de Y...".
- `src/test/ui/resolve.spec.js` — modificado: casos nuevos para caché por `lang|track` y selección de proveedor vía `player_pref`.
- `src/test/ui/player-pref.spec.js` — nuevo: cobertura del componente compartido.

---

## Task 1: resolve.js — idioma/pista/proveedor desde item.player_pref

**Files:**
- Modify: `src/app/ui/resolve.js`
- Test: `src/test/ui/resolve.spec.js`

**Interfaces:**
- Consumes: `item.player_pref` (`{lang?, track?, providerId?}`, todos opcionales) — leído, nunca escrito por este task (lo escribe `player-pref.js` en el Task 2).
- Produces: `resolveAndPlay(item, episode, playerBox)` sin cambios de firma. Clave de caché en `item.players` pasa de `"<lang>|sub"` a `"<lang>|<track>"` — el Task 2 no depende de esto directamente (solo de que `item.player_pref` exista como campo), pero los tasks 3/4 sí dependen de que este task esté terminado antes de verificarse en vivo con "Ver aquí".

- [ ] **Step 1: Escribir los tests que fallan**

Añadir a `src/test/ui/resolve.spec.js`, después del test `"con slug ya cacheado en item.players → no vuelve a buscar (usa el slug directo)"` (justo antes del test de `embed_blocked` que ya existe al final del archivo):

```js
  it("item.player_pref.track='dub' usa la caché de dub, no la de sub", async () => {
    const { store, resolve } = await load();
    await store.set("players", {
      "es-ES": {
        sub: [{ id: providerRule.id, rule: providerRule }],
        dub: [{ id: "mock-dub", rule: { ...providerRule, id: "mock-dub" } }]
      }
    });
    // Título que el catálogo del mock no encontraría — si resolveSlug usara la clave "es-ES|sub"
    // (o buscara en vez de usar la caché), esto no terminaría en el player.
    const item = {
      tmdb_id: 7, title: "Título que no existe en el catálogo",
      player_pref: { track: "dub" },
      players: { "es-ES|dub": { providerId: "mock-dub", slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.ok(box.querySelector("select"), "usó el slug cacheado bajo la clave 'es-ES|dub'");
  });

  it("con varios proveedores para el mismo lang+track, usa el que indica item.player_pref.providerId", async () => {
    const { store, resolve } = await load();
    const otherRule = { ...providerRule, id: "mock-other" };
    await store.set("players", {
      "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }, { id: otherRule.id, rule: otherRule }], dub: [] }
    });
    // Cacheado bajo "mock-other": si chosenRule() devolviera el primer proveedor (providerRule,
    // id "mock") en vez de respetar player_pref.providerId, el chequeo de caché de resolveSlug
    // (cached.providerId === entry.id) fallaría y volvería a buscar — y sin resultados, no
    // llegaría a mostrar el player.
    const item = {
      tmdb_id: 8, title: "Título que no existe en el catálogo",
      player_pref: { providerId: "mock-other" },
      players: { "es-ES|sub": { providerId: "mock-other", slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.ok(box.querySelector("select"), "resolvió usando el proveedor cacheado (mock-other), no el primero");
  });

  it("player_pref.providerId apunta a un proveedor que ya no existe → cae al primero configurado", async () => {
    const { store, resolve } = await load();
    await store.set("players", { "es-ES": { sub: [{ id: providerRule.id, rule: providerRule }], dub: [] } });
    const item = {
      tmdb_id: 9, title: "Título que no existe en el catálogo",
      player_pref: { providerId: "no-existe-ya" },
      players: { "es-ES|sub": { providerId: providerRule.id, slug: "re-zero" } }
    };
    const box = dom.window.document.getElementById("playerBox");
    await resolve.resolveAndPlay(item, 1, box);
    assert.ok(box.querySelector("select"), "cayó al primer proveedor configurado y usó su slug cacheado");
  });
```

- [ ] **Step 2: Ejecutar la suite y verificar que los 3 tests nuevos fallan**

Run: `bash src/test/run.sh`
Expected: FAIL en los 3 tests nuevos (resolve.js todavía no lee `item.player_pref`; el primero falla porque busca con la clave `es-ES|sub` en vez de `es-ES|dub` — sin resultados en el mock, así que no aparece ningún `<select>`; el segundo y tercero porque `firstRule()` siempre devuelve `players[lang].sub[0]` sin mirar `providerId`, así que para el segundo test usa `providerRule` en vez de `otherRule` y el chequeo de caché falla).

- [ ] **Step 3: Reemplazar resolve.js**

Reemplazar el contenido completo de `src/app/ui/resolve.js`:

```js
// Resolución de reproducción: idioma/pista/proveedor elegidos por ítem (item.player_pref, ver
// player-pref.js), resueltos de forma perezosa y cacheados en item.players["<lang>|<track>"].
// Un ítem sin player_pref se comporta como antes: idioma global, pista "sub", primer proveedor
// configurado. Ver docs/superpowers/specs/2026-09-29-playback-cascade-design.md.
import * as engine from "../engine.js";
import * as tmdb from "../tmdb.js";
import { get } from "../store.js";
import { mutate } from "../list.js";
import { btn, explain } from "./dom.js";
import { ensurePermissions } from "./permissions.js";
import { renderPlayerPicker } from "./player.js";

const chosenTrack = item => item.player_pref?.track || "sub";
const chosenLang = async item => item.player_pref?.lang || await get("lang_pref", "es-ES");

async function chosenRule(item, lang, track) {
  const players = await get("players", {});
  const entries = players[lang]?.[track] || [];
  const id = item.player_pref?.providerId;
  return (id && entries.find(e => e.id === id)) || entries[0] || null;
}

// Tercer y último intento: el título "romaji"/"romanization" que TMDB recoge para el país de
// origen de la serie (ej. Japón para anime) — muchos sitios de streaming titulan sus posts así
// en vez de con el original en kanji o el traducido. Solo aplica a tv (origin_country no existe
// en movie). Devuelve null si no hay país de origen o no hay ningún título de ese tipo.
async function originRomajiTitle(item, lang) {
  try {
    const show = await tmdb.getShow(item.tmdb_id, item.media_type, lang);
    if (!show.origin_country) return null;
    const alts = await tmdb.getAlternativeTitles(item.tmdb_id, item.media_type);
    const forCountry = alts.filter(a => a.country === show.origin_country);
    const romaji = forCountry.find(a => /romaji|romanization/i.test(a.type));
    return (romaji || forCountry[0])?.title || null;
  } catch { return null; } // sin conexión/HTTP error: no bloquea el flujo, simplemente no hay 3er intento
}

// Busca el slug de `item.title` en el sitio de `entry.rule`, deja elegir el resultado correcto,
// y lo cachea en item.players["<lang>|<track>"]. Si ya había algo cacheado para esa combinación
// y ese proveedor, lo usa directo sin volver a buscar. Si el título traducido de TMDB no da
// resultados, reintenta con el original_title, y si eso tampoco encuentra nada, con el título
// romaji del país de origen (originRomajiTitle).
async function resolveSlug(item, lang, track, entry, box) {
  const cacheKey = `${lang}|${track}`;
  const cached = item.players?.[cacheKey];
  if (cached && cached.providerId === entry.id) return cached.slug;

  await ensurePermissions();
  box.textContent = "Buscando en " + entry.id + "…";
  let results;
  try { results = await engine.search(entry.rule, item.title); }
  catch (e) { box.textContent = "Error: " + explain(e); return null; }
  const tried = new Set([item.title]);
  if (!results.length && item.original_title && !tried.has(item.original_title)) {
    tried.add(item.original_title);
    box.textContent = "Sin resultados con \"" + item.title + "\", reintentando con \"" + item.original_title + "\"…";
    try { results = await engine.search(entry.rule, item.original_title); }
    catch (e) { box.textContent = "Error: " + explain(e); return null; }
  }
  if (!results.length) {
    const romaji = await originRomajiTitle(item, lang);
    if (romaji && !tried.has(romaji)) {
      box.textContent = "Sin resultados, reintentando con \"" + romaji + "\"…";
      try { results = await engine.search(entry.rule, romaji); }
      catch (e) { box.textContent = "Error: " + explain(e); return null; }
    }
  }
  if (!results.length) { box.textContent = "Sin resultados en " + entry.id; return null; }

  return new Promise(resolve => {
    box.replaceChildren(...results.map(r => btn(r.title, async () => {
      item.players = item.players || {};
      item.players[cacheKey] = { providerId: entry.id, slug: r.slug };
      await mutate(item.tmdb_id, x => { x.players = item.players; });
      resolve(r.slug);
    })));
  });
}

export async function resolveAndPlay(item, episode, playerBox) {
  const lang = await chosenLang(item);
  const track = chosenTrack(item);
  const entry = await chosenRule(item, lang, track);
  if (!entry) { playerBox.textContent = `No hay ningún sitio de reproducción configurado para "${lang}" (${track}).`; return; }

  const slug = await resolveSlug(item, lang, track, entry, playerBox);
  if (!slug) return;

  await ensurePermissions();
  playerBox.textContent = "Buscando servidores…";
  try {
    const players = await engine.episodePlayers(entry.rule, slug, episode);
    renderPlayerPicker(playerBox, players, { embedBlocked: !!entry.rule.episode?.embed_blocked });
  } catch (e) { playerBox.textContent = "Error: " + explain(e); }
}
```

- [ ] **Step 4: Ejecutar la suite completa y verificar que pasa**

Run: `bash src/test/run.sh`
Expected: PASS — los 3 tests nuevos y los 71 anteriores (74 en total).

- [ ] **Step 5: Commit**

```bash
git add src/app/ui/resolve.js src/test/ui/resolve.spec.js
git commit -m "feat: resolveAndPlay usa item.player_pref (idioma/pista/proveedor por ítem)"
```

---

## Task 2: player-pref.js — selectores compartidos idioma/pista/proveedor

**Files:**
- Create: `src/app/ui/player-pref.js`
- Test: `src/test/ui/player-pref.spec.js`

**Interfaces:**
- Consumes: `get("players", {})`, `get("lang_pref", "es-ES")` de `store.js`; `mutate(tmdbId, fn)` de `list.js`.
- Produces: `renderPlayerPrefSelectors(item, onChange)` — función SÍNCRONA que devuelve un `<div>` de inmediato (patrón async-en-contenedor-síncrono, ver Global Constraints) y lo rellena tras leer `players`/`lang_pref`. Los Tasks 3 y 4 importan y montan esto tal cual, sin adaptarlo.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/test/ui/player-pref.spec.js`:

```js
// Cobertura del componente compartido de player-pref.js (Task 2 del plan de
// docs/superpowers/specs/2026-09-29-playback-cascade-design.md): tres <select> encadenados
// (idioma → pista → proveedor) que listan solo combinaciones configuradas de verdad en
// app_config.players, y persisten la elección en item.player_pref vía mutate().
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, { timeout = 3000, step = 10 } = {}) => {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor: timeout");
    await sleep(step);
  }
};

describe("ui/player-pref: renderPlayerPrefSelectors", () => {
  let dom, n = 0;

  beforeEach(() => {
    dom = new JSDOM('<div id="box"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    const data = {};
    globalThis.chrome = { storage: { local: {
      get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
      set: async o => { Object.assign(data, structuredClone(o)); }
    } } };
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.document; });

  const load = async () => {
    n += 1;
    const store = await import(`../../app/store.js?playerpref${n}`);
    const list = await import(`../../app/list.js?playerpref${n}`);
    const pp = await import(`../../app/ui/player-pref.js?playerpref${n}`);
    return { store, list, pp };
  };

  it("sin ningún provider configurado → no renderiza nada", async () => {
    const { store, pp } = await load();
    await store.set("players", {});
    const item = { tmdb_id: 1, title: "Re:Zero" };
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await sleep(30);
    assert.equal(box.querySelectorAll("select").length, 0);
  });

  it("con una combinación configurada → 3 selects preseleccionados, sin player_pref previo", async () => {
    const { store, pp } = await load();
    await store.set("players", { "es-ES": { sub: [{ id: "animeav1", rule: { name: "AnimeAV1" } }], dub: [] } });
    await store.set("lang_pref", "es-ES");
    const item = { tmdb_id: 2, title: "Re:Zero" };
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await waitFor(() => box.querySelectorAll("select").length === 3);
    const [langSel, trackSel, providerSel] = box.querySelectorAll("select");
    assert.equal(langSel.value, "es-ES");
    assert.equal(trackSel.value, "sub");
    assert.equal(providerSel.value, "animeav1");
    assert.deepEqual([...trackSel.options].map(o => o.value), ["sub"], "dub no tiene providers, no debe listarse");
  });

  it("cambiar el idioma repuebla pista/proveedor y persiste en item.player_pref vía mutate", async () => {
    const { store, list, pp } = await load();
    await store.set("players", {
      "es-ES": { sub: [{ id: "animeav1", rule: { name: "AnimeAV1" } }], dub: [] },
      "pt-PT": {
        sub: [{ id: "meusanimes", rule: { name: "Meus Animes" } }],
        dub: [{ id: "meusanimes-dub", rule: { name: "Meus Animes Dub" } }]
      }
    });
    await store.set("lang_pref", "es-ES");
    const item = { tmdb_id: 3, title: "Re:Zero" };
    await list.add(item);
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await waitFor(() => box.querySelectorAll("select").length === 3);
    const [langSel, trackSel, providerSel] = box.querySelectorAll("select");

    langSel.value = "pt-PT";
    langSel.onchange();
    await waitFor(() => [...trackSel.options].length === 2);
    assert.deepEqual([...trackSel.options].map(o => o.value).sort(), ["dub", "sub"]);
    assert.equal(providerSel.value, "meusanimes", "pista se resetea a la primera disponible (sub) al cambiar de idioma");

    // persist() dentro de onchange no se puede await-ear desde aquí (el handler la dispara sin
    // devolverla) y waitFor() solo soporta predicados síncronos (ver su definición arriba) —
    // esperar con sleep en vez de forzar un waitFor con predicado async, que pasaría de largo.
    await sleep(50);
    const watchlist = await store.get("watchlist", []);
    const saved = watchlist.find(w => w.tmdb_id === 3);
    assert.deepEqual(saved.player_pref, { lang: "pt-PT", track: "sub", providerId: "meusanimes" });
    assert.deepEqual(item.player_pref, { lang: "pt-PT", track: "sub", providerId: "meusanimes" },
      "sincroniza la referencia item tras mutate (mismo patrón que episode-panel.js)");
  });

  it("con player_pref ya guardado, preselecciona ese proveedor entre varios configurados", async () => {
    const { store, pp } = await load();
    await store.set("players", {
      "es-ES": { sub: [{ id: "animeav1", rule: { name: "AnimeAV1" } }, { id: "otro", rule: { name: "Otro" } }], dub: [] }
    });
    const item = { tmdb_id: 4, title: "Re:Zero", player_pref: { lang: "es-ES", track: "sub", providerId: "otro" } };
    const box = pp.renderPlayerPrefSelectors(item, () => {});
    await waitFor(() => box.querySelectorAll("select").length === 3);
    const providerSel = box.querySelectorAll("select")[2];
    assert.equal(providerSel.value, "otro");
  });
});
```

- [ ] **Step 2: Ejecutar la suite y verificar que falla**

Run: `bash src/test/run.sh`
Expected: FAIL — `src/app/ui/player-pref.js` no existe todavía (error de import).

- [ ] **Step 3: Crear player-pref.js**

Crear `src/app/ui/player-pref.js`:

```js
import { get } from "../store.js";
import { mutate } from "../list.js";
import { el } from "./dom.js";

// Selectores encadenados idioma → pista → proveedor para elegir, por ítem, qué combinación de
// app_config.players usar en "Ver aquí" (ver resolve.js). Solo lista combinaciones que existen
// de verdad — nunca una opción sin proveedor detrás. La elección persiste en item.player_pref
// (ver docs/superpowers/specs/2026-09-29-playback-cascade-design.md); un ítem sin player_pref
// muestra los valores por defecto (lang_pref global, pista "sub", primer proveedor) sin escribir
// nada hasta que el usuario cambie algo.
//
// Devuelve el <div> contenedor de inmediato (síncrono) y lo rellena tras el await — mismo patrón
// que ya usa list-item.js para "Episodios" (evita que itemCard()/groupCard() tengan que volverse
// async, lo que rompería a sus propios llamadores).
export function renderPlayerPrefSelectors(item, onChange) {
  const box = el("div", { className: "row" });

  (async () => {
    const players = await get("players", {});
    const langs = Object.keys(players);
    if (!langs.length) return;

    const tracksFor = lang => ["sub", "dub"].filter(t => (players[lang]?.[t] || []).length);
    const entriesFor = (lang, track) => (track && players[lang]?.[track]) || [];

    const defaultLang = await get("lang_pref", "es-ES");
    const pref = item.player_pref || {};
    const initialLang = langs.includes(pref.lang) ? pref.lang : (langs.includes(defaultLang) ? defaultLang : langs[0]);
    const initialTracks = tracksFor(initialLang);
    if (!initialTracks.length) return;
    const initialTrack = initialTracks.includes(pref.track) ? pref.track : initialTracks[0];
    const initialEntries = entriesFor(initialLang, initialTrack);
    const initialProviderId = initialEntries.find(en => en.id === pref.providerId)?.id || initialEntries[0]?.id;
    if (!initialProviderId) return;

    const langSel = el("select", {});
    const trackSel = el("select", {});
    const providerSel = el("select", {});

    const persist = async () => {
      const next = { lang: langSel.value, track: trackSel.value, providerId: providerSel.value };
      const updated = await mutate(item.tmdb_id, x => { x.player_pref = next; });
      if (updated) Object.assign(item, updated);
      onChange();
    };

    const renderProviders = () => {
      const entries = entriesFor(langSel.value, trackSel.value);
      providerSel.replaceChildren(...entries.map(en =>
        el("option", { value: en.id, textContent: en.rule?.name || en.id })));
    };
    const renderTracks = () => {
      const tracks = tracksFor(langSel.value);
      trackSel.replaceChildren(...tracks.map(t => el("option", { value: t, textContent: t })));
      renderProviders();
    };

    langSel.replaceChildren(...langs.map(l => el("option", { value: l, textContent: l })));
    langSel.value = initialLang;
    renderTracks();
    trackSel.value = initialTrack;
    renderProviders();
    providerSel.value = initialProviderId;

    langSel.onchange = () => { renderTracks(); persist(); };
    trackSel.onchange = () => { renderProviders(); persist(); };
    providerSel.onchange = persist;

    box.replaceChildren(langSel, trackSel, providerSel);
  })();

  return box;
}
```

- [ ] **Step 4: Ejecutar la suite completa y verificar que pasa**

Run: `bash src/test/run.sh`
Expected: PASS — los 4 tests nuevos de `player-pref.spec.js` y todos los anteriores (78 en total).

- [ ] **Step 5: Commit**

```bash
git add src/app/ui/player-pref.js src/test/ui/player-pref.spec.js
git commit -m "feat: componente compartido de selección idioma/pista/proveedor por ítem"
```

---

## Task 3: Montar los selectores en list-item.js

**Files:**
- Modify: `src/app/ui/list-item.js`

**Interfaces:**
- Consumes: `renderPlayerPrefSelectors(item, onChange)` del Task 2 (sin adaptar).

- [ ] **Step 1: Importar y montar el componente**

En `src/app/ui/list-item.js`, añadir el import junto a los demás:

```js
import { renderPlayerPrefSelectors } from "./player-pref.js";
```

Y en `itemCard()`, insertar la línea nueva entre el título y "Visto hasta el episodio N":

```js
  return el("div", { className: "card" },
    item.poster_path ? el("img", { src: safe(tmdb.posterUrl(item.poster_path)) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      renderPlayerPrefSelectors(item, onChange),
      el("div", { className: "st", textContent: "Visto hasta el episodio " + (item.last || 0) }),
```

(El resto de `itemCard()` no cambia.)

- [ ] **Step 2: Verificar sintaxis y que la suite sigue en verde**

Run: `node --check src/app/ui/list-item.js && bash src/test/run.sh`
Expected: sin errores de sintaxis; 78/78 tests (list-item.js no tiene tests de renderizado propios — no se espera que el conteo cambie).

- [ ] **Step 3: Verificar en vivo en el navegador**

Con el servidor estático ya configurado en `.claude/launch.json` (`preview_start` con `name: "web-static"`), abrir `http://localhost:8090/src/web/index.html`, y en la consola del navegador sembrar un estado sintético (sin necesidad de login/Supabase, ya que `store.js` usa `localStorage` directo):

```js
const { set } = await import('/src/app/store.js');
await set('players', { 'es-ES': { sub: [{ id: 'test', rule: { name: 'Test Provider' } }], dub: [] } });
const { add } = await import('/src/app/list.js');
await add({ tmdb_id: 999, media_type: 'tv', title: 'Item de prueba', poster_path: null });
```

Recargar la página, entrar a "Mi lista" y confirmar visualmente que la card de "Item de prueba" muestra los 3 selectores bajo el título, antes de "Visto hasta el episodio 0". Confirmar que no hay errores en la consola (`read_console_messages` con `onlyErrors: true`).

- [ ] **Step 4: Commit**

```bash
git add src/app/ui/list-item.js
git commit -m "feat: mostrar selectores de idioma/pista/proveedor en cada card de Mi lista"
```

---

## Task 4: Montar los selectores en group-card.js

**Files:**
- Modify: `src/app/ui/group-card.js`

**Interfaces:**
- Consumes: `renderPlayerPrefSelectors(item, onChange)` del Task 2 (sin adaptar).

- [ ] **Step 1: Importar y montar el componente**

En `src/app/ui/group-card.js`, añadir el import junto a los demás:

```js
import { renderPlayerPrefSelectors } from "./player-pref.js";
```

Y en `groupCard()`, insertar la línea nueva en la construcción de `body`, entre la línea de "Paso X de Y..." y el bloque de acciones/aviso:

```js
  const body = !cur
    ? el("div", { textContent: "✓ Terminado" })
    : el("div", {},
        el("div", { textContent:
          `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
          `${cur.item ? cur.item.title : cur.step.tmdb_id} — episodio ${cur.next}` }),
        cur.item ? renderPlayerPrefSelectors(cur.item, onChange) : "",
        cur.item
          ? el("div", { className: "actions" },
              btn("Visto", () => onMark(cur.step, cur.next)))
          : el("div", { className: "st",
              textContent: `⚠ ${cur.step.title || cur.step.tmdb_id} ya no está en tu lista` }));
```

(El resto de `groupCard()` no cambia.)

- [ ] **Step 2: Verificar sintaxis y que la suite sigue en verde**

Run: `node --check src/app/ui/group-card.js && bash src/test/run.sh`
Expected: sin errores de sintaxis; 78/78 tests.

- [ ] **Step 3: Verificar en vivo en el navegador**

Sobre el mismo servidor estático del Task 3, sembrar además un grupo con un paso que apunte al ítem sintético ya creado:

```js
const { get, set } = await import('/src/app/store.js');
const groups = await get('groups', []);
groups.push({
  id: 'test-group', name: 'Grupo de prueba',
  steps: [{ tmdb_id: 999, media_type: 'tv', title: 'Item de prueba' }],
  deleted: false, updated_at: new Date().toISOString()
});
await set('groups', groups);
```

Recargar, confirmar que la card del grupo muestra la línea "Paso 1 de 1: Item de prueba — episodio 1" seguida de los 3 selectores, y que cambiar uno persiste (recargar de nuevo y comprobar que el valor elegido sigue ahí). Confirmar sin errores en consola.

- [ ] **Step 4: Commit**

```bash
git add src/app/ui/group-card.js
git commit -m "feat: mostrar selectores de idioma/pista/proveedor en el paso actual de un grupo"
```
