# Grupos de orden de visionado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar que el usuario defina "grupos" (playlists) que reordenan y filtran ítems ya guardados en su `watchlist`, con progreso derivado del `last` de cada ítem, sincronizados vía Supabase, visibles en el popup de la extensión y en la PWA, y con el cron/background avisando cuando el episodio que un grupo necesita ya está disponible.

**Architecture:** `extension/groups.js` (nuevo) concentra la lógica pura (qué episodio toca a continuación) y el CRUD sobre `store.js`, siguiendo el mismo patrón que `extension/list.js`. `sync.js` gana una función `syncGroups` calcada de `syncWatchlist`. `background.js` y `cron/generate-feed.mjs` importan la función pura `currentStep` de `groups.js` para saber qué episodio comprobar. La UI (popup y PWA) es código nuevo en `popup.js`/`app.js`, sin dependencias nuevas, reutilizando los mismos helpers (`el`, `btn`, `link`) que ya existen en cada archivo.

**Tech Stack:** JS vanilla (ES modules), sin frameworks ni dependencias nuevas. Tests con `node:assert/strict` contra los mocks Python ya existentes (`tests/mock_site.py`, `tests/mock_supabase.py`).

**Spec:** [docs/superpowers/specs/2026-09-25-watch-order-groups-design.md](../specs/2026-09-25-watch-order-groups-design.md)

## Global Constraints

- No añadir dependencias npm nuevas.
- `extension/groups.js` no debe importar nada que dependa de `chrome.*` fuera de `store.js` (lo importa `cron/generate-feed.mjs` en Node, donde `chrome` no existe — solo puede usar las funciones puras `nextNeeded`/`currentStep`, nunca el CRUD, desde el cron).
- Toda mutación de datos locales sella `updated_at` con `new Date().toISOString()`, igual que `list.js`.
- Los ids de grupo se generan con `crypto.randomUUID()` (disponible en extensión, PWA y Node ≥19; no hace falta en el cron, que nunca crea grupos).
- Seguir el estilo ya existente: sin punto y coma en cierres de flecha innecesarios donde el resto del archivo no los usa no aplica aquí — sí mantener el estilo de comillas dobles, `const`/arrow functions, y los helpers `el`/`btn`/`link` ya definidos en cada UI.

---

## Task 1: Esquema `groups` (ya escrito) — commitear y aplicar

**Files:**
- Modify: `supabase/schema.sql` (ya editado en esta sesión, añade tabla `groups` antes del bucket de storage)
- Create: `supabase/migrations/20260924223000_initial_schema.sql` (ya escrito, copia del schema.sql original)
- Create: `supabase/migrations/20260925120000_groups.sql` (ya escrito)

**Interfaces:**
- Produces: tabla `public.groups(user_id, id, name, steps jsonb, deleted, updated_at)` con RLS `"own groups"`, consumida por las tareas 4-10.

Estos tres archivos ya existen en el working tree de esta sesión (no hay que escribirlos de nuevo). Este task es solo confirmarlos y dejar constancia.

- [ ] **Step 1: Confirmar que los tres archivos existen y son consistentes**

```bash
cat /home/bra/workspaces/rss-anime/supabase/migrations/20260925120000_groups.sql
grep -A15 "create table if not exists public.groups" /home/bra/workspaces/rss-anime/supabase/schema.sql
```

Expected: el `create table` de `groups` es idéntico en ambos (mismas columnas, mismo `primary key (user_id, id)`).

- [ ] **Step 2: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add supabase/schema.sql supabase/migrations/
git status --short   # debe mostrar solo estos archivos
git commit -m "$(cat <<'EOF'
db: esquema de groups (playlists de orden de visionado)

Tabla nueva groups (user_id, id, name, steps jsonb, deleted, updated_at)
con RLS igual que watchlist. Añadida tanto a schema.sql (ruta manual, SQL
Editor) como a supabase/migrations/ (ruta CLI, supabase db push).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Avisar al usuario**

Este paso no es código: cuando se llegue aquí, decirle al usuario que pegue el contenido de `supabase/migrations/20260925120000_groups.sql` en el SQL Editor de su proyecto Supabase (es idempotente, seguro de re-ejecutar). No requiere PC ni contraseña de CLI — funciona desde el móvil igual que hizo con `schema.sql` la primera vez.

---

## Task 2: `extension/groups.js` — lógica pura

**Files:**
- Create: `extension/groups.js`
- Create: `tests/test-groups.mjs`

**Interfaces:**
- Produces: `live(list) → array`, `nextNeeded(step, last) → number|null`, `currentStep(group, watchlist) → {step, item, next}|null`
- Consumes: nada (funciones puras, sin I/O)

- [ ] **Step 1: Escribir el test (fallará, el módulo no existe todavía)**

Crear `tests/test-groups.mjs`:

```js
// node tests/test-groups.mjs — sin mocks, funciones puras.
import assert from "node:assert/strict";
import { nextNeeded, currentStep } from "../extension/groups.js";

// nextNeeded: caso simple
assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 0), 1);
assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 3), 4);
assert.equal(nextNeeded({ from: 1, to: 5, exclude: [] }, 5), null); // completo

// nextNeeded: con exclusión, salta el número excluido
assert.equal(nextNeeded({ from: 21, to: 50, exclude: [25] }, 24), 26);
// nextNeeded: si solo quedan excluidos hasta `to`, cuenta como completo
assert.equal(nextNeeded({ from: 1, to: 3, exclude: [1, 2, 3] }, 0), null);

console.log("nextNeeded OK");

// currentStep: el primer paso incompleto es el actual
const g1 = {
  steps: [
    { provider: "p", slug: "a", from: 1, to: 3, exclude: [] },
    { provider: "p", slug: "b", from: 1, to: 5, exclude: [] }
  ]
};
const wl1 = [{ provider: "p", slug: "a", last: 1 }, { provider: "p", slug: "b", last: 0 }];
let cur = currentStep(g1, wl1);
assert.equal(cur.step.slug, "a");
assert.equal(cur.next, 2);

// currentStep: salta al siguiente paso cuando el primero ya está completo
const wl2 = [{ provider: "p", slug: "a", last: 3 }, { provider: "p", slug: "b", last: 0 }];
cur = currentStep(g1, wl2);
assert.equal(cur.step.slug, "b");
assert.equal(cur.next, 1);

// currentStep: grupo entero completo → null
const wl3 = [{ provider: "p", slug: "a", last: 3 }, { provider: "p", slug: "b", last: 5 }];
assert.equal(currentStep(g1, wl3), null);

// currentStep: grupo sin pasos → null
assert.equal(currentStep({ steps: [] }, wl1), null);

// currentStep: ítem del paso no está en la watchlist (borrado) — no debe crashear,
// trata `last` como 0 y deja `item` undefined para que la UI pueda avisar
const cur2 = currentStep(g1, []);
assert.equal(cur2.step.slug, "a");
assert.equal(cur2.item, undefined);
assert.equal(cur2.next, 1);

console.log("currentStep OK");
console.log("TODO OK");
```

- [ ] **Step 2: Ejecutar y confirmar que falla**

```bash
node tests/test-groups.mjs
```

Expected: `Error [ERR_MODULE_NOT_FOUND]` — `extension/groups.js` no existe.

- [ ] **Step 3: Crear `extension/groups.js` con la implementación mínima**

```js
// Grupos de orden de visionado (playlists). El progreso no tiene contador propio: se
// deriva del `last` de cada ítem de watchlist, igual que ve el resto de la app.
// Ver docs/superpowers/specs/2026-09-25-watch-order-groups-design.md
import { get, set } from "./store.js";
import { mutate } from "./list.js";

export const live = list => list.filter(g => !g.deleted);

export function nextNeeded(step, last) {
  const exclude = new Set(step.exclude || []);
  for (let n = Math.max(step.from, last + 1); n <= step.to; n++) {
    if (!exclude.has(n)) return n;
  }
  return null; // ya visto hasta `to`, o solo quedaban excluidos: paso completo
}

export function currentStep(group, watchlist) {
  for (const step of group.steps) {
    const item = watchlist.find(w => w.provider === step.provider && w.slug === step.slug);
    const last = item?.last || 0;
    const next = nextNeeded(step, last);
    if (next != null) return { step, item, next };
  }
  return null; // grupo completo (o sin pasos)
}
```

(`get`/`set`/`mutate` no se usan todavía en este archivo — los añade el Task 3 — pero se importan ya aquí para no reescribir la cabecera del módulo dos veces. Si el linter del editor avisa de import sin uso, es esperado hasta el siguiente task.)

- [ ] **Step 4: Ejecutar y confirmar que pasa**

```bash
node tests/test-groups.mjs
```

Expected:
```
nextNeeded OK
currentStep OK
TODO OK
```

- [ ] **Step 5: Añadir el test al runner y commitear**

Editar `tests/run.sh`, añadir la línea `node tests/test-groups.mjs` (no necesita los mocks Python, pero no molesta que ya estén arrancados):

```bash
#!/usr/bin/env bash
# Desde la raíz: npm install && bash tests/run.sh
set -e
python3 tests/mock_site.py & P1=$!
python3 tests/mock_supabase.py & P2=$!
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1
node tests/test-engine.mjs
node tests/test-groups.mjs
node tests/test-sync-cron.mjs
```

```bash
cd /home/bra/workspaces/rss-anime
bash tests/run.sh   # debe seguir pasando todo, con la línea nueva de groups.js en medio
git add extension/groups.js tests/test-groups.mjs tests/run.sh
git commit -m "$(cat <<'EOF'
feat: extension/groups.js — lógica pura de progreso de grupos

nextNeeded/currentStep, sin dependencias de storage: derivan el episodio
que toca ver a continuación a partir del último visto (watchlist[].last),
respetando rangos y exclusiones. Cubierto por tests/test-groups.mjs.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `extension/groups.js` — CRUD de grupos y pasos

**Files:**
- Modify: `extension/groups.js`
- Modify: `tests/test-groups.mjs`

**Interfaces:**
- Consumes: `get`/`set` de `./store.js`, `mutate` de `./list.js` (ya importados en Task 2)
- Produces: `addGroup(name) → Promise<Group>`, `renameGroup(id, name) → Promise<Group|null>`, `removeGroup(id) → Promise<Group|null>`, `addStep(id, step) → Promise<Group|null>`, `removeStep(id, index) → Promise<Group|null>`, `moveStep(id, index, dir) → Promise<Group|null>`, `markStepSeen(group, watchlist) → Promise<Item|null>`. `Group = {id, name, steps, deleted, updated_at}`. `Step = {provider, slug, from, to, exclude}`.

- [ ] **Step 1: Añadir los tests de CRUD (fallarán, las funciones no existen)**

Añadir al final de `tests/test-groups.mjs` (antes de `console.log("TODO OK")`, que se mueve al final del todo):

```js
// --- CRUD (con chrome.storage.local falso, mismo patrón que test-sync-cron.mjs) ---
const data = {};
globalThis.chrome = { storage: { local: {
  get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
  set: async o => { Object.assign(data, structuredClone(o)); }
} } };
const { get } = await import("../extension/store.js");
const { addGroup, renameGroup, removeGroup, addStep, removeStep, moveStep, live: liveGroups } =
  await import("../extension/groups.js");

const g = await addGroup("Star Wars cronológico");
assert.equal(liveGroups(await get("groups", [])).length, 1);
assert.equal(g.steps.length, 0);

await addStep(g.id, { provider: "imdb", slug: "sw4" });
await addStep(g.id, { provider: "imdb", slug: "sw5" });
await addStep(g.id, { provider: "animeav1", slug: "clone-wars", from: 1, to: 20 });
let groups = await get("groups", []);
assert.equal(groups[0].steps.length, 3);
assert.deepEqual(groups[0].steps[0], { provider: "imdb", slug: "sw4", from: 1, to: 1, exclude: [] });

await moveStep(g.id, 0, 1); // sw4 <-> sw5
groups = await get("groups", []);
assert.equal(groups[0].steps[0].slug, "sw5");
assert.equal(groups[0].steps[1].slug, "sw4");

await removeStep(g.id, 2); // quita clone-wars
groups = await get("groups", []);
assert.equal(groups[0].steps.length, 2);

await renameGroup(g.id, "SW orden cronológico");
groups = await get("groups", []);
assert.equal(groups[0].name, "SW orden cronológico");

await removeGroup(g.id);
groups = await get("groups", []);
assert.equal(liveGroups(groups).length, 0); // borrado lógico, sigue en storage
assert.equal(groups.length, 1);

console.log("CRUD OK");
console.log("TODO OK");
```

- [ ] **Step 2: Ejecutar y confirmar que falla**

```bash
node tests/test-groups.mjs
```

Expected: `TypeError: addGroup is not a function` (o similar, no está exportado todavía).

- [ ] **Step 3: Añadir el CRUD a `extension/groups.js`**

Añadir al final del archivo (después de `currentStep`):

```js
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

// Marca visto el episodio que toca del paso actual (mismo `mutate` que usa el resto de
// la app para "Visto +1" en list.js, así que actualiza el mismo `last` compartido).
export async function markStepSeen(group, watchlist) {
  const cur = currentStep(group, watchlist);
  if (!cur) return null;
  return mutate(cur.step.provider, cur.step.slug, x => { x.last = cur.next; });
}
```

- [ ] **Step 4: Ejecutar y confirmar que pasa**

```bash
node tests/test-groups.mjs
```

Expected: `nextNeeded OK`, `currentStep OK`, `CRUD OK`, `TODO OK`.

- [ ] **Step 5: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add extension/groups.js tests/test-groups.mjs
git commit -m "$(cat <<'EOF'
feat: CRUD de grupos y pasos en extension/groups.js

addGroup/renameGroup/removeGroup/addStep/removeStep/moveStep/markStepSeen,
mismo patrón que list.js (mutar array, resellar updated_at, set en store).
markStepSeen reutiliza list.js::mutate, así que "visto" desde un grupo
actualiza el mismo last que ve el resto de la app.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `extension/sync.js` — `syncGroups`

**Files:**
- Modify: `extension/sync.js:106-140`
- Modify: `tests/test-sync-cron.mjs`

**Interfaces:**
- Consumes: `rest()`, `now()`, `ts()` (ya definidos en `sync.js`), storage key `"groups"` (formato `Group[]` del Task 2/3)
- Produces: `syncGroups(uid)` llamada desde `syncNow()`. No exportada (como `syncWatchlist`, uso interno del módulo).

- [ ] **Step 1: Extender el test de sincronización (fallará: los grupos no se sincronizan)**

En `tests/test-sync-cron.mjs`, insertar este bloque justo después de la sección "A subió providers y lista" (después de la línea `console.log("A subió providers y lista");`) y antes de "Máquina B: inicia sesión":

```js
// A crea un grupo con un paso
const { addGroup, addStep, live: liveGroups } = await import("../extension/groups.js");
const grupo = await addGroup("Mi maratón");
await addStep(grupo.id, { provider: "mock", slug: "re-zero", from: 1, to: 3 });
await syncNow();
console.log("A subió un grupo");
```

Y, en la sección "Máquina B: inicia sesión" (después de `assert.ok(await get("feed_token"));`), añadir:

```js
const groupsB = liveGroups(await get("groups", []));
assert.equal(groupsB.length, 1);
assert.equal(groupsB[0].name, "Mi maratón");
assert.equal(groupsB[0].steps[0].to, 3);
console.log("B recibió el grupo");
```

Y, en la sección de borrado/restauración (después de `console.log("borrado y restauración propagados");`), añadir un ciclo de edición+borrado de grupo:

```js
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
```

- [ ] **Step 2: Ejecutar y confirmar que falla**

```bash
cd /home/bra/workspaces/rss-anime
python3 tests/mock_site.py & P1=$!
python3 tests/mock_supabase.py & P2=$!
sleep 1
node tests/test-sync-cron.mjs; kill $P1 $P2
```

Expected: falla en "B recibió el grupo" (assert.equal 0 !== 1) — `syncNow()` no toca la tabla `groups` todavía.

- [ ] **Step 3: Añadir `syncGroups` a `extension/sync.js`**

Insertar esta función después de `syncWatchlist` (que termina en la línea 133, justo antes de `export async function syncNow()`):

```js
async function syncGroups(uid) {
  const remote = (await rest(`groups?select=*&user_id=eq.${uid}`)).map(r => ({
    id: r.id, name: r.name, steps: r.steps, deleted: r.deleted, updated_at: r.updated_at
  }));
  const local = await get("groups", []);
  const snapshot = JSON.stringify(local);
  const key = x => x.id;
  const merged = new Map(remote.map(x => [key(x), x]));
  const toPush = [];
  for (const l of local) {
    if (!l.updated_at) l.updated_at = now();
    const r = merged.get(key(l));
    if (!r || ts(l.updated_at) > ts(r.updated_at)) { merged.set(key(l), l); toPush.push(l); }
  }
  if (toPush.length) {
    await rest("groups?on_conflict=user_id,id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: toPush.map(x => ({
        user_id: uid, id: x.id, name: x.name, steps: x.steps, deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("groups", [])) === snapshot) await set("groups", [...merged.values()]);
}
```

Y modificar `syncNow` (línea 135-140) para llamarla:

```js
export async function syncNow() {
  const s = await session();
  await syncSettings(s.user.id);
  await syncWatchlist(s.user.id);
  await syncGroups(s.user.id);
  await set("last_sync", now());
}
```

- [ ] **Step 4: Ejecutar y confirmar que pasa**

```bash
cd /home/bra/workspaces/rss-anime
bash tests/run.sh
```

Expected: todo pasa, incluyendo `A subió un grupo`, `B recibió el grupo`, `grupo: edición y borrado propagados`, y termina en `TODO OK`.

- [ ] **Step 5: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add extension/sync.js tests/test-sync-cron.mjs
git commit -m "$(cat <<'EOF'
feat: sincronizar grupos (syncGroups en sync.js)

Mismo patrón que syncWatchlist: merge por id según updated_at, push de
lo local más nuevo, no pisa cambios locales que hayan llegado durante la
sync. Cubierto extendiendo tests/test-sync-cron.mjs (sube, baja, edita,
borra un grupo entre dos "máquinas").

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `cron/generate-feed.mjs` — chequeo de grupos

**Files:**
- Modify: `cron/generate-feed.mjs:12-13,62-99`
- Modify: `tests/mock_site.py` (una serie más larga, para poder distinguir el chequeo de grupo del chequeo normal por ítem)
- Modify: `tests/test-sync-cron.mjs`

**Interfaces:**
- Consumes: `currentStep` de `../extension/groups.js` (Task 2), tabla REST `groups?select=*&deleted=eq.false`
- Produces: entradas en `episodes_found` y en el RSS con título `"${grupo.name}: ${título} — episodio ${n}"` cuando un grupo necesita un episodio que ya existe

**Por qué hace falta tocar el mock del sitio:** todas las series de `tests/mock_site.py` tienen 3 episodios y el chequeo normal por ítem ya mira hasta 5 episodios por delante del último visto (`MAX_AHEAD`), así que con solo 3 episodios cualquier grupo pediría siempre algo que el chequeo normal ya habría encontrado igual — no probaría nada distinto. Con una serie de 30 episodios, un grupo puede pedir el episodio 20 (fuera de la ventana de 5 que mira el chequeo normal desde `last=0`), demostrando que el chequeo por grupo funciona de forma independiente.

- [ ] **Step 1: Dar a `tests/mock_site.py` una serie más larga**

Reemplazar las dos líneas `SERIES = {"re-zero": "Re:Zero", "frieren": "Frieren", "dandadan": "Dandadan"}` y `EPS = 3` (el episodio ahora va por serie, `EPS` desaparece del todo):

```python
SERIES = {
    "re-zero": ("Re:Zero", 3),
    "frieren": ("Frieren", 3),
    "dandadan": ("Dandadan", 3),
    "longrun": ("Long Run", 30),
}
```

Y en `do_GET`, reemplazar las tres apariciones de `SERIES` que asumían nombre/EPS globales:

```python
    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/catalogo":
            q = parse_qs(u.query).get("search", [""])[0].lower()
            cards = "".join(
                f'<div class="card"><a href="/blabla/{s}"><img src="/img/{s}.jpg"><span class="card-title">{n}</span></a></div>'
                for s, (n, _) in SERIES.items() if q in n.lower())
            return self._send(200, f"<html><body>{cards}</body></html>")
        m = re.fullmatch(r"/blabla/([\w-]+)", u.path)
        if m and m[1] in SERIES:
            eps = "".join(f'<a href="/blabla/{m[1]}/{i}">Episodio {i}</a>' for i in range(1, SERIES[m[1]][1] + 1))
            return self._send(200, f"<html><body><div class='episodes'>{eps}</div></body></html>")
        m = re.fullmatch(r"/blabla/([\w-]+)/(\d+)", u.path)
        if m and m[1] in SERIES and int(m[2]) <= SERIES[m[1]][1]:
            return self._send(200, "<html><body><video src='x.mp4'></video></body></html>")
        self._send(404, "<html><body>No encontrado</body></html>")
```

- [ ] **Step 2: Verificar que el sitio falso sigue sirviendo bien (manual, rápido)**

```bash
cd /home/bra/workspaces/rss-anime
python3 tests/mock_site.py & P=$!
sleep 1
curl -s "http://localhost:8001/blabla/longrun/20" | grep -o video
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8001/blabla/longrun/31"
kill $P
```

Expected: primera línea `video` (episodio 20 existe), segunda línea `404` (episodio 31 no existe, solo hay 30).

- [ ] **Step 3: Extender el test de cron (fallará: el cron no conoce `groups` todavía)**

En `tests/test-sync-cron.mjs`, justo antes de la sección "Cron: debe encontrar ep 2 y 3", añadir un grupo que apunte a `longrun` pidiendo el episodio 20 (fuera de la ventana de 5 que el chequeo normal miraría desde `last=0`):

```js
// Grupo con un paso en una serie larga: pide el episodio 20, que el chequeo normal
// por ítem nunca miraría (last=0, MAX_AHEAD=5 solo llega al 5).
use(A);
await add({ provider: "mock", slug: "longrun", title: "Long Run", link: "x", image: null });
const { addGroup: addGroup2, addStep: addStep2 } = await import("../extension/groups.js");
const gLong = await addGroup2("Maratón larga");
await addStep2(gLong.id, { provider: "mock", slug: "longrun", from: 20, to: 20 });
await syncNow();
console.log("A: serie larga + grupo pidiendo el episodio 20");
```

Y, dentro del bloque final del cron (después de `assert.equal(count(xml), 2);` que comprueba la primera pasada), añadir:

```js
assert.match(xml, /Maratón larga: Long Run — episodio 20/);
const countAfterGroup = count(xml);
```

Y cambiar el `assert.equal(count(xml), 2)` de la SEGUNDA pasada (tras `run()` la segunda vez) para comparar contra `countAfterGroup` en vez de `2` a secas:

```js
run();
xml = await (await fetch(feedUrl)).text();
assert.equal(count(xml), countAfterGroup, "sin duplicados en la segunda pasada");
```

- [ ] **Step 4: Ejecutar y confirmar que falla**

```bash
cd /home/bra/workspaces/rss-anime
bash tests/run.sh
```

Expected: falla en `assert.match(xml, /Maratón larga: Long Run — episodio 20/)` — el cron todavía no comprueba grupos.

- [ ] **Step 5: Añadir el chequeo de grupos a `cron/generate-feed.mjs`**

Añadir el import junto a los existentes (línea 12-13):

```js
globalThis.DOMParser = new JSDOM("").window.DOMParser; // el motor necesita DOMParser
const engine = await import("../extension/engine.js");
const { currentStep } = await import("../extension/groups.js");
```

Añadir la lectura de `groups` junto a las otras dos consultas (línea 62-64):

```js
const settings = await rest("user_settings?select=user_id,providers,feed_token");
const watch = await rest("watchlist?select=*&deleted=eq.false");
const found = await rest("episodes_found?select=*&order=found_at.desc");
const groups = await rest("groups?select=*&deleted=eq.false");
```

Y, dentro del `for (const st of settings)` (línea 66), justo después de que termina el `for (const it of mine) { ... }` que ya existe (después de su `}` de cierre, línea 87) y antes de `if (fresh.length) {` (línea 89), insertar el chequeo por grupo:

```js
    const mineForGroups = mine.map(w => ({ provider: w.provider_id, slug: w.slug, last: w.last, title: w.title }));
    const myGroups = groups.filter(g => g.user_id === st.user_id);
    for (const g of myGroups) {
      const cur = currentStep(g, mineForGroups);
      if (!cur?.next) continue;
      const p = providers.find(x => x.id === cur.step.provider);
      if (!p) continue;
      const already = known.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next);
      if (already) continue;
      let r;
      try { r = await engine.checkEpisode(p, cur.step.slug, cur.next); }
      catch (e) { console.warn(`Fallo en grupo ${g.name}: ${e.message}`); continue; }
      if (!r.exists) continue;
      const title = cur.item?.title || cur.step.slug;
      fresh.push({ user_id: st.user_id, provider_id: cur.step.provider, slug: cur.step.slug, episode: cur.next,
                   title: `${g.name}: ${title} — episodio ${cur.next}`, link: r.url });
      console.log(`Nuevo (grupo ${g.name}): ${title} ep ${cur.next}`);
    }
```

- [ ] **Step 6: Ejecutar y confirmar que pasa**

```bash
cd /home/bra/workspaces/rss-anime
bash tests/run.sh
```

Expected: todo pasa, incluyendo la línea del grupo, y termina en `TODO OK`.

- [ ] **Step 7: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add cron/generate-feed.mjs tests/mock_site.py tests/test-sync-cron.mjs
git commit -m "$(cat <<'EOF'
feat: el cron avisa cuando un grupo necesita un episodio disponible

generate-feed.mjs importa currentStep() de groups.js (función pura, sin
storage) para saber qué episodio le toca a cada grupo, independientemente
de la ventana MAX_AHEAD del chequeo normal por ítem. Reutiliza
episodes_found tal cual (misma clave primaria, dedupe automático si el
chequeo normal ya encontró el mismo episodio).

mock_site.py gana una serie de 30 episodios para poder probar un caso
donde el grupo pide algo que el chequeo normal no miraría.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `extension/background.js` — notificaciones de grupo

**Files:**
- Modify: `extension/background.js:1-3,85-95`

**Interfaces:**
- Consumes: `live` de `./groups.js`, `currentStep` de `./groups.js`, `live` de `./list.js` (ya importado), `callOffscreen` (ya definido en este archivo)
- Produces: entradas en `news`/`notified` con id `group-${groupId}-e${n}` (distinto del `${provider}-${slug}-e${n}` que ya usa el chequeo normal, para que ambos puedan notificar el mismo episodio con contexto distinto sin pisarse)

No tiene test automatizado — el propio README ya dice que la extensión no está cubierta por `tests/run.sh` ("no cubre el popup ni las notificaciones en un Chromium real"). La verificación de este task es manual, con la extensión cargada.

- [ ] **Step 1: Añadir el import**

En la línea 1-3 de `extension/background.js`:

```js
import { get, set } from "./store.js";
import { live } from "./list.js";
import { live as liveGroups, currentStep } from "./groups.js";
import { syncNow, getSession } from "./sync.js";
```

- [ ] **Step 2: Añadir `checkGroups()` después de `checkAll()`**

Insertar después de la línea 85 (el `}` que cierra `checkAll`), antes del comentario `// Sincroniza (si hay sesión) y luego comprueba episodios.`:

```js
async function checkGroups() {
  const groups = liveGroups(await get("groups", []));
  if (!groups.length) return;
  const watchlist = live(await get("watchlist", []));
  const providers = await get("providers", []);
  const news = await get("news", []);
  const notified = await get("notified", []);
  for (const g of groups) {
    const cur = currentStep(g, watchlist);
    if (!cur?.next) continue;
    const p = providers.find(x => x.id === cur.step.provider);
    if (!p) continue;
    let r;
    try { r = await callOffscreen("checkEpisode", p, cur.step.slug, cur.next); }
    catch (e) { console.warn(`Fallo en grupo ${g.name}:`, e); continue; }
    if (!r.exists) continue;
    const id = `group-${g.id}-e${cur.next}`;
    if (notified.includes(id)) continue;
    notified.push(id);
    const title = cur.item?.title || cur.step.slug;
    news.unshift({ id, provider: cur.step.provider, slug: cur.step.slug, episode: cur.next,
                   title: `${g.name}: ${title} — episodio ${cur.next}`, link: r.url });
    chrome.notifications.create(id, {
      type: "basic", iconUrl: "icons/icon128.png",
      title: "Nuevo episodio (grupo)", message: `${g.name}: ${title} — episodio ${cur.next}`
    });
  }
  await set("news", news.slice(0, NEWS_CAP));
  await set("notified", notified.slice(-500));
}
```

- [ ] **Step 3: Llamarla desde `run()`**

Modificar `run()` (línea 88-95):

```js
async function run() {
  if (running) return;
  running = true;
  try {
    try { if (await getSession()) await requestSync(); } catch (e) { console.warn("Sync fallida:", e); }
    await checkAll();
    await checkGroups();
  } finally { running = false; }
}
```

- [ ] **Step 4: Verificar sintaxis**

```bash
cd /home/bra/workspaces/rss-anime/extension
cp background.js /tmp/bg-check.mjs && node --check /tmp/bg-check.mjs && rm /tmp/bg-check.mjs
```

Expected: sin salida (sintaxis válida).

- [ ] **Step 5: Verificación manual (con la extensión cargada en Chromium)**

No es parte de este task escribir el UI de grupos todavía (eso son los tasks 7-8), así que para probar `checkGroups()` ahora mismo hay que crear el grupo a mano desde la consola del service worker:

1. `chrome://extensions` → Series Tracker → "Service worker" (link para abrir su consola).
2. En esa consola: `const { addGroup, addStep } = await import(chrome.runtime.getURL("groups.js")); const g = await addGroup("Prueba"); await addStep(g.id, { provider: "TU_PROVIDER_ID", slug: "UN_SLUG_QUE_YA_TENGAS_GUARDADO", from: 1, to: 1 });` (usa un provider/slug que ya tengas en tu lista con episodio 1 disponible).
3. Desde el popup, botón "Comprobar todos".
4. Debe aparecer una notificación de Chrome y una entrada en "Nuevos episodios" con el prefijo del nombre del grupo.

- [ ] **Step 6: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add extension/background.js
git commit -m "$(cat <<'EOF'
feat: background.js notifica cuando un grupo necesita un episodio

checkGroups() usa currentStep() de groups.js para saber qué episodio
comprobar por grupo, independiente del chequeo normal por ítem. Id de
notificación con prefijo group- para no chocar con el chequeo normal
(pueden notificar el mismo episodio con contexto distinto sin pisarse).
Sin test automatizado: background.js no está cubierto por tests/run.sh
(igual que el resto de la extensión), verificado a mano.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Popup — toggle Todo/Grupos y vista de grupos

**Files:**
- Modify: `extension/popup.html:5-39`
- Modify: `extension/popup.js:1-6,104-127`

**Interfaces:**
- Consumes: `groups.js` (`live`, `currentStep`, `markStepSeen`, `removeGroup`), `engine.checkEpisode`, helpers ya existentes en `popup.js` (`el`, `btn`, `link`, `explain`, `prov`, `sync`)
- Produces: nada que otro task consuma directamente (task 8 añade a la misma vista, ver su sección "Interfaces")

- [ ] **Step 1: CSS del toggle en `popup.html`**

Añadir dentro del `<style>` (después de la línea `#cloud { font-size: .8rem; opacity: .7; }`):

```css
  .tabs { display: flex; gap: 4px; margin: 8px 0; }
  .tab { flex: 1; background: transparent; }
  .tab.active { background: #8882; font-weight: bold; }
```

- [ ] **Step 2: Reestructurar el HTML**

Reemplazar desde `<h2>Mi lista <button id="all">Comprobar todos</button></h2>` hasta `<p id="msg"></p>` (líneas 37-39):

```html
<div class="tabs">
  <button id="tabAll" class="tab active">Todo</button>
  <button id="tabGroups" class="tab">Grupos</button>
</div>

<div id="allView">
  <h2>Mi lista <button id="all">Comprobar todos</button></h2>
  <div id="list"></div>
</div>

<div id="groupsView" hidden>
  <div id="groups"></div>
  <button id="newGroup">＋ Nuevo grupo</button>
</div>

<p id="msg"></p>
```

- [ ] **Step 3: Import y toggle en `popup.js`**

Añadir el import (línea 1-6):

```js
import * as engine from "./engine.js";
import { get, set } from "./store.js";
import { live, add, mutate } from "./list.js";
import * as groups from "./groups.js";
import { getSession } from "./sync.js";
import { requestSync } from "./syncClient.js";
```

Añadir, después de la función `init()` (línea 48-56), el toggle de vista:

```js
$("#tabAll").onclick = () => setView("all");
$("#tabGroups").onclick = () => setView("groups");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#groupsView").hidden = v !== "groups";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabGroups").classList.toggle("active", v === "groups");
  if (v === "groups") renderGroups();
}
```

- [ ] **Step 4: `renderGroups()`**

Añadir después de `renderList()` (que termina en la línea 127 de `popup.js`):

```js
async function renderGroups() {
  const list = groups.live(await get("groups", []));
  const watchlist = live(await get("watchlist", []));
  $("#groups").replaceChildren(...list.map(g => {
    const cur = groups.currentStep(g, watchlist);
    const st = el("div", { className: "st" });
    const body = !cur
      ? el("div", { textContent: "✓ Terminado" })
      : el("div", {},
          el("div", { textContent:
            `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
            `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
          cur.item ? "" : el("div", { className: "st",
            textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
          el("div", { className: "actions" },
            btn("Siguiente", async () => {
              const p = prov(cur.step.provider);
              st.textContent = "Comprobando…";
              try {
                const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
              } catch (e) { st.textContent = "Error: " + explain(e); }
            }),
            btn("Visto", async () => { await groups.markStepSeen(g, watchlist); renderGroups(); sync(); })),
          st);
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("b", { textContent: g.name }),
        body,
        el("div", { className: "actions" },
          btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderGroups(); sync(); }))));
  }));
}
```

`btn` en `popup.js` no acepta una clase custom (a diferencia de la versión de `app.js`) — no hace falta para este task, los botones quedan con el estilo por defecto igual que en "Mi lista".

- [ ] **Step 5: Verificación manual**

1. `chrome://extensions` → recargar Series Tracker.
2. Abrir el popup: debe verse el toggle "Todo | Grupos", con "Todo" activo por defecto y el comportamiento exactamente igual que antes.
3. Clic en "Grupos": debe verse vacío (sin grupos todavía) más el botón "＋ Nuevo grupo" (sin funcionalidad hasta el Task 8, puede no hacer nada al clicar todavía — es esperado).
4. Si se creó un grupo de prueba en el Task 6 (consola del service worker), debe aparecer aquí con su tarjeta, botones Siguiente/Visto funcionando igual que en "Mi lista".

- [ ] **Step 6: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add extension/popup.html extension/popup.js
git commit -m "$(cat <<'EOF'
feat: toggle Todo/Grupos y vista de grupos en el popup

Nueva vista "Grupos" junto a la lista de siempre ("Todo", sin cambios).
Cada grupo muestra su paso actual (derivado de groups.currentStep) con
los mismos botones Siguiente/Visto que ya existían por ítem individual.
Verificado a mano en Chromium (sin test automatizado, igual que el resto
del popup).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Popup — constructor de grupo

**Files:**
- Modify: `extension/popup.html` (añade el formulario dentro de `#groupsView`)
- Modify: `extension/popup.js` (conecta `#newGroup` y el formulario)

**Interfaces:**
- Consumes: `groups.addGroup`, `groups.addStep` (Task 3), `renderGroups()` (Task 7)

- [ ] **Step 1: Añadir el formulario al HTML**

Dentro de `#groupsView` (el que dejó el Task 7), después de `<button id="newGroup">＋ Nuevo grupo</button>`:

```html
  <div id="groupForm" hidden>
    <input id="groupName" placeholder="Nombre del grupo" style="margin:6px 0">
    <div id="groupSteps"></div>
    <div class="row" style="margin-top:6px"><select id="stepItem"></select></div>
    <div class="row" style="margin-top:6px">
      <input id="stepFrom" type="number" min="1" value="1" placeholder="desde">
      <input id="stepTo" type="number" min="1" value="1" placeholder="hasta">
    </div>
    <input id="stepExclude" placeholder="excluir (ej: 25, 30)" style="margin-top:6px">
    <div class="row" style="margin-top:6px">
      <button id="addStepBtn">＋ Añadir paso</button>
      <button id="saveGroupBtn">Guardar</button>
      <button id="cancelGroupBtn">Cancelar</button>
    </div>
  </div>
```

- [ ] **Step 2: Lógica del formulario en `popup.js`**

Añadir al final del archivo, antes de `init();`:

```js
let draftSteps = [];

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#stepExclude").value = "";
  renderDraftSteps();
  const items = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...items.map(it =>
    el("option", { value: `${it.provider}|${it.slug}`, textContent: it.title })));
  $("#groupForm").hidden = false;
};

$("#cancelGroupBtn").onclick = () => { $("#groupForm").hidden = true; };

function renderDraftSteps() {
  $("#groupSteps").replaceChildren(...draftSteps.map((s, i) => el("div", { className: "row" },
    el("span", { textContent:
      `${i + 1}. ${s.slug} (${s.from}-${s.to}${s.exclude.length ? ", excl " + s.exclude.join(",") : ""})` }),
    btn("↑", () => { if (i > 0) { [draftSteps[i - 1], draftSteps[i]] = [draftSteps[i], draftSteps[i - 1]]; renderDraftSteps(); } }),
    btn("↓", () => { if (i < draftSteps.length - 1) { [draftSteps[i + 1], draftSteps[i]] = [draftSteps[i], draftSteps[i + 1]]; renderDraftSteps(); } }),
    btn("✕", () => { draftSteps.splice(i, 1); renderDraftSteps(); }))));
}

$("#addStepBtn").onclick = () => {
  const [provider, slug] = ($("#stepItem").value || "").split("|");
  if (!provider) return;
  const from = +$("#stepFrom").value || 1;
  const to = +$("#stepTo").value || 1;
  const exclude = $("#stepExclude").value.split(",").map(s => +s.trim()).filter(Boolean);
  draftSteps.push({ provider, slug, from, to, exclude });
  $("#stepExclude").value = "";
  renderDraftSteps();
};

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name || !draftSteps.length) { msg("Ponle nombre y al menos un paso"); return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  $("#groupForm").hidden = true;
  renderGroups();
  sync();
};
```

- [ ] **Step 3: Verificación manual**

1. Recargar la extensión, abrir popup → pestaña "Grupos" → "＋ Nuevo grupo".
2. Debe verse el formulario con el desplegable ya lleno con los ítems de "Mi lista".
3. Poner un nombre, elegir un ítem, dejar desde/hasta en 1/1, pulsar "＋ Añadir paso" → debe aparecer en la lista de pasos con ↑↓✕.
4. Añadir un segundo paso con otro ítem, probar ↑↓ para reordenar.
5. "Guardar" → el formulario se cierra y el grupo aparece en la lista de grupos con su primer paso como "actual".
6. Verificar que `bash tests/run.sh` sigue pasando (esta tarea no toca lógica compartida, pero confirma que no se rompió nada).

- [ ] **Step 4: Commit**

```bash
cd /home/bra/workspaces/rss-anime
git add extension/popup.html extension/popup.js
git commit -m "$(cat <<'EOF'
feat: constructor de grupo en el popup

Formulario "＋ Nuevo grupo": nombre + filas repetibles (ítem de tu lista
+ desde/hasta + excluir opcional) con reordenar (↑↓) y quitar (✕) antes
de guardar. Verificado a mano en Chromium.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: PWA — toggle Todo/Grupos y vista de grupos

**Files:**
- Modify: `web/index.html:44-45`
- Modify: `web/style.css` (clases `.tab`/`.tab.active`)
- Modify: `web/app.js:1-6,29-67`

**Interfaces:** igual que Task 7, pero para `app.js`/`index.html` (usa `requestSync()` local en vez de `sync()` de popup, y el `btn(text, fn, cls)` de `app.js` que sí acepta clase).

- [ ] **Step 1: CSS en `web/style.css`**

Añadir:

```css
.tabs { display: flex; gap: 6px; margin: 10px 0; }
.tabs button { flex: 1; }
.tabs button.active { background: color-mix(in srgb, currentColor 15%, transparent); font-weight: bold; }
```

- [ ] **Step 2: HTML en `web/index.html`**

Reemplazar la línea `<h2>Mi lista <button id="all" class="small">Comprobar todos</button></h2>` y la siguiente `<div id="list"></div>` (líneas 44-45):

```html
    <div class="tabs">
      <button id="tabAll" class="active">Todo</button>
      <button id="tabGroups">Grupos</button>
    </div>

    <div id="allView">
      <h2>Mi lista <button id="all" class="small">Comprobar todos</button></h2>
      <div id="list"></div>
    </div>

    <div id="groupsView" hidden>
      <div id="groups"></div>
      <button id="newGroup" class="small">＋ Nuevo grupo</button>
    </div>
```

- [ ] **Step 3: Import y toggle en `web/app.js`**

Añadir el import (línea 1-6):

```js
import "./proxy.js"; // registra globalThis.__seriesTrackerFetch antes de usar engine.js
import * as engine from "../extension/engine.js";
import { get, set } from "../extension/store.js";
import { live, add, mutate } from "../extension/list.js";
import * as groups from "../extension/groups.js";
import { signIn, signUp, signOut, getSession, syncNow } from "../extension/sync.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
```

Añadir el toggle, después de `fillProviders()` (línea 22-27):

```js
$("#tabAll").onclick = () => setView("all");
$("#tabGroups").onclick = () => setView("groups");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#groupsView").hidden = v !== "groups";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabGroups").classList.toggle("active", v === "groups");
  if (v === "groups") renderGroups();
}
```

- [ ] **Step 4: `renderGroups()`**

Añadir después de `renderList()` (que termina en la línea 67 de `app.js`):

```js
async function renderGroups() {
  const list = groups.live(await get("groups", []));
  const watchlist = live(await get("watchlist", []));
  $("#groups").replaceChildren(...list.map(g => {
    const cur = groups.currentStep(g, watchlist);
    const st = el("div", { className: "msg" });
    const body = !cur
      ? el("div", { textContent: "✓ Terminado" })
      : el("div", {},
          el("div", { textContent:
            `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
            `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
          cur.item ? "" : el("div", { className: "hint",
            textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
          el("div", { className: "actions" },
            btn("Siguiente", async () => {
              const p = prov(cur.step.provider);
              st.textContent = "Comprobando…";
              try {
                const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
              } catch (e) { st.textContent = "Error: " + explain(e); }
            }),
            btn("Visto", async () => { await groups.markStepSeen(g, watchlist); renderGroups(); requestSync(); })),
          st);
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("b", { textContent: g.name }),
        body,
        el("div", { className: "actions" },
          btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderGroups(); requestSync(); }))));
  }));
}
```

- [ ] **Step 5: Verificación en el navegador**

Levantar el servidor estático local y comprobar visualmente (mismo procedimiento que se usó para probar la PWA por primera vez esta sesión):

```bash
cd /home/bra/workspaces/rss-anime
python3 -m http.server 8899 &
```

Abrir `http://localhost:8899/web/index.html`, iniciar sesión, comprobar que aparece el toggle "Todo | Grupos" y que cambia de vista correctamente. Parar el servidor al terminar (`kill %1` o el PID que corresponda).

- [ ] **Step 6: Commit y desplegar**

```bash
cd /home/bra/workspaces/rss-anime
bash tests/run.sh
git add web/index.html web/style.css web/app.js
git commit -m "$(cat <<'EOF'
feat: toggle Todo/Grupos y vista de grupos en la PWA

Mismo comportamiento que el popup (Task 7), adaptado a app.js/index.html.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

(GitHub Pages tarda 1-2 minutos en servir la versión nueva — ver Task 10 para la verificación final en producción, que cubre ambas tareas de la PWA a la vez.)

---

## Task 10: PWA — constructor de grupo

**Files:**
- Modify: `web/index.html` (formulario dentro de `#groupsView`)
- Modify: `web/app.js` (conecta `#newGroup` y el formulario)

**Interfaces:** mismas que Task 8, adaptadas a `app.js`.

- [ ] **Step 1: Formulario en `web/index.html`**

Dentro de `#groupsView`, después de `<button id="newGroup" class="small">＋ Nuevo grupo</button>`:

```html
      <div id="groupForm" hidden>
        <input id="groupName" placeholder="Nombre del grupo">
        <div id="groupSteps"></div>
        <div class="row"><select id="stepItem"></select></div>
        <div class="row">
          <input id="stepFrom" type="number" min="1" value="1" placeholder="desde">
          <input id="stepTo" type="number" min="1" value="1" placeholder="hasta">
        </div>
        <input id="stepExclude" placeholder="excluir (ej: 25, 30)">
        <div class="row">
          <button id="addStepBtn" class="small">＋ Añadir paso</button>
          <button id="saveGroupBtn" class="small">Guardar</button>
          <button id="cancelGroupBtn" class="small">Cancelar</button>
        </div>
      </div>
```

- [ ] **Step 2: Lógica en `web/app.js`**

Añadir antes del bloque `(async function init() { ... })();` final:

```js
let draftSteps = [];

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#stepExclude").value = "";
  renderDraftSteps();
  const items = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...items.map(it =>
    el("option", { value: `${it.provider}|${it.slug}`, textContent: it.title })));
  $("#groupForm").hidden = false;
};

$("#cancelGroupBtn").onclick = () => { $("#groupForm").hidden = true; };

function renderDraftSteps() {
  $("#groupSteps").replaceChildren(...draftSteps.map((s, i) => el("div", { className: "row" },
    el("span", { textContent:
      `${i + 1}. ${s.slug} (${s.from}-${s.to}${s.exclude.length ? ", excl " + s.exclude.join(",") : ""})` }),
    btn("↑", () => { if (i > 0) { [draftSteps[i - 1], draftSteps[i]] = [draftSteps[i], draftSteps[i - 1]]; renderDraftSteps(); } }),
    btn("↓", () => { if (i < draftSteps.length - 1) { [draftSteps[i + 1], draftSteps[i]] = [draftSteps[i], draftSteps[i + 1]]; renderDraftSteps(); } }),
    btn("✕", () => { draftSteps.splice(i, 1); renderDraftSteps(); }))));
}

$("#addStepBtn").onclick = () => {
  const [provider, slug] = ($("#stepItem").value || "").split("|");
  if (!provider) return;
  const from = +$("#stepFrom").value || 1;
  const to = +$("#stepTo").value || 1;
  const exclude = $("#stepExclude").value.split(",").map(s => +s.trim()).filter(Boolean);
  draftSteps.push({ provider, slug, from, to, exclude });
  $("#stepExclude").value = "";
  renderDraftSteps();
};

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name || !draftSteps.length) { $("#searchMsg").textContent = "Ponle nombre y al menos un paso"; return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  $("#groupForm").hidden = true;
  renderGroups();
  requestSync();
};
```

- [ ] **Step 3: Verificación local, commit y push**

```bash
cd /home/bra/workspaces/rss-anime
python3 -m http.server 8899 &
```

Probar en `http://localhost:8899/web/index.html`: crear un grupo con 2 pasos, reordenar, guardar, comprobar que aparece con su paso actual. Parar el servidor.

```bash
bash tests/run.sh
git add web/index.html web/app.js
git commit -m "$(cat <<'EOF'
feat: constructor de grupo en la PWA

Mismo formulario que el popup (Task 8), adaptado a app.js/index.html.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
git push
```

- [ ] **Step 4: Verificación final en producción**

Esperar a que GitHub Pages sirva la versión nueva (comprobar con `curl -s https://dbranco.github.io/rss-anime/web/app.js | grep -c newGroup` hasta que devuelva más de 0), y entonces sí probar de verdad iniciando sesión con la cuenta real: crear un grupo, comprobar que sincroniza, y en otra pestaña/dispositivo (o recargando tras borrar `localStorage`) confirmar que el grupo aparece igual.

Esta verificación con sesión real necesita la contraseña del usuario — pedírsela para que la haga él, igual que se hizo con la búsqueda por primera vez.

---

## Resumen de archivos tocados

| Archivo | Tasks |
|---|---|
| `supabase/schema.sql`, `supabase/migrations/*` | 1 |
| `extension/groups.js` (nuevo) | 2, 3 |
| `tests/test-groups.mjs` (nuevo) | 2, 3 |
| `tests/run.sh` | 2 |
| `extension/sync.js` | 4 |
| `tests/test-sync-cron.mjs` | 4, 5 |
| `cron/generate-feed.mjs` | 5 |
| `tests/mock_site.py` | 5 |
| `extension/background.js` | 6 |
| `extension/popup.html`, `extension/popup.js` | 7, 8 |
| `web/index.html`, `web/style.css`, `web/app.js` | 9, 10 |
