# TMDB como identidad + metadata (Plan A) — Plan de implementación

> **Para agentes:** REQUIRED SUB-SKILL: usa superpowers:subagent-driven-development
> (recomendado) o superpowers:executing-plans para implementar este plan
> tarea por tarea. Los pasos usan sintaxis de checkbox (`- [ ]`) para seguimiento.

**Goal:** Reemplazar `{provider, slug}` por `tmdb_id` como identidad de cada
ítem del watchlist/grupo, con TMDB como única fuente de búsqueda/metadata/
episodios, y una resolución básica (un sitio a la vez, sin cascada de
memoria todavía) para reproducir. Al terminar, la app funciona de punta a
punta sobre el nuevo modelo.

**Architecture:** `src/app/tmdb.js` (nuevo) es la única fuente de
metadata. `engine.js` no cambia de mecanismo — sigue resolviendo
`search`/`episodePlayers`/`checkEpisode` contra un `rule` (lo que hoy es
un "provider"), pero ese `rule` ahora solo sirve para encontrar el slug de
una serie en un sitio de reproducción, nunca para su título/imagen.
`list.js`/`groups.js` cambian su clave de identidad de `{provider, slug}`
a `tmdb_id`.

**Tech Stack:** Sin cambios — ES modules nativos, cero dependencias
nuevas (TMDB se consume con `fetch` plano).

**Spec:** `docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md`

## Global Constraints

- Cero build step, cero dependencias npm nuevas.
- `engine.js` no cambia su mecanismo de despacho (`embeds_regex`/
  `mirror_select`) — solo qué le pasan como `rule` y para qué se usa su
  `search`.
- Migración de Supabase: borrón y cuenta nueva (spec, sección
  "Migración") — no hay ninguna herramienta de re-emparejamiento de datos
  viejos, la migración vacía las tablas afectadas como parte de su propio
  cambio de esquema.
- Fuera de alcance de este plan (Plan B, spec + plan separados): la
  cascada de selección con memoria por idioma/pista (Plan A resuelve un
  solo sitio, el primero configurado, sin recordar preferencia entre
  sesiones más allá del propio `item.players` cache), y el chequeo
  híbrido por-rule (`check_interval_hours`) — Plan A solo implementa el
  chequeo por defecto vía TMDB.
- Trabajo directo en `master`, sin worktree.
- Cada tarea debe dejar `npm test` en verde.

---

### Task 1: Cliente TMDB

**Files:**
- Create: `src/app/tmdb.js`
- Test: `src/test/tmdb.spec.js`

**Interfaces:**
- Produces: `search(query, lang)`, `getShow(tmdbId, mediaType, lang)`,
  `getSeasonEpisodes(tmdbId, season, lang)`, `posterUrl(posterPath, size)`
  — usados por Task 3 (búsqueda), Task 6 (resolución) y Task 7 (episodios).
- Consumes: `get` de `./store.js` (lee `tmdb_key`, sembrado por Task 5).

- [ ] **Step 1: Escribir src/app/tmdb.js**

```js
// Cliente de la API pública de TMDB (v3): búsqueda, detalle de serie/película, episodios de
// temporada. Es la única fuente de metadata — engine.js sigue existiendo para resolver EN QUÉ
// SITIO de reproducción está cada serie (ver src/app/ui/resolve.js, Task 6), no para buscarla.
import { get } from "./store.js";

const BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";

// El cron (Node, sin chrome.storage ni localStorage) no puede pasar por store.js — fija
// globalThis.__tmdbApiKey directamente en vez de sembrar el storage del navegador. Mismo
// patrón que ya usa engine.js con globalThis.__seriesTrackerFetch para el proxy de la PWA.
async function apiKey() {
  const k = globalThis.__tmdbApiKey ?? await get("tmdb_key");
  if (!k) throw new Error("Falta configurar la API key de TMDB");
  return k;
}

async function call(path, params = {}) {
  const k = await apiKey();
  const qs = new URLSearchParams({ api_key: k, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`);
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
  return r.json();
}

export const posterUrl = (posterPath, size = "w342") =>
  posterPath ? `${IMG_BASE}/${size}${posterPath}` : null;

// Busca series y películas a la vez; TMDB también devuelve personas en /search/multi, se filtran.
export async function search(query, lang) {
  const j = await call("/search/multi", { query, language: lang, include_adult: "false" });
  return (j.results || [])
    .filter(r => r.media_type === "tv" || r.media_type === "movie")
    .map(r => ({
      tmdb_id: r.id,
      media_type: r.media_type,
      title: r.title || r.name,
      poster_path: r.poster_path || null,
      year: (r.release_date || r.first_air_date || "").slice(0, 4)
    }));
}

export async function getShow(tmdbId, mediaType, lang) {
  const j = await call(`/${mediaType}/${tmdbId}`, { language: lang });
  return {
    tmdb_id: tmdbId,
    media_type: mediaType,
    title: j.title || j.name,
    poster_path: j.poster_path || null,
    // Solo temporadas reales (la 0 de TMDB son especiales/OVAs, no cuentan para el flujo normal).
    seasons: mediaType === "tv" ? (j.seasons || []).map(s => s.season_number).filter(n => n > 0) : null
  };
}

// Episodios de una temporada, con fecha de emisión (para saber si "ya salió"). Solo aplica a
// media_type "tv" — una película no tiene temporadas/episodios.
export async function getSeasonEpisodes(tmdbId, season, lang) {
  const j = await call(`/tv/${tmdbId}/season/${season}`, { language: lang });
  return (j.episodes || []).map(e => ({
    number: e.episode_number,
    name: e.name,
    air_date: e.air_date || null
  }));
}
```

- [ ] **Step 2: Escribir src/test/tmdb.spec.js**

Sin dependencia de jsdom (TMDB es JSON puro, no HTML) — mockea `globalThis.fetch` directamente:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("tmdb", () => {
  const realFetch = globalThis.fetch;
  beforeEach(async () => {
    const { set } = await import("../app/store.js");
    await set("tmdb_key", "test-key");
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("search filtra personas y normaliza tv/movie", async () => {
    globalThis.fetch = async url => {
      assert.match(url, /\/search\/multi\?/);
      assert.match(url, /api_key=test-key/);
      return { ok: true, json: async () => ({ results: [
        { media_type: "tv", id: 1, name: "Re:Zero", poster_path: "/a.jpg", first_air_date: "2016-04-04" },
        { media_type: "person", id: 2, name: "Alguien" },
        { media_type: "movie", id: 3, title: "Una peli", poster_path: null, release_date: "2020-01-01" }
      ] }) };
    };
    const tmdb = await import("../app/tmdb.js?search1");
    const res = await tmdb.search("Re:Zero", "es-ES");
    assert.deepEqual(res, [
      { tmdb_id: 1, media_type: "tv", title: "Re:Zero", poster_path: "/a.jpg", year: "2016" },
      { tmdb_id: 3, media_type: "movie", title: "Una peli", poster_path: null, year: "2020" }
    ]);
  });

  it("getSeasonEpisodes devuelve número/nombre/fecha de emisión", async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ episodes: [
      { episode_number: 1, name: "Ep 1", air_date: "2016-04-04" },
      { episode_number: 2, name: "Ep 2", air_date: null }
    ] }) });
    const tmdb = await import("../app/tmdb.js?season1");
    assert.deepEqual(await tmdb.getSeasonEpisodes(1, 1, "es-ES"), [
      { number: 1, name: "Ep 1", air_date: "2016-04-04" },
      { number: 2, name: "Ep 2", air_date: null }
    ]);
  });

  it("posterUrl arma la URL, o null sin poster_path", async () => {
    const { posterUrl } = await import("../app/tmdb.js?posterurl");
    assert.equal(posterUrl("/abc.jpg", "w342"), "https://image.tmdb.org/t/p/w342/abc.jpg");
    assert.equal(posterUrl(null), null);
  });

  it("sin tmdb_key, cualquier llamada rechaza con mensaje claro", async () => {
    const { set } = await import("../app/store.js");
    await set("tmdb_key", null);
    globalThis.fetch = async () => { throw new Error("no debería llamarse"); };
    const tmdb = await import("../app/tmdb.js?nokey");
    await assert.rejects(() => tmdb.search("x", "es"), /Falta configurar la API key/);
  });
});
```

- [ ] **Step 3: Verificar**

```bash
node --check src/app/tmdb.js
node --test src/test/tmdb.spec.js
```

- [ ] **Step 4: Commit**

```bash
git add src/app/tmdb.js src/test/tmdb.spec.js
git commit -m "feat: cliente TMDB (búsqueda, detalle, episodios de temporada)"
```

---

### Task 2: Migración de Supabase — nuevo esquema de identidad

**Files:**
- Create: `supabase/migrations/20260927120000_tmdb_identity.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: `watchlist(user_id, tmdb_id, media_type, title, poster_path, last, players, visible, deleted, updated_at)`,
  `episodes_found(user_id, tmdb_id, episode, title, link, found_at)`,
  `app_config(id, players, tmdb_key, updated_at)` — consumidos por
  `sync.js` (Task 3/5) y `cron/generate-feed.mjs` (Task 8).

**Nota:** esto no se puede probar contra Postgres real desde este entorno
— no hay una instancia local. Revisa la sintaxis con cuidado; el usuario
aplica esto manualmente (SQL Editor de Supabase, o el workflow
`db-migrate.yml` si ya existe) antes de desplegar el código que la asume.
Es intencionalmente destructivo (trunca datos existentes) — así lo pidió
el usuario explícitamente en el diseño, no es un descuido.

- [ ] **Step 1: Escribir la migración**

```sql
-- Cambia la identidad de watchlist/pasos de grupo de {provider, slug} a tmdb_id. Ver
-- docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md. Intencionalmente
-- destructivo: no hay forma automática de mapear un slug scrapeado a un tmdb_id, así que
-- se vacía en vez de migrar (decisión explícita del diseño, no un descuido).

truncate table public.watchlist;
truncate table public.episodes_found;
truncate table public.groups cascade; -- cascada a group_subscriptions y group_ratings

alter table public.watchlist
  drop column if exists provider_id,
  drop column if exists slug,
  drop column if exists link,
  drop column if exists image,
  add column if not exists tmdb_id     int,
  add column if not exists media_type  text,
  add column if not exists poster_path text,
  add column if not exists players     jsonb not null default '{}'::jsonb;

alter table public.watchlist alter column tmdb_id    set not null;
alter table public.watchlist alter column media_type set not null;

alter table public.watchlist drop constraint if exists watchlist_pkey;
alter table public.watchlist add primary key (user_id, tmdb_id);

alter table public.episodes_found
  drop column if exists provider_id,
  drop column if exists slug,
  add column if not exists tmdb_id int;

alter table public.episodes_found alter column tmdb_id set not null;

alter table public.episodes_found drop constraint if exists episodes_found_pkey;
alter table public.episodes_found add primary key (user_id, tmdb_id, episode);

alter table public.app_config
  drop column if exists providers,
  add column if not exists players  jsonb not null default '{}'::jsonb,
  add column if not exists tmdb_key text;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Actualizar supabase/schema.sql**

El header del archivo dice explícitamente que hay que mantenerlo en sync
a mano con `migrations/`. Aplica los mismos cambios directamente sobre las
definiciones `create table` de `watchlist`, `episodes_found`, `app_config`
(columnas nuevas, primary key nueva) — no como un `alter` adicional al
final del archivo (ese patrón es para cuando `schema.sql` ya se aplicó
antes y no se puede reescribir su historia; para una tabla que se define
en este mismo archivo, se edita la definición `create table` directamente).

- [ ] **Step 3: Verificar**

No hay Postgres real disponible aquí. Verificación posible: lectura
cuidadosa de la sintaxis SQL (balanceo de paréntesis, comas, palabras
clave), y confirmar que `supabase/schema.sql` y la nueva migración
describen exactamente el mismo esquema final para las 3 tablas tocadas.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260927120000_tmdb_identity.sql supabase/schema.sql
git commit -m "feat(db): migrar watchlist/episodes_found/app_config a identidad tmdb_id"
```

---

### Task 3: Identidad tmdb_id en list.js + búsqueda/agregar vía TMDB

**Files:**
- Modify: `src/app/list.js`
- Modify: `src/app/ui/search.js`
- Modify: `src/app/ui/state.js`
- Modify: `src/app/ui/list-item.js` (llamadas a `mutate`)
- Modify: `src/app/sync.js` (`syncWatchlist`, `syncAppConfig`)
- Modify: `src/app/tmdb.js` — no, ya está hecho en Task 1, no tocar aquí.

**Interfaces:**
- Consumes: `tmdb.search`, `tmdb.posterUrl` (Task 1); `get`/`set` de `store.js`.
- Produces: `list.mutate(tmdbId, fn)` (firma nueva — antes `mutate(provider, slug, fn)`,
  rompe todo lo que la llamaba con la firma vieja: Task 4 actualiza los
  call sites de `groups.js`/`group-card.js`/`episode-panel.js`, este task
  cubre los de `list-item.js`).

- [ ] **Step 1: Reescribir src/app/list.js**

```js
// Operaciones sobre la lista local. Borrar = marcar deleted (para que la sync propague el borrado).
// Identidad: tmdb_id (ver docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md) —
// ya no {provider, slug}. `players` es el caché de "última combinación elegida" por idioma|pista,
// nunca una fijación (ver src/app/ui/resolve.js).
import { get, set } from "./store.js";

export const live = list => list.filter(x => !x.deleted);
const same = (x, tmdbId) => x.tmdb_id === tmdbId;

// visible=true (por defecto): aparece como tarjeta suelta en "Mi lista". visible=false: solo
// repairGroup, para no ensuciar la lista con algo que nadie pidió a propósito. Una vez visible,
// nunca se baja aquí (solo con "Ocultar", acción explícita).
// título/poster_path SIEMPRE se refrescan con lo que traiga `r` — da igual visible o no.
export async function add(r, { visible = true } = {}) {
  const l = await get("watchlist", []);
  const now = new Date().toISOString();
  const it = l.find(x => same(x, r.tmdb_id));
  if (it) {
    it.deleted = false;
    it.updated_at = now;
    it.title = r.title; it.media_type = r.media_type; it.poster_path = r.poster_path ?? it.poster_path;
    if (visible) it.visible = true;
  } else {
    l.push({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title,
             poster_path: r.poster_path ?? null, last: 0, players: {},
             visible, deleted: false, updated_at: now });
  }
  await set("watchlist", l);
}

export async function mutate(tmdbId, fn) {
  const l = await get("watchlist", []);
  const it = l.find(x => same(x, tmdbId));
  if (!it) return null;
  fn(it);
  it.updated_at = new Date().toISOString();
  await set("watchlist", l);
  return it;
}
```

- [ ] **Step 2: Reescribir src/app/ui/search.js**

Reemplaza la búsqueda multi-provider por búsqueda directa a TMDB, con el
idioma base del usuario (`lang_pref`, sembrado en Task 5 — mientras tanto
`get("lang_pref", "es-ES")` ya funciona con ese default):

```js
import * as tmdb from "../tmdb.js";
import { add } from "../list.js";
import { $, el, btn, safe, explain } from "./dom.js";
import { get } from "../store.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  $("#searchMsg").textContent = "";
  if (!q) { $("#searchMsg").textContent = "Escribe algo para buscar."; return; }
  $("#searchMsg").textContent = "Buscando…";
  const lang = await get("lang_pref", "es-ES");
  let results;
  try { results = await tmdb.search(q, lang); }
  catch (e) { $("#searchMsg").textContent = "Error: " + explain(e); return; }
  $("#searchMsg").textContent = results.length ? "" : "Sin resultados";
  $("#results").replaceChildren(...results.map(r => el("div", { className: "card" },
    r.poster_path ? el("img", { src: safe(tmdb.posterUrl(r.poster_path)) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: r.title + (r.year ? ` (${r.year})` : "") }),
      el("div", { className: "st", textContent: r.media_type === "movie" ? "Película" : "Serie" }),
      el("div", { className: "actions" },
        btn("＋ Guardar", async () => {
          await add(r);
          await renderMain();
          requestSync();
          $("#searchMsg").textContent = "Guardada";
        }))))));
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });
```

- [ ] **Step 3: Actualizar src/app/ui/state.js**

Añade la preferencia de idioma junto a lo que ya existe (no se toca
`providers`/`prov`/`selectedLangs` todavía — Task 5 los reemplaza por
completo cuando cambie el esquema de `app_config.players`; este paso solo
agrega el nuevo getter/setter sin quitar nada):

```js
export async function getLangPref() { return get("lang_pref", "es-ES"); }
export async function setLangPref(lang) { return set("lang_pref", lang); }
```

(Import `get, set` ya están en la parte superior del archivo — no
dupliques el import.)

- [ ] **Step 4: Actualizar llamadas a mutate en src/app/ui/list-item.js**

Cambia toda ocurrencia de `mutate(item.provider, item.slug, x => {...})`
a `mutate(item.tmdb_id, x => {...})` — son 4 call sites: "Siguiente"
(no, ese usa `engine.checkEpisode` directo, no `mutate` — no tocar),
"Visto +1", "Ocultar", "Quitar". También cambia `item.image` →
`tmdb.posterUrl(item.poster_path)` donde se construye el `<img>` de la
tarjeta, y el `key` de `epsSel` de `` `${item.provider}|${item.slug}` ``
a `` `${item.tmdb_id}` ``. La reescritura completa de "Episodios" (que
hoy llama `engine.episodes`) es Task 7, no toques esa parte aquí más allá
de actualizar la clave del Map.

- [ ] **Step 5: Actualizar src/app/sync.js**

`syncWatchlist`: cambia el mapeo remoto→local y el `key()`/payload de
`provider_id`/`slug`/`link`/`image` a `tmdb_id`/`media_type`/`poster_path`/`players`:

```js
async function syncWatchlist(uid) {
  const remote = (await rest(`watchlist?select=*&user_id=eq.${uid}`)).map(r => ({
    tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, poster_path: r.poster_path,
    last: r.last, players: r.players || {}, visible: r.visible !== false, deleted: r.deleted,
    updated_at: r.updated_at
  }));
  const local = await get("watchlist", []);
  const snapshot = JSON.stringify(local);
  const key = x => x.tmdb_id;
  const merged = new Map(remote.map(x => [key(x), x]));
  const toPush = [];
  for (const l of local) {
    if (!l.updated_at) l.updated_at = now();
    const r = merged.get(key(l));
    if (!r || ts(l.updated_at) > ts(r.updated_at)) { merged.set(key(l), l); toPush.push(l); }
  }
  if (toPush.length) {
    await rest("watchlist?on_conflict=user_id,tmdb_id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: toPush.map(x => ({
        user_id: uid, tmdb_id: x.tmdb_id, media_type: x.media_type, title: x.title,
        poster_path: x.poster_path || null, last: x.last || 0, players: x.players || {},
        visible: x.visible !== false, deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("watchlist", [])) === snapshot) await set("watchlist", [...merged.values()]);
}
```

`syncAppConfig`: se reescribe en Task 5 junto con el resto del esquema de
`players`/`tmdb_key` — no la toques en este task más allá de lo de arriba.

- [ ] **Step 6: Verificar**

```bash
node --check src/app/list.js src/app/ui/search.js src/app/ui/state.js src/app/ui/list-item.js src/app/sync.js
```
(`npm test` fallará todavía porque `groups.js` y sus consumidores —
Task 4 — siguen con la firma vieja de `mutate`; eso es esperado en este
punto, no es una regresión de este task. La suite completa vuelve a
verde recién al final de Task 4.)

- [ ] **Step 7: Commit**

```bash
git add src/app/list.js src/app/ui/search.js src/app/ui/state.js src/app/ui/list-item.js src/app/sync.js
git commit -m "feat: identidad tmdb_id en list.js, búsqueda vía TMDB"
```

---

### Task 4: Identidad tmdb_id en groups.js + simplificación de group-builder.js

**Files:**
- Modify: `src/app/groups.js`
- Modify: `src/app/ui/group-builder.js`
- Modify: `src/app/ui/group-card.js` (llamadas a `mutate`/`markUpTo`/`unmarkFrom`)
- Modify: `src/app/ui/episode-panel.js` (mismo)
- Modify: `src/app/sync.js` (`syncGroups` — la forma de `steps` cambia,
  pero la función en sí no necesita cambios: sigue subiendo/bajando
  `steps` como JSON opaco, es la UI la que cambia qué mete ahí dentro)

**Interfaces:**
- Consumes: `list.mutate` (Task 3, firma nueva), `tmdb.search`/`tmdb.getShow` (Task 1).
- Produces: `groups.currentStep`/`itinerary`/`missingSteps`/`repairGroup`/`markUpTo`/`unmarkFrom`
  operando sobre `step.tmdb_id` en vez de `step.provider`/`step.slug`.

**Simplificación clave:** un paso de grupo ya no referencia un
`provider`+`slug` de un sitio concreto — referencia un `tmdb_id`, igual
que cualquier ítem del watchlist. Eso significa que "buscar en un
provider concreto" para construir un paso, y "asignar un provider a cada
título" en el asistente de import JSON, dejan de tener sentido: ambos se
reemplazan por la MISMA búsqueda de TMDB que ya usa el buscador principal
(Task 3). `repairGroup` también se simplifica: ya no busca por texto en
ningún sitio de scraping para reconstruir un ítem que falta — pide el
detalle exacto a TMDB por `tmdb_id` (sin ambigüedad posible, a diferencia
de una búsqueda por texto).

- [ ] **Step 1: Reescribir src/app/groups.js**

```js
// Grupos de orden de visionado (playlists). El progreso no tiene contador propio: se
// deriva del `last` de cada ítem de watchlist, igual que ve el resto de la app.
// Identidad de paso: tmdb_id (ver docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md).
import { get, set } from "./store.js";
import { mutate, add } from "./list.js";
import * as tmdb from "./tmdb.js";

export const live = list => list.filter(g => !g.deleted);

export function nextNeeded(step, last) {
  const exclude = new Set(step.exclude || []);
  for (let n = Math.max(step.from, last + 1); n <= step.to; n++) {
    if (!exclude.has(n)) return n;
  }
  return null;
}

export function currentStep(group, watchlist) {
  for (const step of group.steps || []) {
    const item = watchlist.find(w => w.tmdb_id === step.tmdb_id);
    const last = item?.last || 0;
    const next = nextNeeded(step, last);
    if (next != null) return { step, item, next };
  }
  return null;
}

async function mutateGroup(id, fn) {
  const groups = await get("groups", []);
  const g = groups.find(x => x.id === id);
  if (!g) return null;
  fn(g);
  g.updated_at = new Date().toISOString();
  await set("groups", groups);
  return g;
}

export async function addGroup(name) {
  const groups = await get("groups", []);
  const g = { id: crypto.randomUUID(), name, steps: [], deleted: false, updated_at: new Date().toISOString() };
  groups.push(g);
  await set("groups", groups);
  return g;
}

export const renameGroup = (id, name) => mutateGroup(id, g => { g.name = name; });
export const removeGroup = id => mutateGroup(id, g => { g.deleted = true; });

export function addStep(id, step) {
  return mutateGroup(id, g => { g.steps.push({ from: 1, to: 1, exclude: [], ...step }); });
}
export function removeStep(id, index) {
  return mutateGroup(id, g => { g.steps.splice(index, 1); });
}
export function moveStep(id, index, dir) {
  return mutateGroup(id, g => {
    const j = index + dir;
    if (j < 0 || j >= g.steps.length) return;
    [g.steps[index], g.steps[j]] = [g.steps[j], g.steps[index]];
  });
}

export function markUpTo(step, episode) {
  return mutate(step.tmdb_id, x => { x.last = Math.max(x.last || 0, episode); });
}

export function unmarkFrom(step, episode) {
  return mutate(step.tmdb_id, x => { x.last = Math.min(x.last || 0, episode - 1); });
}

export async function markStepSeen(group, watchlist) {
  const cur = currentStep(group, watchlist);
  if (!cur) return null;
  return markUpTo(cur.step, cur.next);
}

export function itinerary(group, watchlist) {
  const out = [];
  for (const step of group.steps || []) {
    const item = watchlist.find(w => w.tmdb_id === step.tmdb_id);
    const last = item?.last || 0;
    const exclude = new Set(step.exclude || []);
    for (let n = step.from; n <= step.to; n++) {
      if (exclude.has(n)) continue;
      out.push({ step, item, episode: n, seen: n <= last });
    }
  }
  return out;
}

export const setPublic = (id, isPublic) => mutateGroup(id, g => { g.public = !!isPublic; });

export function missingSteps(g, watchlist) {
  const seen = new Set();
  return (g.steps || []).filter(s => {
    if (seen.has(s.tmdb_id)) return false;
    seen.add(s.tmdb_id);
    return !watchlist.find(w => w.tmdb_id === s.tmdb_id);
  });
}

// Reconstruye ítems que faltan pidiendo el detalle exacto a TMDB por tmdb_id — sin ambigüedad
// posible (a diferencia de una búsqueda por texto), así que no hace falta ningún fallback de
// "adivinar" ni elegir provider: siempre hay una única respuesta correcta o ninguna.
export async function repairGroup(g, watchlist) {
  const lang = await get("lang_pref", "es-ES");
  for (const s of missingSteps(g, watchlist)) {
    let title = null, poster_path = null, media_type = s.media_type || "tv";
    try {
      const info = await tmdb.getShow(s.tmdb_id, media_type, lang);
      title = info.title; poster_path = info.poster_path; media_type = info.media_type;
    } catch { /* sin conexión: se agrega con lo mínimo, se corrige solo en el próximo intento */ }
    await add({ tmdb_id: s.tmdb_id, media_type, title: title || `#${s.tmdb_id}`, poster_path },
              { visible: false });
  }
}

export const liveSubscriptions = list => list.filter(s => !s.deleted);

async function mutateSubscription(ownerId, groupId, fn) {
  const subs = await get("group_subscriptions", []);
  let s = subs.find(x => x.owner_id === ownerId && x.group_id === groupId);
  if (!s) { s = { owner_id: ownerId, group_id: groupId, deleted: false, updated_at: new Date().toISOString() }; subs.push(s); }
  fn(s);
  s.updated_at = new Date().toISOString();
  await set("group_subscriptions", subs);
  return s;
}

export async function subscribe(group, watchlist) {
  await mutateSubscription(group.user_id, group.id, s => { s.deleted = false; });
  await repairGroup(group, watchlist);
}

export const unsubscribe = (ownerId, groupId) => mutateSubscription(ownerId, groupId, s => { s.deleted = true; });
```

Nota: `step.media_type` no existía en el modelo viejo — Task 5's flujo de
"añadir paso" (abajo) debe guardarlo al crear el paso, para que
`repairGroup` sepa si pedir `/tv/{id}` o `/movie/{id}` a TMDB.

- [ ] **Step 2: Reescribir src/app/ui/group-builder.js**

Elimina por completo el flujo "buscar en un provider concreto"
(`$("#stepSearchProv")`, `$("#stepSearchBtn")`, `$("#stepSearchResults")`)
y la asignación de provider por título en el asistente de import
(`$("#importProviderPick")`, `$("#importApplyBtn")`) — ambos se
reemplazan por una única búsqueda de TMDB reutilizable:

```js
import * as tmdb from "../tmdb.js";
import { get } from "../store.js";
import { live, add } from "../list.js";
import * as groups from "../groups.js";
import { $, el, btn, explain } from "./dom.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

let draftSteps = [];
let importDraft = [];

function renderDraftSteps() {
  $("#groupSteps").replaceChildren(...draftSteps.map((s, i) => el("div", { className: "row" },
    el("span", { textContent:
      `${i + 1}. ${s.title} (${s.from}-${s.to}${s.exclude.length ? ", excl " + s.exclude.join(",") : ""})` }),
    btn("↑", () => { if (i > 0) { [draftSteps[i - 1], draftSteps[i]] = [draftSteps[i], draftSteps[i - 1]]; renderDraftSteps(); } }),
    btn("↓", () => { if (i < draftSteps.length - 1) { [draftSteps[i + 1], draftSteps[i]] = [draftSteps[i], draftSteps[i + 1]]; renderDraftSteps(); } }),
    btn("✕", () => { draftSteps.splice(i, 1); renderDraftSteps(); }))));
}

const readRange = () => ({
  from: +$("#stepFrom").value || 1,
  to: +$("#stepTo").value || 1,
  exclude: $("#stepExclude").value.split(",").map(s => +s.trim()).filter(Boolean)
});
const clearRange = () => { $("#stepFrom").value = "1"; $("#stepTo").value = "1"; $("#stepExclude").value = ""; };

$("#addStepBtn").onclick = () => {
  const tmdbId = +($("#stepItem").value || 0);
  if (!tmdbId) return;
  const item = watchlistCache.find(w => w.tmdb_id === tmdbId);
  draftSteps.push({ tmdb_id: tmdbId, media_type: item?.media_type || "tv", title: item?.title || `#${tmdbId}`, ...readRange() });
  clearRange();
  renderDraftSteps();
};

// Búsqueda de TMDB reutilizable tanto para "añadir un paso nuevo" como para el asistente de
// import — un paso siempre referencia un tmdb_id, nunca un sitio de reproducción concreto.
async function searchAndPick(query, onPick) {
  const lang = await get("lang_pref", "es-ES");
  const box = el("div", { textContent: "Buscando…" });
  try {
    const res = await tmdb.search(query, lang);
    box.replaceChildren(...(res.length
      ? res.map(r => btn(`${r.title}${r.year ? " (" + r.year + ")" : ""}`, () => onPick(r)))
      : ["Sin resultados"]));
  } catch (e) { box.textContent = "Error: " + explain(e); }
  return box;
}

$("#stepSearchBtn").onclick = async () => {
  const q = $("#stepSearchQ").value.trim();
  if (!q) return;
  $("#stepSearchResults").replaceChildren(await searchAndPick(q, async r => {
    await add(r, { visible: false }); // solo para el paso, no es media añadida a propósito
    draftSteps.push({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, ...readRange() });
    clearRange();
    renderDraftSteps();
    $("#stepSearchResults").replaceChildren();
    $("#stepSearchQ").value = "";
  }));
};

$("#importParseBtn").onclick = () => {
  let data;
  try { data = JSON.parse($("#importJson").value); }
  catch (e) { $("#groupMsg").textContent = "JSON inválido: " + e.message; return; }
  if (data.name) $("#groupName").value = data.name;
  importDraft = (data.steps || []).map(s => ({
    title: s.title || "", from: s.from ?? 1, to: s.to ?? 1, exclude: s.exclude || []
  }));
  renderImportRows();
  $("#importAssign").hidden = false;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
};

function renderImportRows() {
  $("#importRows").replaceChildren(...importDraft.map(row => el("div", { className: "row" },
    el("span", { textContent: row.title }))));
}

// Busca cada título del import en TMDB directamente (ya no hace falta asignar provider por
// título primero — un paso es solo un tmdb_id).
$("#importSearchBtn").onclick = async () => {
  if (!importDraft.length) return;
  $("#importResults").hidden = false;
  $("#importResults").replaceChildren();
  for (const row of importDraft) {
    const box = el("div", { className: "card" }, el("div", { className: "body" }, el("b", { textContent: row.title })));
    $("#importResults").append(box);
    const results = await searchAndPick(row.title, async r => {
      await add(r, { visible: false });
      draftSteps.push({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, from: row.from, to: row.to, exclude: row.exclude });
      renderDraftSteps();
      box.remove();
    });
    box.append(results);
  }
};

let watchlistCache = [];

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
  $("#groupMsg").textContent = "";
  renderDraftSteps();
  watchlistCache = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...watchlistCache.map(it =>
    el("option", { value: it.tmdb_id, textContent: it.title })));
  $("#stepSearchQ").value = "";
  $("#stepSearchResults").replaceChildren();
  importDraft = [];
  $("#importJson").value = "";
  $("#importAssign").hidden = true;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
  $("#groupForm").hidden = false;
};

$("#cancelGroupBtn").onclick = () => { $("#groupForm").hidden = true; };

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { $("#groupMsg").textContent = "Ponle un nombre al grupo"; return; }
  if (!draftSteps.length) { $("#groupMsg").textContent = "Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"; return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  if ($("#groupPublic").checked) await groups.setPublic(g.id, true);
  $("#groupForm").hidden = true;
  renderMain();
  requestSync();
};
```

Actualiza `src/web/index.html` y `src/extension/popup.html`: el
`<select id="stepSearchProv">` y el bloque de asignación de provider por
título (`#importProviderPick`, `#importApplyBtn` y su fila) ya no se
usan — elimínalos del HTML de ambas apps (deja `#stepSearchQ`/
`#stepSearchBtn`/`#stepSearchResults` intactos, siguen usándose).

- [ ] **Step 3: Actualizar src/app/ui/group-card.js y src/app/ui/episode-panel.js**

Todo `step.provider`/`step.slug` pasa a `step.tmdb_id`; toda llamada a
`groups.markUpTo(step, episode)`/`unmarkFrom` no cambia de firma (siguen
recibiendo el `step` completo) pero ahora ese `step` trae `tmdb_id` en vez
de `provider`/`slug` — sin más cambios en estos dos archivos más allá de
donde construyen texto a partir de esos campos (ej. el mensaje de
`⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` pasa a
`⚠ ${cur.step.title || cur.step.tmdb_id} ya no está en tu lista`).

- [ ] **Step 4: Verificar**

```bash
node --check src/app/groups.js src/app/ui/group-builder.js src/app/ui/group-card.js src/app/ui/episode-panel.js
npm test
```
`npm test` debe volver a verde aquí (los tests fallarán hasta que se
actualicen — eso es Task 9; si prefieres, corre esta verificación después
de Task 9 y trátala como no bloqueante en este punto, dejándolo anotado
en el commit).

- [ ] **Step 5: Commit**

```bash
git add src/app/groups.js src/app/ui/group-builder.js src/app/ui/group-card.js src/app/ui/episode-panel.js src/web/index.html src/extension/popup.html
git commit -m "feat: identidad tmdb_id en groups.js, simplifica group-builder.js (TMDB reemplaza búsqueda por provider)"
```

---

### Task 5: app_config.players + editor admin + TMDB key

**Files:**
- Modify: `src/app/sync.js` (`syncAppConfig`, `saveAppProviders` → renombrar a `saveAppPlayers`)
- Modify: `src/web/ui/config.js`
- Modify: `src/extension/options.js`
- Modify: `src/app/ui/state.js` (quitar `providers`/`prov`/`fillProviders`/`selectedLangs`, ya no aplican)
- Modify: `src/app/ui/permissions.js` (`ensurePermissions` ya no itera `providers` — ver abajo)

**Interfaces:**
- Produces: `app_config.players` (esquema anidado idioma→pista→[{id, rule}]),
  `app_config.tmdb_key`. Consumidos por Task 6 (resolución) y Task 8 (cron/background).

- [ ] **Step 1: Reescribir syncAppConfig y saveAppProviders→saveAppPlayers en src/app/sync.js**

```js
async function syncAppConfig(uid) {
  const [row] = await rest("app_config?select=players,tmdb_key,updated_at&id=eq.1");
  if (row) {
    await set("players", row.players || {});
    await set("tmdb_key", row.tmdb_key || null);
    await set("players_updated_at", row.updated_at || null);
  }
  const adminRows = await rest(`admins?select=user_id&user_id=eq.${uid}`);
  await set("is_admin", adminRows.length > 0);
}

export async function saveAppPlayers(players, tmdbKey) {
  await session();
  const t = now();
  await rest("app_config?on_conflict=id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ id: 1, players, tmdb_key: tmdbKey, updated_at: t }]
  });
  await set("players", players);
  await set("tmdb_key", tmdbKey);
  await set("players_updated_at", t);
}
```

- [ ] **Step 2: Reescribir src/web/ui/config.js**

```js
import { get } from "../../app/store.js";
import { saveAppPlayers } from "../../app/sync.js";
import { $, explain } from "../../app/ui/dom.js";

export async function renderConfig() {
  $("#playersJson").value = JSON.stringify(await get("players", {}), null, 2);
  $("#tmdbKey").value = (await get("tmdb_key")) || "";
  $("#configMsg").textContent = "";
}

function validatePlayers(obj) {
  if (typeof obj !== "object" || Array.isArray(obj)) throw new Error("Debe ser un objeto { idioma: { sub: [...], dub: [...] } }");
  for (const [lang, tracks] of Object.entries(obj)) {
    for (const track of ["sub", "dub"]) {
      for (const entry of (tracks[track] || [])) {
        if (!entry.id || !entry.rule) throw new Error(`Falta id/rule en ${lang}.${track}`);
        for (const k of ["base_url", "search", "episode"]) if (!entry.rule[k]) throw new Error(`Falta rule.${k} en ${lang}.${track}.${entry.id}`);
        if (!entry.rule.search.slug_regex) throw new Error(`Falta rule.search.slug_regex en ${lang}.${track}.${entry.id}`);
        new URL(entry.rule.base_url);
      }
    }
  }
}

$("#saveConfigBtn").onclick = async () => {
  let players;
  try {
    players = JSON.parse($("#playersJson").value);
    validatePlayers(players);
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  try { await saveAppPlayers(players, $("#tmdbKey").value.trim() || null); }
  catch (e) { $("#configMsg").textContent = "Error al guardar: " + explain(e); return; }
  $("#configMsg").textContent = "Guardado.";
};
```

En `src/web/index.html`: renombra `#providersJson`→`#playersJson`,
`#saveProvidersBtn`→`#saveConfigBtn`, agrega un `<input id="tmdbKey">`
junto al textarea, actualiza el texto de ayuda (plantillas
`{base_url} {query} {slug} {episode}` siguen aplicando igual dentro de
cada `rule`, ya no a nivel de provider suelto).

- [ ] **Step 3: Reescribir src/extension/options.js**

Mismo cambio de fondo que `config.js`, manteniendo el flujo de permisos
de Chrome (debe seguir pidiéndose en el mismo gesto de clic, antes de
guardar) — los orígenes a pedir ahora se recorren dentro de
`players[lang][track][].rule.base_url` en vez de un array plano de
providers:

```js
$("#save").onclick = () => {
  let players;
  try {
    players = JSON.parse($("#json").value);
    validatePlayers(players); // misma función que config.js — puedes duplicarla aquí, este archivo no comparte módulo con la PWA
  } catch (e) { return status("JSON no válido: " + e.message, true); }

  const origins = [...new Set(
    Object.values(players).flatMap(tracks =>
      ["sub", "dub"].flatMap(t => (tracks[t] || []).map(entry => {
        const u = new URL(entry.rule.base_url);
        return `${u.protocol}//${u.hostname}/*`;
      }))
    )
  )];
  chrome.permissions.request({ origins }).then(async granted => {
    try { await saveAppPlayers(players, $("#tmdbKey").value.trim() || null); }
    catch (e) { return status("Error al guardar: " + e.message, true); }
    status(granted ? "Guardado y permisos concedidos." : "Guardado, pero SIN permiso a los dominios: las búsquedas fallarán.", !granted);
    await loadProviders();
  });
};
```

Actualiza `loadProviders()` (renómbralo `loadConfig()` si quieres, o
déjalo — es una función privada) para leer `players`/`tmdb_key` en vez de
`providers`, y `src/extension/options.html` con los mismos cambios de IDs
que `src/web/index.html`. Importa `saveAppPlayers` en vez de
`saveAppProviders` en la línea 2 del archivo.

- [ ] **Step 4: Limpiar src/app/ui/state.js**

Elimina `providers`, `prov`, `fillProviders`, `renderLangFilter`,
`selectedLangs` — ya no hay un array plano de providers que filtrar por
idioma en la UI de búsqueda (Task 3 ya no los usa, y ningún archivo de
`src/app/ui/` que sobreviva a Task 6 los necesita). Deja el archivo con
solo `getLangPref`/`setLangPref` (agregados en Task 3).

Busca todo import de `{ providers, prov, fillProviders, selectedLangs }`
que quede colgando en otros archivos ya tocados (`search.js`,
`group-builder.js` ya no los importan tras Tasks 3-4; revisa
`main-list.js`, `explore.js` por si acaso — no deberían tener ninguno).

- [ ] **Step 5: Actualizar src/app/ui/permissions.js**

`watchlistOrigins`/`ensurePermissions` ya no reciben `extraIds` que se
resuelven contra un array `providers` — ahora reciben directamente una
lista de `base_url` (o ningún argumento, para "todo lo que ya está en el
watchlist resuelto" — pero como Task 6 introduce recién la resolución por
sitio, de momento simplifica a que `ensurePermissions` siempre pida
permiso para TODOS los `base_url` presentes en `players` completo, sin
intentar acotar por lo que ya está en uso):

```js
import { $ } from "./dom.js";
import { get } from "../store.js";

function allOrigins(players) {
  const set = new Set();
  for (const tracks of Object.values(players || {})) {
    for (const t of ["sub", "dub"]) {
      for (const entry of (tracks[t] || [])) {
        try { const u = new URL(entry.rule.base_url); set.add(`${u.protocol}//${u.hostname}/*`); }
        catch { /* rule mal formada: se ignora aquí, config.js ya valida al guardar */ }
      }
    }
  }
  return [...set];
}

export function ensurePermissions() {
  if (typeof chrome === "undefined" || !chrome.permissions) return Promise.resolve();
  return get("players", {}).then(players => {
    const origins = allOrigins(players);
    if (!origins.length) return Promise.resolve();
    return chrome.permissions.request({ origins }).catch(e => {
      $("#msg").textContent = "No se pudo pedir el permiso: " + e.message;
    });
  });
}

export async function updatePermBanner() {
  const banner = $("#permBanner");
  if (!banner || typeof chrome === "undefined" || !chrome.permissions) return;
  const origins = allOrigins(await get("players", {}));
  const ok = !origins.length || await chrome.permissions.contains({ origins });
  banner.hidden = ok;
}

const grantBtn = $("#grantPerms");
if (grantBtn) grantBtn.onclick = async () => { await ensurePermissions(); updatePermBanner(); };
```

`watchlistCache`/`setWatchlistCache` ya no se usan (nada llama
`ensurePermissions(extraIds)` con IDs concretos ahora) — elimínalos.
Revisa `main-list.js` (llama `setWatchlistCache` hoy) y quita esa
llamada.

- [ ] **Step 6: Verificar**

```bash
node --check src/app/sync.js src/web/ui/config.js src/extension/options.js src/app/ui/state.js src/app/ui/permissions.js src/app/ui/main-list.js
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: app_config.players + editor admin + TMDB key, simplifica ensurePermissions"
```

---

### Task 6: Resolución básica de reproducción (un sitio, sin cascada de memoria)

**Files:**
- Create: `src/app/ui/resolve.js`
- Modify: `src/app/ui/episode-panel.js` (botón "▶ Ver aquí")

**Interfaces:**
- Consumes: `get`/`set` de `store.js`, `engine.search`/`episodePlayers`,
  `players` de `app_config` (Task 5).
- Produces: `resolveAndPlay(item, lang, track, playerBox, episode)` —
  única función que Task 6 conecta a los botones "▶ Ver aquí" existentes.

**Alcance de Plan A (recordatorio):** un solo idioma (el del usuario,
`lang_pref`), pista SUB fija (sin selector dub todavía — Plan B agrega
la cascada completa con memoria), y el PRIMER sitio configurado para esa
combinación (`players[lang].sub[0]`) — sin selector de sitio tampoco. Si
no hay ningún sitio configurado para ese idioma, se informa el error en
vez de intentar nada más.

- [ ] **Step 1: Escribir src/app/ui/resolve.js**

```js
// Resolución básica de reproducción: un solo sitio (el primero configurado para el idioma del
// usuario en pista SUB), resuelto de forma perezosa y cacheado en item.players. Plan A no
// implementa la cascada completa de idioma/pista/sitio con memoria — eso es Plan B.
import * as engine from "../engine.js";
import { get } from "../store.js";
import { mutate } from "../list.js";
import { btn, explain } from "./dom.js";
import { ensurePermissions } from "./permissions.js";
import { renderPlayerPicker } from "./player.js";

async function firstRule(lang) {
  const players = await get("players", {});
  const entry = players[lang]?.sub?.[0];
  return entry || null;
}

// Busca el slug de `item.title` en el sitio de `entry.rule`, deja elegir el resultado correcto,
// y lo cachea en item.players["lang|sub"]. Si ya había algo cacheado para ese sitio, lo usa
// directo sin volver a buscar.
async function resolveSlug(item, lang, entry, box) {
  const cacheKey = `${lang}|sub`;
  const cached = item.players?.[cacheKey];
  if (cached && cached.providerId === entry.id) return cached.slug;

  await ensurePermissions();
  box.textContent = "Buscando en " + entry.id + "…";
  let results;
  try { results = await engine.search(entry.rule, item.title); }
  catch (e) { box.textContent = "Error: " + explain(e); return null; }
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
  const lang = await get("lang_pref", "es-ES");
  const entry = await firstRule(lang);
  if (!entry) { playerBox.textContent = `No hay ningún sitio de reproducción configurado para "${lang}".`; return; }

  const slug = await resolveSlug(item, lang, entry, playerBox);
  if (!slug) return;

  await ensurePermissions();
  playerBox.textContent = "Buscando servidores…";
  try { renderPlayerPicker(playerBox, await engine.episodePlayers(entry.rule, slug, episode)); }
  catch (e) { playerBox.textContent = "Error: " + explain(e); }
}
```

- [ ] **Step 2: Conectar en src/app/ui/episode-panel.js**

Reemplaza el cuerpo del botón "▶ Ver aquí" en `renderItemEpisodePanel` y
`renderEpisodePanel` (los dos tienen el mismo patrón hoy, llamando
`engine.episodePlayers(p, slug, episode)` contra un `p`/slug fijos de
`item.provider`/`item.slug` que ya no existen):

```js
        p ? btn("▶ Ver aquí", () => resolveAndPlay(item, episode, playerBox)) : "",
```

Como `resolveAndPlay` ya no depende de `prov(item.provider)` para decidir
si mostrar el botón (siempre se muestra — la propia función informa si no
hay nada configurado), quita la variable `p`/`prov(...)` de ambas
funciones y el `p ?` condicional: el botón siempre está. Importa
`resolveAndPlay` desde `./resolve.js` en vez de `renderPlayerPicker`
directo (ese import se mueve dentro de `resolve.js`).

- [ ] **Step 3: Verificar**

```bash
node --check src/app/ui/resolve.js src/app/ui/episode-panel.js
```

- [ ] **Step 4: Commit**

```bash
git add src/app/ui/resolve.js src/app/ui/episode-panel.js
git commit -m "feat: resolución básica de reproducción (un sitio, resuelto perezoso y cacheado)"
```

---

### Task 7: Lista de episodios vía TMDB

**Files:**
- Modify: `src/app/ui/list-item.js` (botón "Episodios")
- Modify: `src/app/engine.js` (elimina `episodes()`, ya no se usa)

**Interfaces:**
- Consumes: `tmdb.getSeasonEpisodes` (Task 1).

- [ ] **Step 1: Reescribir el botón "Episodios" en src/app/ui/list-item.js**

Reemplaza la llamada a `engine.episodes(prov(item.provider), item.slug)`
por `tmdb.getSeasonEpisodes(item.tmdb_id, 1, lang)` (temporada 1 fija —
soporte multi-temporada queda fuera de alcance de Plan A, anótalo como
comentario). Para `media_type === "movie"` no hay episodios: muestra un
único toggle "Vista"/"No vista" en vez del grid, usando el mismo
`mutate`/`last` (0 o 1) que ya existe.

```js
        btn("Episodios", async () => {
          if (item.media_type === "movie") {
            eps.replaceChildren(item.last
              ? btn("✓ Vista (marcar no vista)", async () => { await mutate(item.tmdb_id, x => { x.last = 0; }); eps.textContent = ""; onChange(); requestSync(); })
              : btn("Marcar vista", async () => { await mutate(item.tmdb_id, x => { x.last = 1; }); eps.textContent = ""; onChange(); requestSync(); }));
            return;
          }
          eps.textContent = "Cargando…";
          try {
            const lang = await get("lang_pref", "es-ES");
            const l = await tmdb.getSeasonEpisodes(item.tmdb_id, 1, lang);
            const renderEps = () => {
              const sel = epsSel.get(item.tmdb_id);
              eps.replaceChildren(
                ...(l.length ? l.map(e => {
                  const seen = e.number <= (item.last || 0);
                  const badge = el("span", {
                    className: "ep" + (seen ? " seen" : "") + (sel === e.number ? " selected" : ""),
                    textContent: String(e.number)
                  });
                  badge.onclick = () => { epsSel.set(item.tmdb_id, sel === e.number ? null : e.number); renderEps(); };
                  return badge;
                }) : ["Sin episodios"]),
                sel != null ? renderItemEpisodePanel(item, sel, sel <= (item.last || 0), close => {
                  if (close) epsSel.delete(item.tmdb_id);
                  renderEps();
                }) : "");
            };
            renderEps();
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
```

Importa `* as tmdb from "../tmdb.js"` y `get` de `../store.js` al inicio
del archivo (junto a los imports ya existentes).

También quita el botón "Siguiente" (`engine.checkEpisode` contra
`item.provider`/`item.slug`, que ya no existe como concepto fijo por
ítem) — con reproducción multi-sitio no hay "el" provider de un ítem
para comprobar. Su reemplazo (comprobar disponibilidad real contra un
sitio ya resuelto) es Task 8/Plan B, no Plan A.

- [ ] **Step 2: Eliminar engine.episodes() de src/app/engine.js**

Nada llama a esta función tras el paso anterior — bórrala junto con el
comentario que la describe. `series` deja de ser un campo que `engine.js`
interprete (los `rule` de `app_config.players` ya no necesitan
declararlo — Task 5's `validatePlayers` no lo exige, confírmalo).

- [ ] **Step 3: Verificar**

```bash
node --check src/app/ui/list-item.js src/app/engine.js
grep -rn "engine.episodes\|\.series\b" src/app src/web src/extension  # no debe quedar ningún uso
```

- [ ] **Step 4: Commit**

```bash
git add src/app/ui/list-item.js src/app/engine.js
git commit -m "feat: lista de episodios vía TMDB, quita engine.episodes() y el botón Siguiente por ítem"
```

---

### Task 8: Notificaciones básicas vía TMDB (background.js + cron)

**Files:**
- Modify: `src/extension/background.js`
- Modify: `cron/generate-feed.mjs`

**Interfaces:**
- Consumes: `tmdb.getSeasonEpisodes` (Task 1). Plan A implementa solo el
  chequeo por defecto (fecha de emisión de TMDB) — el chequeo híbrido
  opcional por `rule.check_interval_hours` es Plan B.

**Desviación deliberada de la spec:** la spec proponía que el cron leyera
la TMDB key desde su propio secret de GitHub Actions, separado de
`app_config.tmdb_key` (mismo patrón que `SUPABASE_SERVICE_KEY`). Ese
patrón existe para `SUPABASE_SERVICE_KEY` porque es la credencial que
*da acceso* a Supabase — no puede vivir dentro de la propia base de datos
que desbloquea. La TMDB key no tiene ese problema de arranque: el cron ya
tiene acceso de servicio a Supabase por su cuenta, y ya lee `app_config`
para `players`. Como además ya se decidió que la key es segura de
exponer (no es sensible, ver spec sección "TMDB API key"), no hay ninguna
razón de seguridad para mantener dos copias separadas — solo el riesgo
de que se desincronicen. Este plan usa una sola fuente de verdad
(`app_config.tmdb_key`, ya gestionada por el admin en Task 5) para
ambos consumidores; no hace falta ningún secret nuevo de GitHub Actions.

- [ ] **Step 1: Reescribir checkAll() en src/extension/background.js**

Ya no hay `providers`/`p`/`callOffscreen("checkEpisode", ...)` por ítem —
se compara `last` contra los episodios de TMDB con `air_date` ya pasada.
No necesita el documento offscreen para esto (TMDB es JSON puro, sin
DOMParser) — puede hacer `fetch` directo desde el service worker:

```js
async function checkAll() {
  const list = live(await get("watchlist", []));
  const lang = await get("lang_pref", "es-ES");
  const news = await get("news", []);
  const notified = await get("notified", []);
  const today = new Date().toISOString().slice(0, 10);
  for (const it of list) {
    if (it.media_type !== "tv") continue; // las películas no tienen calendario de episodios
    let episodes;
    try { episodes = await callOffscreen("getSeasonEpisodes", it.tmdb_id, 1, lang); }
    catch (e) { console.warn(`Fallo en ${it.title}:`, e); continue; }
    const last = it.last || 0;
    for (const e of episodes) {
      if (e.number <= last) continue;
      if (!e.air_date || e.air_date > today) break; // episodios vienen ordenados, el resto es futuro
      const id = `${it.tmdb_id}-e${e.number}`;
      if (notified.includes(id)) continue;
      notified.push(id);
      news.unshift({ id, tmdb_id: it.tmdb_id, episode: e.number,
                     title: `${it.title} — episodio ${e.number}`, link: null });
      chrome.notifications.create(id, {
        type: "basic", iconUrl: "extension/icons/icon128.png",
        title: "Nuevo episodio", message: `${it.title} — episodio ${e.number}`
      });
    }
  }
  await set("news", news.slice(0, NEWS_CAP));
  await set("notified", notified.slice(-500));
}
```

`callOffscreen("getSeasonEpisodes", ...)` requiere que
`src/extension/offscreen.js` exponga esa operación — añade
`import * as tmdb from "../app/tmdb.js";` ahí y un `case "getSeasonEpisodes": return tmdb.getSeasonEpisodes(...args);`
en su despachador de mensajes (lee el archivo para ver el patrón exacto
que ya usa para `checkEpisode`/`search`/`episodes` y sigue el mismo).

Nota: `link: null` en la entrada de `news` — hoy siempre había una URL
directa al episodio porque veníamos de `checkEpisode` contra un sitio
real. Ahora solo sabemos que "ya emitió", no en qué sitio verlo. Revisa
`src/extension/popup.js`/`src/app/ui/news.js` — el click en una noticia
hace `chrome.tabs.create({url: n.link})`; con `link: null` eso fallaría.
Cambia ese handler para, si `n.link` es `null`, abrir el popup con ese
ítem enfocado en su lugar (o, más simple para Plan A: deshabilita el
click cuando no hay link, mostrando el título sin convertirlo en enlace).

- [ ] **Step 2: Eliminar checkGroups() por completo**

Los grupos ya derivan su progreso de `last` (sin cambios) — el chequeo
"¿salió el episodio del paso actual de este grupo?" ahora es
exactamente el mismo chequeo por TMDB que `checkAll()` ya hace para
cualquier ítem del watchlist (incluyendo los que solo existen para
trackear un paso de grupo, `visible:false`). No hace falta una función
separada — bórrala, y quita su llamada dentro de `run()`.

- [ ] **Step 3: Actualizar cron/generate-feed.mjs**

Mismo cambio de fondo: por cada watchlist row, comparar contra
`tmdb.getSeasonEpisodes(tmdb_id, 1, lang)` en vez de `engine.checkEpisode`
contra un provider. `checkGroupEpisode` deja de tener sentido como
función separada por la misma razón que en `background.js` — elimínala,
el loop principal ya cubre cualquier ítem (de grupo o no) porque
`repairGroup` (Task 4) ya garantiza que todo paso de grupo tiene una fila
de watchlist. El feed RSS pierde el `<link>` por el mismo motivo que las
notificaciones de escritorio — usa la página de TMDB
(`https://www.themoviedb.org/tv/{tmdb_id}`) como `link` en su lugar, es
mejor que nada y siempre resuelve.

```js
const lang = process.env.TMDB_LANG || "es-ES";
const tmdb = await import("../src/app/tmdb.js");
// ... reemplaza el bloque `for (const it of mine)` por:
for (const it of mine) {
  if (it.media_type !== "tv") continue;
  let episodes;
  try { episodes = await tmdb.getSeasonEpisodes(it.tmdb_id, 1, lang); }
  catch (e) { console.warn(`Fallo en ${it.title}: ${e.message}`); continue; }
  const have = new Set(known.filter(f => f.tmdb_id === it.tmdb_id).map(f => f.episode));
  const today = new Date().toISOString().slice(0, 10);
  for (const e of episodes) {
    if (e.number <= it.last || have.has(e.number)) continue;
    if (!e.air_date || e.air_date > today) break;
    fresh.push({ user_id: st.user_id, tmdb_id: it.tmdb_id, episode: e.number,
                 title: `${it.title} — episodio ${e.number}`,
                 link: `https://www.themoviedb.org/tv/${it.tmdb_id}` });
    console.log(`Nuevo: ${it.title} ep ${e.number}`);
  }
}
```

`tmdb.js` necesita `tmdb_key`, que en el cron no puede pasar por
`store.js` (no hay `chrome.storage` ni `localStorage` en Node — `get()`
reventaría con `localStorage is not defined` al intentar caer a ese
fallback). Por eso `tmdb.js` (Task 1) lee primero
`globalThis.__tmdbApiKey` antes de tocar `store.js` — fija esa variable
directamente, sin pasar por `set()`:

```js
const [appConfig] = await rest("app_config?select=players,tmdb_key&id=eq.1");
globalThis.__tmdbApiKey = appConfig?.tmdb_key || null;
```

Colócalo justo después de leer `appConfig` (reemplaza la línea existente
`const [appConfig] = await rest("app_config?select=providers&id=eq.1");`
por las dos de arriba, y `providers` pasa a `players = appConfig?.players || {}`
en el resto del archivo, ya no `providers`).

`buildRss`/`checkGroupEpisode` referencias a `provider_id`/`slug` en el
resto del archivo (el `<guid>` del RSS, el filtro `inList`) cambian a
`tmdb_id`.

`buildRss`/`checkGroupEpisode` referencias a `provider_id`/`slug` en el
resto del archivo (el `<guid>` del RSS, el filtro `inList`) cambian a
`tmdb_id`.

- [ ] **Step 4: Verificar**

```bash
node --check src/extension/background.js src/extension/offscreen.js cron/generate-feed.mjs
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/extension/background.js src/extension/offscreen.js cron/generate-feed.mjs
git commit -m "feat: notificaciones y feed vía fecha de emisión de TMDB, quita checkGroups()"
```

---

### Task 9: Actualizar la suite de tests

**Files:**
- Modify: `src/test/list.spec.js`, `src/test/groups.spec.js`
- Modify: `src/test/integration/sync-cron.spec.js`
- Modify: `src/test/mock_supabase.py`, `src/test/mock_site.py` (si el
  segundo mockea `series`/episodios por HTML — revisa si sigue haciendo
  falta tras Task 7, probablemente ya no)
- Create: `src/test/ui/resolve.spec.js`

**Interfaces:**
- Ninguna nueva — esta tarea es puramente de cobertura sobre lo ya
  construido en Tasks 1-8.

- [ ] **Step 1: Leer y reescribir src/test/list.spec.js y src/test/groups.spec.js**

Léelos completos primero. Cada `assert` que hoy construye/espera
`{provider, slug, ...}` pasa a `{tmdb_id, media_type, poster_path, ...}`;
cada llamada a `mutate(provider, slug, fn)` pasa a `mutate(tmdbId, fn)`.
`repairGroup`'s test necesita mockear `tmdb.getShow` (no `engine.search`
contra un provider) — sigue el mismo patrón de mock por `fetch` usado en
`src/test/tmdb.spec.js` (Task 1), sembrando `tmdb_key` y stubeando
`globalThis.fetch`.

- [ ] **Step 2: Leer y reescribir src/test/integration/sync-cron.spec.js**

Mismo criterio: los escenarios multiusuario ahora suben/bajan
`tmdb_id`/`media_type`/`poster_path`/`players` en vez de
`provider_id`/`slug`/`link`/`image`; `app_config` sube/baja
`players`/`tmdb_key` en vez de `providers`. `src/test/mock_supabase.py`
necesita actualizar su modelo de las tablas `watchlist`/`episodes_found`/
`app_config` para las nuevas columnas — léelo primero para entender cómo
modela las tablas hoy (probablemente diccionarios Python keyed por lo que
antes era `(user_id, provider_id, slug)`) y adapta la clave a
`(user_id, tmdb_id)`.

Los escenarios de grupos públicos/cron necesitan que el mock de Supabase
también sirva TMDB (o que el test mockee `tmdb.js` directamente
sembrando `tmdb_key` + `fetch` stub, como en Task 1 — más simple que
levantar un tercer servidor mock).

- [ ] **Step 3: Escribir src/test/ui/resolve.spec.js**

Cubre `resolveAndPlay`/`resolveSlug` de Task 6: sin ningún `rule`
configurado para el idioma → mensaje claro sin reventar; con un `rule`
configurado y sin slug cacheado → busca y expone los resultados para
elegir; con slug ya cacheado en `item.players` → no vuelve a buscar
(usa el mismo mock-site que ya existe para `engine.search`/
`episodePlayers`, no hace falta uno nuevo).

- [ ] **Step 4: Verificar**

```bash
npm test
```
Debe pasar en verde completo — esta es la primera vez desde Task 3 que
toda la suite corre sobre el modelo nuevo de punta a punta.

- [ ] **Step 5: Commit**

```bash
git add src/test/
git commit -m "test: actualizar suite completa al modelo de identidad tmdb_id"
```
