# Media auto-creada, carrusel real y reproductor en medias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline, chosen by the user over subagent-driven-development). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** las entradas de `watchlist` que "Reparar"/suscribirse crea automáticamente
(solo para poder llevar el conteo de episodios de un paso de grupo) dejan de aparecer
como si fueran media añadida a propósito. El carrusel de avatares de un grupo pasa a
ser un carrusel real (una imagen, flechas, sincronizado con el episodio seleccionado).
Una media normal gana el mismo panel de acción (Marcar visto/Desmarcar/Abrir/▶ Ver
aquí) que ya tiene un episodio de grupo, en vez de un link directo al proveedor.

**Architecture:** `watchlist` gana una columna `visible` (default `true`). `list.js`'s
`add()` acepta `{visible}`; solo `repairGroup()` (en `groups.js`) la usa con
`visible:false`, y de paso intenta una búsqueda real en el provider antes de caer al
título derivado del slug. La vista unificada filtra por `visible !== false` bajo
"Media"/"Ambos". El carrusel y el panel de episodio de una media normal reutilizan los
mismos patrones ya usados por el itinerario de grupo (`renderPlayerPicker`, badges
`.ep`, selección por Map).

**Tech Stack:** igual que el resto del proyecto.

**Spec:** ninguna aparte — diseño acordado en chat, sesión del 2026-09-26/27.

## Global Constraints

- `visible` por defecto `true` en Supabase (columna nueva) y al tratar un valor
  ausente en el cliente (`item.visible !== false`, nunca `=== true`) — así ni las filas
  ya existentes en Supabase ni la caché local de antes de esta migración cambian de
  comportamiento sin necesidad de una sync previa.
- `repairGroup(g, watchlist)` mantiene su firma externa exacta — ningún llamador
  cambia.
- Reutilizar patrones ya existentes en vez de inventar nuevos: badges `.ep`/`.itin`
  para episodios seleccionables, `renderPlayerPicker` para SUB/DUB, `Math.max`/
  `Math.min` monótonos para marcar/desmarcar.
- Verificación de cada tarea: `bash tests/run.sh` cuando haya test automático, más
  `node --check` en los archivos tocados; las tareas de UI se verifican también a
  mano en el navegador (esta vez es ejecución en línea, no subagentes a ciegas).

---

### Task 1: Esquema de Supabase — `watchlist.visible`

**Files:**
- Create: `supabase/migrations/20260927100000_watchlist_visible.sql`
- Modify: `supabase/schema.sql`

- [ ] **Step 1: Migración**

```sql
-- Marca si una entrada de watchlist la añadió el usuario a propósito (true, por
-- defecto) o la creó automáticamente "Reparar"/suscribirse solo para poder llevar el
-- conteo de episodios de un paso de grupo (false) — estas últimas no deben aparecer
-- como si fueran media añadida deliberadamente.
alter table public.watchlist add column if not exists visible boolean not null default true;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Mismo bloque en `schema.sql`**

Añade la columna a la definición de `watchlist` en `supabase/schema.sql` (busca la
tabla `create table if not exists public.watchlist (...)` y añade `visible boolean not
null default true,` como columna, en el mismo sitio lógico que `last`/`deleted`), y
añade el mismo comentario+`alter table` justo antes del `notify` final del archivo (así
`schema.sql`, ejecutado contra un proyecto YA existente, también funciona vía
`add column if not exists`).

- [ ] **Step 3: Verificación y commit**

No hay test automático para SQL. Revisa que ambos archivos coincidan y que
`schema.sql` termine con un único `notify pgrst, 'reload schema';`.

```bash
git add supabase/schema.sql supabase/migrations/20260927100000_watchlist_visible.sql
git commit -m "feat: columna watchlist.visible para distinguir media añadida a propósito"
```

---

### Task 2: `extension/list.js` — `add()` con `visible`

**Files:**
- Modify: `extension/list.js`

- [ ] **Step 1: Añadir el parámetro**

Busca:

```js
export async function add(r) {
  const l = await get("watchlist", []);
  const now = new Date().toISOString();
  const it = l.find(x => same(x, r.provider, r.slug));
  if (it) { it.deleted = false; it.updated_at = now; }
  else l.push({ provider: r.provider, slug: r.slug, title: r.title, link: r.link, image: r.image,
                last: 0, deleted: false, updated_at: now });
  await set("watchlist", l);
}
```

Sustitúyelo por:

```js
// visible=true (por defecto): la persona lo añadió a propósito (buscar y guardar,
// incluido elegir un resultado al construir un paso de grupo) — se refrescan
// título/link/imagen por si la búsqueda tiene mejores datos que lo que ya había.
// visible=false: creación automática (repairGroup) solo para poder llevar el conteo
// de episodios — nunca pisa datos ya existentes si el ítem ya estaba.
export async function add(r, { visible = true } = {}) {
  const l = await get("watchlist", []);
  const now = new Date().toISOString();
  const it = l.find(x => same(x, r.provider, r.slug));
  if (it) {
    it.deleted = false;
    it.updated_at = now;
    if (visible) { it.visible = true; it.title = r.title; it.link = r.link; it.image = r.image; }
  } else {
    l.push({ provider: r.provider, slug: r.slug, title: r.title, link: r.link, image: r.image,
             last: 0, visible, deleted: false, updated_at: now });
  }
  await set("watchlist", l);
}
```

- [ ] **Step 2: Verificación**

```bash
node --check extension/list.js
```

- [ ] **Step 3: Commit**

```bash
git add extension/list.js
git commit -m "feat: list.js add() distingue añadido a propósito de auto-creado"
```

---

### Task 3: `extension/groups.js` — `repairGroup` oculta y busca datos reales

**Files:**
- Modify: `extension/groups.js`
- Modify: `tests/test-groups.mjs`

**Interfaces:** `repairGroup(g, watchlist)` mantiene su firma; internamente ahora lee
`providers` de `store.js` y usa `engine.search`.

- [ ] **Step 1: Importar `engine.js`**

Busca:

```js
import { get, set } from "./store.js";
import { mutate, add } from "./list.js";
```

Sustitúyelo por:

```js
import { get, set } from "./store.js";
import { mutate, add } from "./list.js";
import * as engine from "./engine.js";
```

- [ ] **Step 2: `repairGroup` intenta una búsqueda real antes del placeholder**

Busca:

```js
export async function repairGroup(g, watchlist) {
  for (const s of missingSteps(g, watchlist)) {
    await add({ provider: s.provider, slug: s.slug, title: prettify(s.slug), link: null, image: null });
  }
}
```

Sustitúyelo por:

```js
export async function repairGroup(g, watchlist) {
  const providers = await get("providers", []);
  for (const s of missingSteps(g, watchlist)) {
    let title = prettify(s.slug), link = null, image = null;
    const p = providers.find(x => x.id === s.provider);
    if (p) {
      try {
        const res = await engine.search(p, prettify(s.slug));
        const hit = res.find(r => r.slug === s.slug) || res[0];
        if (hit) { title = hit.title; link = hit.link; image = hit.image; }
      } catch { /* sin conexión o sin match: se queda con el título derivado del slug */ }
    }
    await add({ provider: s.provider, slug: s.slug, title, link, image }, { visible: false });
  }
}
```

- [ ] **Step 3: `tests/test-groups.mjs` necesita `DOMParser` ahora que `groups.js` usa `engine.js`**

Busca la primera línea del archivo:

```js
// node tests/test-groups.mjs — sin mocks, funciones puras.
import assert from "node:assert/strict";
import { nextNeeded, currentStep, itinerary } from "../extension/groups.js";
```

Sustitúyelo por (añade el mismo polyfill que ya usan `test-engine.mjs`/el cron):

```js
// node tests/test-groups.mjs — necesita DOMParser porque groups.js usa engine.js
// (repairGroup intenta una búsqueda real antes de caer al placeholder del slug).
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const { nextNeeded, currentStep, itinerary } = await import("../extension/groups.js");
```

- [ ] **Step 4: Verificar que el test de `repairGroup` que ya existe sigue pasando sin providers configurados**

El bloque añadido por el plan anterior (`missingSteps/repairGroup OK`) no configura
`providers`, así que `repairGroup` debe seguir cayendo al placeholder derivado del slug
exactamente igual que antes — no hace falta tocar ese bloque, solo confirmar que sigue
en verde.

- [ ] **Step 5: Test nuevo — `repairGroup` usa un resultado de búsqueda real cuando lo encuentra**

Con `tests/mock_site.py` en marcha (igual que `test-engine.mjs`), añade después del
bloque `repairGroup OK` existente (busca `console.log("missingSteps/repairGroup OK");`
y añade justo después):

```js
// repairGroup con un provider real (mock) configurado: si la búsqueda encuentra el
// slug exacto, usa su título/imagen reales en vez del placeholder derivado del slug.
await set("providers", JSON.parse(await (await import("node:fs")).promises.readFile(
  new URL("./mock-provider.json", import.meta.url), "utf8")));
const g4 = await addGroup("Con provider real");
await addStep(g4.id, { provider: "mock", slug: "frieren", from: 1, to: 1 });
await repairGroup(g4, live(await get("watchlist", [])));
const frierenItem = live(await get("watchlist", [])).find(w => w.provider === "mock" && w.slug === "frieren");
assert.ok(frierenItem, "repairGroup creó la entrada");
assert.equal(frierenItem.title, "Frieren", "usó el título real de la búsqueda, no el del slug");
assert.equal(frierenItem.visible, false, "sigue creándose oculta");
console.log("repairGroup con búsqueda real OK");
```

Este bloque necesita `tests/mock_site.py` corriendo (ya lo levanta `tests/run.sh` antes
de `test-groups.mjs`); si ejecutas el archivo suelto para probarlo, levanta el mock
primero (`python3 tests/mock_site.py &`).

- [ ] **Step 6: Verificación**

```bash
bash tests/run.sh
```

Expected: todo en verde, incluida la nueva línea `repairGroup con búsqueda real OK`.

- [ ] **Step 7: Commit**

```bash
git add extension/groups.js tests/test-groups.mjs
git commit -m "feat: repairGroup crea entradas ocultas e intenta datos reales por búsqueda"
```

---

### Task 4: `extension/sync.js` — propagar `visible`

**Files:**
- Modify: `extension/sync.js`

- [ ] **Step 1: `syncWatchlist` incluye `visible` en ambas direcciones**

Busca:

```js
async function syncWatchlist(uid) {
  const remote = (await rest(`watchlist?select=*&user_id=eq.${uid}`)).map(r => ({
    provider: r.provider_id, slug: r.slug, title: r.title, link: r.link, image: r.image,
    last: r.last, deleted: r.deleted, updated_at: r.updated_at
  }));
```

Sustitúyelo por:

```js
async function syncWatchlist(uid) {
  const remote = (await rest(`watchlist?select=*&user_id=eq.${uid}`)).map(r => ({
    provider: r.provider_id, slug: r.slug, title: r.title, link: r.link, image: r.image,
    last: r.last, visible: r.visible !== false, deleted: r.deleted, updated_at: r.updated_at
  }));
```

Busca:

```js
      body: toPush.map(x => ({
        user_id: uid, provider_id: x.provider, slug: x.slug, title: x.title,
        link: x.link || null, image: x.image || null, last: x.last || 0,
        deleted: !!x.deleted, updated_at: x.updated_at
      }))
```

Sustitúyelo por:

```js
      body: toPush.map(x => ({
        user_id: uid, provider_id: x.provider, slug: x.slug, title: x.title,
        link: x.link || null, image: x.image || null, last: x.last || 0,
        visible: x.visible !== false, deleted: !!x.deleted, updated_at: x.updated_at
      }))
```

- [ ] **Step 2: Verificación**

```bash
node --check extension/sync.js
bash tests/run.sh
```

- [ ] **Step 3: Commit**

```bash
git add extension/sync.js
git commit -m "feat: sync.js propaga watchlist.visible"
```

---

### Task 5: Extensión — filtro por visible, carrusel real, reproductor en medias

**Files:**
- Modify: `extension/popup.js`
- Modify: `extension/popup.html`

- [ ] **Step 1: `renderMain()` respeta `visible`**

Busca:

```js
  if (listFilter !== "groups") entries.push(...watchlist.map(item => ({ kind: "item", data: item, ts: item.updated_at })));
```

Sustitúyelo por:

```js
  if (listFilter !== "groups") entries.push(...watchlist.filter(item => item.visible !== false).map(item => ({ kind: "item", data: item, ts: item.updated_at })));
```

- [ ] **Step 2: Carrusel real — sustituir `renderAvatars`**

Busca la función `renderAvatars` completa:

```js
function renderAvatars(g, cur, watchlist) {
  const distinct = [...new Map(g.steps.map(s => [`${s.provider}|${s.slug}`, s])).values()];
  const colors = titleColors(g.steps);
  return el("div", { className: "avatars" }, ...distinct.map(s => {
    const it = watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
    const isCur = !!cur && cur.step.provider === s.provider && cur.step.slug === s.slug;
    return avatarEl(it ? it.title : s.slug, colors.get(`${s.provider}|${s.slug}`), isCur, it?.image);
  }));
}
```

Sustitúyelo por:

```js
const avatarSel = new Map(); // id de grupo -> índice del título mostrado en el carrusel

function distinctTitles(g) {
  return [...new Map(g.steps.map(s => [`${s.provider}|${s.slug}`, s])).values()];
}

// Un carrusel real: una imagen a la vez, con flechas. Si hay un episodio seleccionado
// en el itinerario, muestra el título al que pertenece (se sincroniza desde el
// onclick de los badges, ver renderItinerary); si no, muestra el paso actual.
function renderAvatars(g, cur, watchlist, onChange) {
  const distinct = distinctTitles(g);
  if (!distinct.length) return el("div", {});
  const colors = titleColors(g.steps);
  if (!avatarSel.has(g.id)) {
    const curIdx = cur ? distinct.findIndex(s => s.provider === cur.step.provider && s.slug === cur.step.slug) : 0;
    avatarSel.set(g.id, Math.max(0, curIdx));
  }
  const idx = Math.min(avatarSel.get(g.id), distinct.length - 1);
  const s = distinct[idx];
  const it = watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  const isCur = !!cur && cur.step.provider === s.provider && cur.step.slug === s.slug;
  const move = d => { avatarSel.set(g.id, (idx + d + distinct.length) % distinct.length); onChange(); };
  return el("div", { className: "avatars" },
    distinct.length > 1 ? btn("◀", () => move(-1)) : "",
    avatarEl(it ? it.title : s.slug, colors.get(`${s.provider}|${s.slug}`), isCur, it?.image),
    distinct.length > 1 ? btn("▶", () => move(1)) : "");
}
```

- [ ] **Step 3: `renderItinerary` sincroniza el carrusel al elegir un episodio de otro título**

Busca (dentro de `renderItinerary`, el onclick del badge):

```js
    // Un toque selecciona/abre la tarjeta de acción; toca otra vez para cerrarla.
    badge.onclick = () => {
      itinSel.set(g.id, isSel ? null : { step: e.step, episode: e.episode, item: e.item, seen: e.seen });
      renderGroups();
    };
```

Sustitúyelo por:

```js
    // Un toque selecciona/abre la tarjeta de acción; toca otra vez para cerrarla.
    // También cambia el carrusel de avatares al título de este episodio.
    badge.onclick = () => {
      itinSel.set(g.id, isSel ? null : { step: e.step, episode: e.episode, item: e.item, seen: e.seen });
      const idx = distinctTitles(g).findIndex(s => s.provider === e.step.provider && s.slug === e.step.slug);
      if (idx >= 0) avatarSel.set(g.id, idx);
      renderGroups();
    };
```

Nota: en `popup.js` la función que redibuja tras esta acción es `renderGroups()`
(este archivo aún no se llama `renderMain` en el momento de escribir este plan si el
plan de grupos públicos no ha corrido todavía en tu copia — usa el nombre real que
tenga la función que ya se llama desde el resto de `renderItinerary` en el archivo
actual, sea `renderGroups` o `renderMain`).

- [ ] **Step 4: Actualizar la llamada a `renderAvatars` para pasar `onChange`**

Busca (dentro de la construcción de la tarjeta de grupo):

```js
        renderAvatars(g, cur, watchlist),
```

Sustitúyelo por:

```js
        renderAvatars(g, cur, watchlist, () => { renderGroups(); }),
```

(mismo comentario que el Step 3 sobre el nombre real de la función de redibujado —
usa el que exista en tu copia actual del archivo).

- [ ] **Step 5: Panel de acción para episodios de una media normal**

Busca la función `itemCard` completa:

```js
function itemCard(item) {
  const st = el("div", { className: "st" });
  const eps = el("div", { className: "eps" });
  return el("div", { className: "card" },
    item.image ? el("img", { src: safe(item.image) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      el("div", { textContent: "Visto hasta el episodio " + (item.last || 0) }),
      el("div", { className: "actions" },
        btn("Siguiente", () => checkNext(item, st)),
        btn("Episodios", async () => {
          await ensurePermissions();
          eps.textContent = "Cargando…";
          try {
            const l = await engine.episodes(prov(item.provider), item.slug);
            eps.replaceChildren(...(l.length ? l.map(e => {
              const a = link(e.link, String(e.number));
              if (e.number <= (item.last || 0)) a.className = "seen";
              return a;
            }) : ["Sin episodios"]));
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
        btn("Visto +1", () => markSeen(item)),
        btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderMain(); sync(); })),
      st, eps));
}
```

Sustitúyelo por (los badges de episodio ahora son seleccionables y abren el mismo
panel de acción que ya tiene el itinerario de un grupo; reutiliza `renderPlayerPicker`,
ya definida más abajo en el archivo):

```js
const epsSel = new Map(); // "provider|slug" -> episodio seleccionado, o null

function renderItemEpisodePanel(item, episode, seen, onChange) {
  const p = prov(item.provider);
  const url = p ? engine.episodeUrl(p, item.slug, episode) : null;
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${item.title} — episodio ${episode}` }),
      el("div", { className: "actions" },
        seen
          ? btn("Desmarcar", async () => { await mutate(item.provider, item.slug, x => { x.last = Math.min(x.last || 0, episode - 1); }); onChange(); })
          : btn("Marcar visto", async () => { await mutate(item.provider, item.slug, x => { x.last = Math.max(x.last || 0, episode); }); onChange(); }),
        url ? link(url, "Abrir") : "",
        p ? btn("▶ Ver aquí", async () => {
              await ensurePermissions(item.provider);
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, item.slug, episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
        btn("Cerrar", () => { epsSel.delete(`${item.provider}|${item.slug}`); onChange(); })),
      playerBox));
}

function itemCard(item) {
  const st = el("div", { className: "st" });
  const eps = el("div", { className: "itin" });
  const key = `${item.provider}|${item.slug}`;
  return el("div", { className: "card" },
    item.image ? el("img", { src: safe(item.image) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      el("div", { textContent: "Visto hasta el episodio " + (item.last || 0) }),
      el("div", { className: "actions" },
        btn("Siguiente", () => checkNext(item, st)),
        btn("Episodios", async () => {
          await ensurePermissions();
          eps.textContent = "Cargando…";
          try {
            const l = await engine.episodes(prov(item.provider), item.slug);
            const renderEps = () => {
              const sel = epsSel.get(key);
              eps.replaceChildren(
                ...(l.length ? l.map(e => {
                  const seen = e.number <= (item.last || 0);
                  const badge = el("span", {
                    className: "ep" + (seen ? " seen" : "") + (sel === e.number ? " selected" : ""),
                    textContent: String(e.number)
                  });
                  badge.onclick = () => { epsSel.set(key, sel === e.number ? null : e.number); renderEps(); };
                  return badge;
                }) : ["Sin episodios"]),
                sel != null ? renderItemEpisodePanel(item, sel, sel <= (item.last || 0), renderEps) : "");
            };
            renderEps();
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
        btn("Visto +1", () => markSeen(item)),
        btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderMain(); sync(); })),
      st, eps));
}
```

- [ ] **Step 6: Verificación**

```bash
node --check extension/popup.js
bash tests/run.sh
```

Prueba a mano en el navegador (carga la extensión sin empaquetar, recarga tras el
cambio): un grupo con varios títulos muestra el carrusel con flechas en vez de todas
las miniaturas a la vez, y al elegir un episodio de otro título el carrusel cambia
solo; una media normal, al pulsar "Episodios", muestra badges en vez de links, y al
pulsar uno se abre el panel con Marcar visto/Abrir/▶ Ver aquí.

- [ ] **Step 7: Commit**

```bash
git add extension/popup.js extension/popup.html
git commit -m "feat: extensión — media oculta no aparece, carrusel real, reproductor en medias"
```

---

### Task 6: PWA — mismo cambio

**Files:**
- Modify: `web/app.js`
- Modify: `web/index.html`

Repite exactamente los mismos cambios de la Task 5 sobre `web/app.js` (usa `renderMain`
como nombre real de la función de redibujado — en `web/app.js` esa función ya existe
con ese nombre desde el plan de grupos públicos) y verifica igual:

```bash
node --check web/app.js
bash tests/run.sh
```

Prueba a mano en el navegador (recarga la PWA, fuerza refresco por el service worker si
hace falta).

- [ ] **Commit**

```bash
git add web/app.js web/index.html
git commit -m "feat: PWA — media oculta no aparece, carrusel real, reproductor en medias"
```

---

### Task 7: Verificación final

- [ ] **Step 1: Suite completa + sintaxis**

```bash
bash tests/run.sh
node --check extension/list.js && node --check extension/groups.js && node --check extension/sync.js && node --check extension/popup.js && node --check web/app.js
git status --short
```

- [ ] **Step 2: Prueba manual guiada** (con tu cuenta real, no una de prueba)

1. Crea/edita un grupo con al menos 2 títulos donde alguno no esté ya en tu lista —
   confirma que tras "Reparar" (o al crear el grupo) esos títulos NO aparecen como
   tarjetas sueltas en "Mi lista" con el filtro en "Media" o "Ambos".
2. Busca y guarda a propósito uno de esos mismos títulos — confirma que AHORA sí
   aparece como tarjeta suelta (se "graduó" a visible).
3. Abre el grupo: confirma el carrusel muestra una imagen con flechas, y que al tocar
   un episodio de un título distinto el carrusel cambia solo a esa imagen.
4. En una media normal (no de grupo), pulsa "Episodios", toca un número, y confirma
   que se abre el panel con Marcar visto/Abrir/▶ Ver aquí en vez de saltar directo al
   proveedor.

Reporta cualquier cosa que no se comporte así antes de dar la tarea por terminada.
