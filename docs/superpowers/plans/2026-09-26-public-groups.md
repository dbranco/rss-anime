# Grupos públicos + lista unificada Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** un grupo puede marcarse público; otras cuentas lo descubren en una pestaña
"Explorar", se suscriben (sin copiarlo — leen el original en vivo) y lo valoran con
estrellas 1-5. Al suscribirte se repara sola tu lista para poder marcar progreso. "Mi
lista" y "Grupos" (propios + suscritos) se fusionan en una vista filtrable y paginada
de 10 en 10. El cron también revisa los grupos a los que estás suscrito para tu feed.

**Architecture:** dos tablas nuevas en Supabase (`group_subscriptions`,
`group_ratings`) más una columna `public` en `groups`, con RLS que abre lectura de
grupos públicos y valoraciones a cualquier autenticado. `extension/groups.js` gana
`subscribe`/`unsubscribe`/`setPublic` y absorbe `missingSteps`/`repairGroup` (hoy
duplicados en `popup.js` y `app.js`). `extension/sync.js` gana la sincronización de
suscripciones, una caché local de solo lectura de los grupos suscritos, búsqueda de
grupos públicos y el upsert de valoraciones. El cron resuelve episodios nuevos tanto
de tus grupos como de los que sigues, siempre hacia tu propio feed. Extensión y PWA
sustituyen las pestañas "Todo"/"Grupos" por una vista "Mi lista" unificada + una
pestaña "Explorar" nueva.

**Tech Stack:** igual que el resto del proyecto — JS vanilla + `fetch`, Supabase
(Postgres + RLS + PostgREST), Python (`http.server`) para los mocks de test, Node para
los tests de integración.

**Spec:** `docs/superpowers/specs/2026-09-26-public-groups-design.md`

## Global Constraints

- Toda política RLS nueva usa `to authenticated` (nunca abierta a `anon`), igual que el
  resto del esquema.
- Suscribirse **no copia** el grupo: `subscribed_groups` es una caché local de solo
  lectura, refrescada entera en cada sync, nunca empujada a Supabase.
- El progreso sigue derivándose exclusivamente de `watchlist[].last` — un grupo
  suscrito no tiene contador propio, igual que uno propio.
- Las acciones de editar/borrar un grupo siguen siendo solo del dueño; un grupo
  suscrito solo ofrece "Darse de baja" y las acciones de progreso (Siguiente, Visto,
  Reparar).
- Paginación: 10 elementos por página en "Mi lista" y en "Explorar", mismo patrón que
  ya usa `ITIN_PAGE_SIZE`/`itinPage` para el itinerario de un grupo (troceo del array
  ya calculado, sin paginar en SQL).
- Verificación de cada tarea con test automático cuando exista:
  `bash tests/run.sh` desde la raíz del repo. Las tareas de UI (sin test automático en
  este proyecto) se verifican con `node --check` sobre los archivos tocados.

---

### Task 1: Esquema de Supabase — `groups.public`, `group_subscriptions`, `group_ratings`

**Files:**
- Create: `supabase/migrations/20260926140000_public_groups.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produce las columnas/tablas que las Tasks 2-4 consumen vía PostgREST:
  `groups.public`, `/rest/v1/group_subscriptions`, `/rest/v1/group_ratings`.

- [ ] **Step 1: Crear el archivo de migración**

Crea `supabase/migrations/20260926140000_public_groups.sql` con este contenido exacto:

```sql
-- Grupos públicos, suscripciones y valoraciones. Ver
-- docs/superpowers/specs/2026-09-26-public-groups-design.md
alter table public.groups add column if not exists public boolean not null default false;

-- A quién sigue quién. No copia el grupo: guarda una referencia a (owner_id, group_id).
create table if not exists public.group_subscriptions (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null,
  group_id   text not null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, owner_id, group_id),
  foreign key (owner_id, group_id) references public.groups(user_id, id) on delete cascade
);

-- Una fila por persona y grupo. La media se calcula en el cliente sobre las filas crudas.
create table if not exists public.group_ratings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null,
  group_id   text not null,
  stars      int  not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, owner_id, group_id),
  foreign key (owner_id, group_id) references public.groups(user_id, id) on delete cascade
);

alter table public.group_subscriptions enable row level security;
alter table public.group_ratings       enable row level security;

drop policy if exists "read public groups" on public.groups;
create policy "read public groups" on public.groups
  for select to authenticated using (public = true);

drop policy if exists "own subscriptions" on public.group_subscriptions;
create policy "own subscriptions" on public.group_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own ratings write" on public.group_ratings;
create policy "own ratings write" on public.group_ratings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "read all ratings" on public.group_ratings;
create policy "read all ratings" on public.group_ratings
  for select to authenticated using (true);

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Añadir el mismo bloque a `supabase/schema.sql`**

Abre `supabase/schema.sql`. Busca el final del archivo (el bloque de `app_config`
añadido por el plan anterior, terminado en el `notify` final):

```sql
drop policy if exists "read own admin flag" on public.admins;
create policy "read own admin flag" on public.admins
  for select to authenticated using (auth.uid() = user_id);

notify pgrst, 'reload schema';
```

Sustitúyelo por (el mismo bloque de `admins`, seguido del bloque nuevo, seguido del
`notify` final — solo debe quedar un `notify pgrst, 'reload schema';` al final del
archivo):

```sql
drop policy if exists "read own admin flag" on public.admins;
create policy "read own admin flag" on public.admins
  for select to authenticated using (auth.uid() = user_id);

-- Grupos públicos, suscripciones y valoraciones. Ver
-- docs/superpowers/specs/2026-09-26-public-groups-design.md
alter table public.groups add column if not exists public boolean not null default false;

create table if not exists public.group_subscriptions (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null,
  group_id   text not null,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, owner_id, group_id),
  foreign key (owner_id, group_id) references public.groups(user_id, id) on delete cascade
);

create table if not exists public.group_ratings (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  owner_id   uuid not null,
  group_id   text not null,
  stars      int  not null check (stars between 1 and 5),
  updated_at timestamptz not null default now(),
  primary key (user_id, owner_id, group_id),
  foreign key (owner_id, group_id) references public.groups(user_id, id) on delete cascade
);

alter table public.group_subscriptions enable row level security;
alter table public.group_ratings       enable row level security;

drop policy if exists "read public groups" on public.groups;
create policy "read public groups" on public.groups
  for select to authenticated using (public = true);

drop policy if exists "own subscriptions" on public.group_subscriptions;
create policy "own subscriptions" on public.group_subscriptions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own ratings write" on public.group_ratings;
create policy "own ratings write" on public.group_ratings
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "read all ratings" on public.group_ratings;
create policy "read all ratings" on public.group_ratings
  for select to authenticated using (true);

notify pgrst, 'reload schema';
```

- [ ] **Step 3: Verificación**

No hay test automático para SQL de Supabase (mismo criterio que los planes
anteriores). Revisa que ambos archivos tengan el bloque idéntico y que
`schema.sql` termine con un único `notify pgrst, 'reload schema';`.

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql supabase/migrations/20260926140000_public_groups.sql
git commit -m "feat: esquema de grupos públicos, suscripciones y valoraciones"
```

---

### Task 2: `extension/groups.js` — compartir reparación + suscripción/visibilidad

**Files:**
- Modify: `extension/groups.js`
- Modify: `extension/popup.js`
- Modify: `web/app.js`
- Modify: `tests/test-groups.mjs`

**Interfaces:**
- Produce: `export function missingSteps(g, watchlist)`, `export async function
  repairGroup(g, watchlist)`, `export const setPublic`, `export async function
  subscribe(group, watchlist)`, `export const unsubscribe`, `export const
  liveSubscriptions`. Tasks 4-5 (UI) consumen todas estas.
- Consume: `add` de `./list.js` (nuevo import en `groups.js`).

- [ ] **Step 1: `groups.js` — importar `add` y añadir las funciones nuevas**

Busca:

```js
import { get, set } from "./store.js";
import { mutate } from "./list.js";
```

Sustitúyelo por:

```js
import { get, set } from "./store.js";
import { mutate, add } from "./list.js";
```

Al final del archivo (después de la función `itinerary`), añade:

```js

export const setPublic = (id, isPublic) => mutateGroup(id, g => { g.public = !!isPublic; });

// Convierte un slug en un título legible (rezero-kara-... -> "Rezero Kara ...") para el ítem
// que crea missingSteps/repairGroup — no es tan bonito como el título real, pero sirve para
// identificarlo y, sobre todo, ya existe en la lista y el grupo puede empezar a trackear su
// progreso. Compartido por el botón "Reparar" (grupos propios) y subscribe() (grupos ajenos).
const prettify = slug => slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

// Pasos cuyo provider+slug no tiene todavía una entrada en watchlist (no se puede marcar
// progreso sin ella).
export function missingSteps(g, watchlist) {
  const seen = new Set();
  return (g.steps || []).filter(s => {
    const key = `${s.provider}|${s.slug}`;
    if (seen.has(key)) return false; // no repetir el mismo ítem si aparece en varios pasos
    seen.add(key);
    return !watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  });
}

export async function repairGroup(g, watchlist) {
  for (const s of missingSteps(g, watchlist)) {
    await add({ provider: s.provider, slug: s.slug, title: prettify(s.slug), link: null, image: null });
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

// Se suscribe y, si hacen falta, crea ya las entradas de watchlist para poder marcar
// progreso desde el primer momento (lo que "Reparar" hace a mano para tus propios grupos).
export async function subscribe(group, watchlist) {
  await mutateSubscription(group.user_id, group.id, s => { s.deleted = false; });
  await repairGroup(group, watchlist);
}

export const unsubscribe = (ownerId, groupId) => mutateSubscription(ownerId, groupId, s => { s.deleted = true; });
```

- [ ] **Step 2: `extension/popup.js` — usar las funciones compartidas, quitar las locales**

Busca (el bloque duplicado, justo antes de `titleColors`):

```js
// Convierte un slug en un título legible (rezero-kara-... -> "Rezero Kara ...") para el ítem
// que crea "Reparar" — no es tan bonito como el título real, pero sirve para identificarlo
// y, sobre todo, ya existe en la lista y el grupo puede empezar a trackear su progreso.
const prettify = slug => slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function missingSteps(g, watchlist) {
  const seen = new Set();
  return g.steps.filter(s => {
    const key = `${s.provider}|${s.slug}`;
    if (seen.has(key)) return false; // no repetir el mismo ítem si aparece en varios pasos
    seen.add(key);
    return !watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  });
}

async function repairGroup(g, watchlist) {
  for (const s of missingSteps(g, watchlist)) {
    await add({ provider: s.provider, slug: s.slug, title: prettify(s.slug), link: null, image: null });
  }
}

function titleColors(steps) {
```

Sustitúyelo por (se eliminan las tres funciones locales; a partir de ahora se llaman
como `groups.missingSteps(...)`/`groups.repairGroup(...)`, ya importado como `import *
as groups from "./groups.js";` al principio del archivo):

```js
function titleColors(steps) {
```

Busca las dos llamadas que quedaban a las versiones locales:

```js
        renderAvatars(g, cur, watchlist),
        body,
        renderItinerary(g, cur, watchlist, () => { renderGroups(); sync(); }),
```

No cambia (queda igual, es solo referencia de contexto). Busca en su lugar estas dos
líneas exactas dentro de `renderGroups()`:

```js
    const missing = missingSteps(g, watchlist);
```

Sustitúyela por:

```js
    const missing = groups.missingSteps(g, watchlist);
```

Y busca:

```js
              btn("Reparar", async () => { await repairGroup(g, watchlist); renderGroups(); sync(); }))
```

Sustitúyela por:

```js
              btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderGroups(); sync(); }))
```

- [ ] **Step 3: `web/app.js` — el mismo cambio**

Busca (idéntico bloque, en `web/app.js`):

```js
// Convierte un slug en un título legible (rezero-kara-... -> "Rezero Kara ...") para el ítem
// que crea "Reparar" — no es tan bonito como el título real, pero sirve para identificarlo
// y, sobre todo, ya existe en la lista y el grupo puede empezar a trackear su progreso.
const prettify = slug => slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());

function missingSteps(g, watchlist) {
  const seen = new Set();
  return g.steps.filter(s => {
    const key = `${s.provider}|${s.slug}`;
    if (seen.has(key)) return false; // no repetir el mismo ítem si aparece en varios pasos
    seen.add(key);
    return !watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  });
}

async function repairGroup(g, watchlist) {
  for (const s of missingSteps(g, watchlist)) {
    await add({ provider: s.provider, slug: s.slug, title: prettify(s.slug), link: null, image: null });
  }
}

function titleColors(steps) {
```

Sustitúyelo por:

```js
function titleColors(steps) {
```

Busca:

```js
    const missing = missingSteps(g, watchlist);
```

Sustitúyela por:

```js
    const missing = groups.missingSteps(g, watchlist);
```

Busca:

```js
              btn("Reparar", async () => { await repairGroup(g, watchlist); renderGroups(); requestSync(); }))
```

Sustitúyela por:

```js
              btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderGroups(); requestSync(); }))
```

- [ ] **Step 4: `tests/test-groups.mjs` — tests de las funciones nuevas**

Busca el final del archivo:

```js
it2 = await unmarkFrom({ provider: "p", slug: "serie" }, 10); // "hacia delante": no debe subir el last
assert.equal(it2.last, 4);

console.log("unmarkFrom OK");
console.log("TODO OK");
```

Sustitúyelo por:

```js
it2 = await unmarkFrom({ provider: "p", slug: "serie" }, 10); // "hacia delante": no debe subir el last
assert.equal(it2.last, 4);

console.log("unmarkFrom OK");

// --- missingSteps / repairGroup / setPublic / subscribe / unsubscribe ---
const { missingSteps, repairGroup, setPublic, subscribe, unsubscribe, liveSubscriptions } =
  await import("../extension/groups.js");

const g2 = await addGroup("Grupo con huecos");
await addStep(g2.id, { provider: "p", slug: "serie" }); // ya está en watchlist (se añadió arriba)
await addStep(g2.id, { provider: "p", slug: "nueva", from: 1, to: 3 }); // no está

let wl = live(await get("watchlist", []));
const miss = missingSteps(g2, wl);
assert.equal(miss.length, 1);
assert.equal(miss[0].slug, "nueva");

await repairGroup(g2, wl);
wl = live(await get("watchlist", []));
assert.ok(wl.find(w => w.provider === "p" && w.slug === "nueva"));
assert.equal(missingSteps(g2, wl).length, 0, "tras reparar ya no faltan pasos");
console.log("missingSteps/repairGroup OK");

await setPublic(g2.id, true);
assert.equal((await get("groups", [])).find(x => x.id === g2.id).public, true);
console.log("setPublic OK");

// subscribe: repara sola la lista del suscriptor y deja la suscripción activa
const otherOwnerGroup = { user_id: "owner-uuid", id: "grupo-ajeno", name: "Ajeno",
  steps: [{ provider: "p", slug: "ajena", from: 1, to: 1, exclude: [] }] };
await subscribe(otherOwnerGroup, live(await get("watchlist", [])));
assert.ok(live(await get("watchlist", [])).find(w => w.provider === "p" && w.slug === "ajena"));
let subs = liveSubscriptions(await get("group_subscriptions", []));
assert.equal(subs.length, 1);
assert.equal(subs[0].owner_id, "owner-uuid");

await unsubscribe("owner-uuid", "grupo-ajeno");
subs = liveSubscriptions(await get("group_subscriptions", []));
assert.equal(subs.length, 0, "borrado lógico: ya no aparece en liveSubscriptions");
console.log("subscribe/unsubscribe OK");

console.log("TODO OK");
```

- [ ] **Step 5: Verificación**

```bash
bash tests/run.sh
```

Expected: todo pasa, incluyendo las líneas nuevas
`missingSteps/repairGroup OK`, `setPublic OK`, `subscribe/unsubscribe OK`.

- [ ] **Step 6: Commit**

```bash
git add extension/groups.js extension/popup.js web/app.js tests/test-groups.mjs
git commit -m "feat: groups.js comparte reparación y añade suscripción/visibilidad"
```

---

### Task 3: Capa de datos — sync, cron y mock de tests

**Files:**
- Modify: `extension/sync.js`
- Modify: `cron/generate-feed.mjs`
- Modify: `tests/mock_supabase.py`
- Modify: `tests/test-sync-cron.mjs`

**Interfaces:**
- Produce en `extension/sync.js`: `export async function searchPublicGroups(query)`,
  `export async function rateGroup(ownerId, groupId, stars)`. Claves locales nuevas:
  `group_subscriptions` (sincronizada, igual que `groups`), `subscribed_groups`
  (caché de solo lectura). `syncGroups` incluye ahora `public` en el payload.

- [ ] **Step 1: `tests/mock_supabase.py` — lectura abierta de grupos públicos y valoraciones**

Busca:

```python
            rows = list(TABLES.get(m[1], []))
            if kind == "user":
                if m[1] in ("app_config", "group_ratings"):
                    pass  # esto no existe todavía, ver más abajo
```

Si esa línea no existe (el archivo actual termina la condición en `app_config` según
el plan anterior), busca en su lugar el bloque real actual:

```python
            rows = list(TABLES.get(m[1], []))
            if kind == "user" and m[1] != "app_config":  # simula RLS (app_config: lectura abierta)
                rows = [r for r in rows if r.get("user_id") == uid]
```

Sustitúyelo por:

```python
            rows = list(TABLES.get(m[1], []))
            if kind == "user":
                if m[1] in ("app_config", "group_ratings"):
                    pass  # lectura abierta a cualquier autenticado
                elif m[1] == "groups":
                    rows = [r for r in rows if r.get("user_id") == uid or r.get("public")]
                else:
                    rows = [r for r in rows if r.get("user_id") == uid]
```

`group_subscriptions` no necesita caso especial: tiene `user_id` propio y el `else`
genérico (filtrar por dueño) ya es el comportamiento correcto para ella.

- [ ] **Step 2: `extension/sync.js` — `public` en `syncGroups`, suscripciones, caché de leídos, búsqueda y valoración**

Busca la función `syncGroups` completa:

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

Sustitúyela por (añade `public` al mapeo remoto y al cuerpo del push):

```js
async function syncGroups(uid) {
  const remote = (await rest(`groups?select=*&user_id=eq.${uid}`)).map(r => ({
    id: r.id, name: r.name, steps: r.steps, public: !!r.public, deleted: r.deleted, updated_at: r.updated_at
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
        user_id: uid, id: x.id, name: x.name, steps: x.steps, public: !!x.public,
        deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("groups", [])) === snapshot) await set("groups", [...merged.values()]);
}

async function syncSubscriptions(uid) {
  const remote = (await rest(`group_subscriptions?select=*&user_id=eq.${uid}`)).map(r => ({
    owner_id: r.owner_id, group_id: r.group_id, deleted: r.deleted, updated_at: r.updated_at
  }));
  const local = await get("group_subscriptions", []);
  const snapshot = JSON.stringify(local);
  const key = x => `${x.owner_id}|${x.group_id}`;
  const merged = new Map(remote.map(x => [key(x), x]));
  const toPush = [];
  for (const l of local) {
    if (!l.updated_at) l.updated_at = now();
    const r = merged.get(key(l));
    if (!r || ts(l.updated_at) > ts(r.updated_at)) { merged.set(key(l), l); toPush.push(l); }
  }
  if (toPush.length) {
    await rest("group_subscriptions?on_conflict=user_id,owner_id,group_id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: toPush.map(x => ({
        user_id: uid, owner_id: x.owner_id, group_id: x.group_id,
        deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("group_subscriptions", [])) === snapshot) await set("group_subscriptions", [...merged.values()]);
}

// Trae, en modo solo lectura, el grupo original de cada suscripción viva. No se sube nunca
// (la propiedad y edición son siempre del dueño); se sobrescribe entera en cada sync. Si el
// grupo se volvió privado o se borró, simplemente deja de traerlo (la RLS ya no lo permite).
async function refreshSubscribedGroups() {
  const subs = (await get("group_subscriptions", [])).filter(s => !s.deleted);
  const out = [];
  for (const s of subs) {
    const [g] = await rest(`groups?select=*&user_id=eq.${s.owner_id}&id=eq.${s.group_id}`);
    if (g) out.push(g);
  }
  await set("subscribed_groups", out);
}

// Trae TODOS los grupos públicos que matcheen el nombre (sin paginar en SQL — a esta escala
// no hace falta) y les calcula la media de estrellas en el cliente para poder ordenar por
// ella; la paginación de 10 en 10 la hace la UI troceando este array ya ordenado.
export async function searchPublicGroups(query) {
  const q = encodeURIComponent(`*${query}*`);
  const found = await rest(`groups?select=*&public=eq.true&name=ilike.${q}`);
  if (!found.length) return [];
  const owners = [...new Set(found.map(g => g.user_id))].join(",");
  const ids = [...new Set(found.map(g => g.id))].join(",");
  const ratings = await rest(`group_ratings?select=owner_id,group_id,stars&owner_id=in.(${owners})&group_id=in.(${ids})`);
  const avg = new Map();
  for (const r of ratings) {
    const k = `${r.owner_id}|${r.group_id}`;
    const cur = avg.get(k) || { sum: 0, n: 0 };
    cur.sum += r.stars; cur.n += 1;
    avg.set(k, cur);
  }
  return found
    .map(g => {
      const a = avg.get(`${g.user_id}|${g.id}`);
      return { ...g, rating_avg: a ? a.sum / a.n : null, rating_count: a?.n || 0 };
    })
    .sort((a, b) => (b.rating_avg || 0) - (a.rating_avg || 0));
}

export async function rateGroup(ownerId, groupId, stars) {
  const s = await session();
  await rest("group_ratings?on_conflict=user_id,owner_id,group_id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ user_id: s.user.id, owner_id: ownerId, group_id: groupId, stars, updated_at: now() }]
  });
}
```

Busca `export async function syncNow()`:

```js
export async function syncNow() {
  const s = await session();
  await syncFeedToken(s.user.id);
  await syncAppConfig(s.user.id);
  await syncWatchlist(s.user.id);
  await syncGroups(s.user.id);
  await set("last_sync", now());
}
```

Sustitúyela por:

```js
export async function syncNow() {
  const s = await session();
  await syncFeedToken(s.user.id);
  await syncAppConfig(s.user.id);
  await syncWatchlist(s.user.id);
  await syncGroups(s.user.id);
  await syncSubscriptions(s.user.id);
  await refreshSubscribedGroups();
  await set("last_sync", now());
}
```

- [ ] **Step 3: `cron/generate-feed.mjs` — episodios nuevos también de los grupos suscritos**

Busca:

```js
const settings = await rest("user_settings?select=user_id,feed_token");
const watch = await rest("watchlist?select=*&deleted=eq.false");
const found = await rest("episodes_found?select=*&order=found_at.desc");
const groups = await rest("groups?select=*&deleted=eq.false");
```

Sustitúyelo por (se añade la lectura de suscripciones; `groups` ya trae TODOS los
grupos de TODOS los usuarios porque el cron usa la service key, así que no hace falta
una consulta aparte para resolver el grupo original de cada suscripción):

```js
const settings = await rest("user_settings?select=user_id,feed_token");
const watch = await rest("watchlist?select=*&deleted=eq.false");
const found = await rest("episodes_found?select=*&order=found_at.desc");
const groups = await rest("groups?select=*&deleted=eq.false");
const subs = await rest("group_subscriptions?select=*&deleted=eq.false");
```

Busca, justo antes de `const [appConfig] = await rest(...)`, para añadir la función
compartida entre grupos propios y suscritos (se define aquí, antes del bucle principal,
junto a las demás funciones auxiliares del archivo):

```js
async function publish(token, xml) {
```

Deja `publish` intacta y, justo DESPUÉS de su cierre (`}` que la termina, antes de la
línea `const [appConfig] = await rest(...)`), añade esta función nueva:

```js
// Comparte la lógica de "¿hay episodio nuevo en el paso actual de este grupo?" entre los
// grupos propios de un usuario y los que sigue por suscripción — el episodio encontrado
// siempre va al feed del usuario que lo está revisando (`uid`), nunca al del dueño del grupo.
async function checkGroupEpisode(g, mineForGroups, uid, known, fresh) {
  const cur = currentStep(g, mineForGroups);
  if (!cur?.next) return;
  if (!cur.item) return; // paso colgando: el ítem ya no está en la lista de este usuario
  const p = providers.find(x => x.id === cur.step.provider);
  if (!p) return;
  const already = known.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next)
    || fresh.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next);
  if (already) return;
  let r;
  try { r = await engine.checkEpisode(p, cur.step.slug, cur.next); }
  catch (e) { console.warn(`Fallo en grupo ${g.name}: ${e.message}`); return; }
  if (!r.exists) return;
  const title = cur.item?.title || cur.step.slug;
  fresh.push({ user_id: uid, provider_id: cur.step.provider, slug: cur.step.slug, episode: cur.next,
               title: `${g.name}: ${title} — episodio ${cur.next}`, link: r.url });
  console.log(`Nuevo (grupo ${g.name}): ${title} ep ${cur.next}`);
}
```

Nota: esta función usa `providers`, que hoy se declara MÁS ABAJO
(`const [appConfig] = await rest(...); const providers = appConfig?.providers || [];`).
Como `checkGroupEpisode` no se LLAMA hasta dentro del bucle principal (que ya se
ejecuta después de esa declaración), y `const` con función declarada en el mismo
scope de módulo es accesible por cierre en el momento de la llamada, no hace falta
reordenar nada — Node ejecuta el módulo de arriba a abajo y la función solo se
invoca más tarde.

Busca el bloque del bucle de grupos dentro de `for (const st of settings) { try {`:

```js
    const mineForGroups = mine.map(w => ({ provider: w.provider_id, slug: w.slug, last: w.last, title: w.title }));
    const myGroups = groups.filter(g => g.user_id === st.user_id);
    for (const g of myGroups) {
      const cur = currentStep(g, mineForGroups);
      if (!cur?.next) continue;
      if (!cur.item) continue; // paso colgando: el ítem ya no está en la lista
      const p = providers.find(x => x.id === cur.step.provider);
      if (!p) continue;
      // Dedupe contra pasadas anteriores (`known`) y contra lo que el bucle por ítem ya ha
      // encolado en esta misma pasada (`fresh`): comparten clave primaria y guid del RSS.
      const already = known.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next)
        || fresh.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next);
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

Sustitúyelo por:

```js
    const mineForGroups = mine.map(w => ({ provider: w.provider_id, slug: w.slug, last: w.last, title: w.title }));
    const myGroups = groups.filter(g => g.user_id === st.user_id);
    const mySubs = subs.filter(s => s.user_id === st.user_id);
    const subscribedGroups = mySubs
      .map(s => groups.find(g => g.user_id === s.owner_id && g.id === s.group_id))
      .filter(Boolean);
    for (const g of [...myGroups, ...subscribedGroups]) {
      await checkGroupEpisode(g, mineForGroups, st.user_id, known, fresh);
    }
```

- [ ] **Step 4: `tests/test-sync-cron.mjs` — grupo público, suscripción, reparación automática y cron**

Busca la línea de import de `sync.js` (ya trae `saveAppProviders` del plan anterior):

```js
const { signUp, signIn, syncNow, saveAppProviders } = await import("../extension/sync.js");
```

Sustitúyela por:

```js
const { signUp, signIn, syncNow, saveAppProviders, searchPublicGroups, rateGroup } = await import("../extension/sync.js");
```

Busca el final del archivo (el bloque de la máquina C del plan anterior, hasta el
`TODO OK` final):

```js
// Máquina C: cuenta distinta, NO admin — recibe los providers en solo lectura y no puede escribir
const C = machine();
use(C);
await set("supabase", { url: SB, anonKey: "anon" });
assert.equal((await signUp("otra@test.dev", "secreto123")).confirmed, true);
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(await get("is_admin", false), false);
await assert.rejects(() => saveAppProviders([{ id: "hack" }]), /solo admin/);
console.log("C (no admin) recibió providers en solo lectura y no pudo escribir");

// C también puede USAR los providers compartidos aunque no pueda escribirlos: añade una
// serie a su propia lista y comprueba que el cron (que ahora lee app_config una sola vez,
// no por usuario) también le resuelve episodios nuevos a ella.
await add({ provider: "mock", slug: "dandadan", title: "Dandadan", link: "http://127.0.0.1:8001/blabla/dandadan", image: null });
await syncNow();
run();
const cFeedUrl = `${SB}/storage/v1/object/public/feeds/${await get("feed_token")}.xml`;
let cXml = await (await fetch(cFeedUrl)).text();
assert.match(cXml, /Dandadan — episodio 1/);
assert.equal(count(cXml), 3, "1 propio de C (dandadan) + 2 heredados de app_config abierto no aplica aquí, son independientes por usuario");
console.log("C (no admin) también recibe episodios nuevos vía los providers compartidos");

console.log("TODO OK");
```

Sustitúyelo por (se añade el bloque de grupo público/suscripción/valoración justo
antes del `TODO OK` final):

```js
// Máquina C: cuenta distinta, NO admin — recibe los providers en solo lectura y no puede escribir
const C = machine();
use(C);
await set("supabase", { url: SB, anonKey: "anon" });
assert.equal((await signUp("otra@test.dev", "secreto123")).confirmed, true);
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(await get("is_admin", false), false);
await assert.rejects(() => saveAppProviders([{ id: "hack" }]), /solo admin/);
console.log("C (no admin) recibió providers en solo lectura y no pudo escribir");

// C también puede USAR los providers compartidos aunque no pueda escribirlos: añade una
// serie a su propia lista y comprueba que el cron (que ahora lee app_config una sola vez,
// no por usuario) también le resuelve episodios nuevos a ella.
await add({ provider: "mock", slug: "dandadan", title: "Dandadan", link: "http://127.0.0.1:8001/blabla/dandadan", image: null });
await syncNow();
run();
const cFeedUrl = `${SB}/storage/v1/object/public/feeds/${await get("feed_token")}.xml`;
let cXml = await (await fetch(cFeedUrl)).text();
assert.match(cXml, /Dandadan — episodio 1/);
console.log("C (no admin) también recibe episodios nuevos vía los providers compartidos");

// A hace público uno de sus grupos; C lo encuentra en Explorar, se suscribe (se repara
// sola su lista), marca progreso propio SIN tocar el de A, lo valora, y el cron le
// resuelve episodios nuevos de ese grupo suscrito en SU PROPIO feed.
use(A);
const { setPublic } = await import("../extension/groups.js");
await setPublic(gLong.id, true); // "Maratón larga" (longrun, del bloque anterior)
await syncNow();

use(C);
await syncNow();
const found2 = await searchPublicGroups("Maratón");
assert.equal(found2.length, 1);
assert.equal(found2[0].name, "Maratón larga");

const { subscribe, currentStep: curStepC } = await import("../extension/groups.js");
await subscribe(found2[0], live(await get("watchlist", [])));
assert.ok(live(await get("watchlist", [])).find(w => w.provider === "mock" && w.slug === "longrun"),
  "suscribirse repara sola la lista de C para el paso de 'longrun'");
await syncNow();

const cSub = (await get("subscribed_groups", [])).find(g => g.name === "Maratón larga");
assert.ok(cSub, "C ve el grupo suscrito en su caché de solo lectura");
const curC = curStepC(cSub, live(await get("watchlist", [])));
assert.equal(curC.next, 20); // mismo paso "longrun 20-20" que definió A
await groups.markUpTo(curC.step, 20);
assert.equal(live(await get("watchlist", [])).find(w => w.slug === "longrun").last, 20,
  "el progreso de C en 'longrun' es suyo, independiente del de A");
await syncNow();

use(A);
await syncNow();
assert.equal(live(await get("watchlist", [])).find(w => w.slug === "longrun")?.last ?? 0, 20,
  "A ya tenía longrun visto hasta 20 por el bloque anterior del test — no lo pisa C");

use(C);
await rateGroup(found2[0].user_id, found2[0].id, 5);
const rated = await searchPublicGroups("Maratón");
assert.equal(rated[0].rating_avg, 5);
assert.equal(rated[0].rating_count, 1);
console.log("grupo público: descubrir, suscribirse (con auto-reparación), progreso propio y valorar OK");

console.log("TODO OK");
```

Nota: este bloque reutiliza `gLong` (la variable del grupo "Maratón larga" creado más
arriba en el archivo, en el bloque `// Grupo: pide el episodio 20...`) y el `groups`
importado al principio del archivo (`const { addGroup, addStep, live: liveGroups } =
await import("../extension/groups.js");` — asegúrate de que `groups.markUpTo` esté
accesible; si el archivo solo desestructuró funciones sueltas de `groups.js` en vez de
importar el módulo entero, añade `markUpTo` a esa desestructuración en vez de usar
`groups.markUpTo`).

- [ ] **Step 5: Ejecutar la suite completa**

```bash
bash tests/run.sh
```

Expected: todo pasa, incluyendo la línea final nueva sobre grupo público/suscripción.

- [ ] **Step 6: Commit**

```bash
git add extension/sync.js cron/generate-feed.mjs tests/mock_supabase.py tests/test-sync-cron.mjs
git commit -m "feat: suscripciones, grupos públicos y valoraciones en sync y cron"
```

---

### Task 4: Extensión — lista unificada + pestaña "Explorar"

**Files:**
- Modify: `extension/popup.html`
- Modify: `extension/popup.js`

**Interfaces:**
- Consume: `groups.subscribe`, `groups.unsubscribe`, `groups.setPublic`,
  `groups.missingSteps`, `groups.repairGroup` (Task 2); `searchPublicGroups`,
  `rateGroup` (Task 3); clave local `subscribed_groups` (Task 3).

- [ ] **Step 1: `popup.html` — pestañas, filtro, paginador y vista Explorar**

Busca:

```html
<h2>Buscar</h2>
<div id="langFilter"></div>
<div class="row" style="margin-top:6px"><input id="q" placeholder="Re:Zero"><button id="go">Buscar</button></div>
<div id="results"></div>

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
  <div id="groupForm" hidden>
    <input id="groupName" placeholder="Nombre del grupo" style="margin:6px 0">
```

Sustitúyelo por:

```html
<div class="tabs">
  <button id="tabAll" class="tab active">Mi lista</button>
  <button id="tabExplore" class="tab">Explorar</button>
</div>

<div id="allView">
  <h2>Buscar</h2>
  <div id="langFilter"></div>
  <div class="row" style="margin-top:6px"><input id="q" placeholder="Re:Zero"><button id="go">Buscar</button></div>
  <div id="results"></div>

  <h2>Mi lista <button id="all">Comprobar todos</button></h2>
  <div class="row" id="listFilter">
    <label><input type="radio" name="listf" value="media"> Media</label>
    <label><input type="radio" name="listf" value="groups"> Listas</label>
    <label><input type="radio" name="listf" value="both" checked> Ambos</label>
  </div>
  <div id="list"></div>
  <div class="row st" id="listPager"></div>

  <button id="newGroup">＋ Nuevo grupo</button>
  <div id="groupForm" hidden>
    <input id="groupName" placeholder="Nombre del grupo" style="margin:6px 0">
    <label class="st"><input type="checkbox" id="groupPublic"> Pública (cualquiera con cuenta puede verla y suscribirse)</label>
```

Busca el cierre de esa vista y el inicio de `<p id="msg">` al final del archivo:

```html
    <div class="row" style="margin-top:6px">
      <button id="addStepBtn">＋ Añadir paso</button>
      <button id="saveGroupBtn">Guardar</button>
      <button id="cancelGroupBtn">Cancelar</button>
    </div>
  </div>
</div>

<p id="msg"></p>
```

Sustitúyelo por (se cierra `#allView` en vez de `#groupsView`, y se añade la vista
Explorar antes de `<p id="msg">`):

```html
    <div class="row" style="margin-top:6px">
      <button id="addStepBtn">＋ Añadir paso</button>
      <button id="saveGroupBtn">Guardar</button>
      <button id="cancelGroupBtn">Cancelar</button>
    </div>
  </div>
</div>

<div id="exploreView" hidden>
  <h2>Explorar listas públicas</h2>
  <div class="row"><input id="exploreQ" placeholder="Buscar por nombre"><button id="exploreBtn">Buscar</button></div>
  <div id="exploreResults"></div>
  <div class="row st" id="explorePager"></div>
</div>

<p id="msg"></p>
```

- [ ] **Step 2: `popup.js` — vista unificada (`renderMain`), tarjetas extraídas y Explorar**

Busca:

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

Sustitúyelo por:

```js
$("#tabAll").onclick = () => setView("all");
$("#tabExplore").onclick = () => setView("explore");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#exploreView").hidden = v !== "explore";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabExplore").classList.toggle("active", v === "explore");
  if (v === "all") renderMain();
}

$("#listFilter").addEventListener("change", () => { listFilter = document.querySelector('input[name="listf"]:checked').value; listPage = 0; renderMain(); });
```

Busca la función `renderList` completa (incluye el `.map` con las acciones de cada
tarjeta):

```js
async function renderList() {
  const list = live(await get("watchlist", []));
  watchlistCache = list; // mantiene el caché fresco: init, cada mutación y cada sync pasan por aquí
  $("#list").replaceChildren(...list.map(item => {
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
          btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderList(); sync(); })),
        st, eps));
  }));
  await updatePermBanner();
}
```

Sustitúyela por (se extrae la tarjeta a `itemCard`, reutilizable desde `renderMain`):

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

Busca la función `renderGroups` completa:

```js
async function renderGroups() {
  const list = groups.live(await get("groups", []));
  const watchlist = live(await get("watchlist", []));
  $("#groups").replaceChildren(...list.map(g => {
    const cur = groups.currentStep(g, watchlist);
    const st = el("div", { className: "st" });
    const onMark = async (step, episode) => {
      const it = await groups.markUpTo(step, episode);
      if (it) {
        const news = await get("news", []);
        await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
      }
      renderGroups(); sync();
    };
    const body = !cur
      ? el("div", { textContent: "✓ Terminado" })
      : el("div", {},
          el("div", { textContent:
            `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
            `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
          cur.item
            ? el("div", { className: "actions" },
                btn("Siguiente", async () => {
                  const p = prov(cur.step.provider);
                  await ensurePermissions(cur.step.provider);
                  st.textContent = "Comprobando…";
                  try {
                    const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                    st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
                  } catch (e) { st.textContent = "Error: " + explain(e); }
                }),
                btn("Visto", () => onMark(cur.step, cur.next)))
            : el("div", { className: "st",
                textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
          st);
    const missing = groups.missingSteps(g, watchlist);
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("b", { textContent: g.name }),
        missing.length
          ? el("div", { className: "st" },
              `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
              btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderGroups(); sync(); }))
          : "",
        renderAvatars(g, cur, watchlist),
        body,
        renderItinerary(g, cur, watchlist, () => { renderGroups(); sync(); }),
        el("div", { className: "actions" },
          btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderGroups(); sync(); }))));
  }));
}
```

Sustitúyela por (se extrae la tarjeta a `groupCard(g, watchlist, owned)`, que muestra
"Borrar grupo" solo si `owned`, y "Darse de baja" si no; añade `LIST_PAGE_SIZE`,
`listFilter`/`listPage`, `watchlistCache` ahora se fija en `renderMain`, y las nuevas
`renderMain`/Explorar):

```js
const LIST_PAGE_SIZE = 10;
let listFilter = "both";
let listPage = 0;

function groupCard(g, watchlist, owned) {
  const cur = groups.currentStep(g, watchlist);
  const st = el("div", { className: "st" });
  const onMark = async (step, episode) => {
    const it = await groups.markUpTo(step, episode);
    if (it) {
      const news = await get("news", []);
      await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
    }
    renderMain(); sync();
  };
  const body = !cur
    ? el("div", { textContent: "✓ Terminado" })
    : el("div", {},
        el("div", { textContent:
          `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
          `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
        cur.item
          ? el("div", { className: "actions" },
              btn("Siguiente", async () => {
                const p = prov(cur.step.provider);
                await ensurePermissions(cur.step.provider);
                st.textContent = "Comprobando…";
                try {
                  const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                  st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
                } catch (e) { st.textContent = "Error: " + explain(e); }
              }),
              btn("Visto", () => onMark(cur.step, cur.next)))
          : el("div", { className: "st",
              textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
        st);
  const missing = groups.missingSteps(g, watchlist);
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      owned ? "" : el("div", { className: "st", textContent: `de ${String(g.user_id || "").slice(0, 8)}…` }),
      missing.length
        ? el("div", { className: "st" },
            `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
            btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderMain(); sync(); }))
        : "",
      renderAvatars(g, cur, watchlist),
      body,
      renderItinerary(g, cur, watchlist, () => { renderMain(); sync(); }),
      el("div", { className: "actions" },
        owned
          ? btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderMain(); sync(); })
          : btn("Darse de baja", async () => { await groups.unsubscribe(g.user_id, g.id); renderMain(); sync(); }))));
}

async function renderMain() {
  const watchlist = live(await get("watchlist", []));
  watchlistCache = watchlist; // mantiene el caché fresco: init, cada mutación y cada sync pasan por aquí
  const myGroups = groups.live(await get("groups", []));
  const subGroups = await get("subscribed_groups", []);
  const entries = [];
  if (listFilter !== "groups") entries.push(...watchlist.map(item => ({ kind: "item", data: item, ts: item.updated_at })));
  if (listFilter !== "media") {
    entries.push(...myGroups.map(g => ({ kind: "group", data: g, owned: true, ts: g.updated_at })));
    entries.push(...subGroups.map(g => ({ kind: "group", data: g, owned: false, ts: g.updated_at })));
  }
  entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  listPage = Math.min(listPage, pages - 1);
  const start = listPage * LIST_PAGE_SIZE;
  const page = entries.slice(start, start + LIST_PAGE_SIZE);

  $("#list").replaceChildren(...(page.length
    ? page.map(e => (e.kind === "item" ? itemCard(e.data) : groupCard(e.data, watchlist, e.owned)))
    : ["Nada que mostrar con este filtro."]));
  $("#listPager").replaceChildren(
    btn("◀", () => { listPage = Math.max(0, listPage - 1); renderMain(); }),
    el("span", { textContent: `Página ${listPage + 1} de ${pages}` }),
    btn("▶", () => { listPage = Math.min(pages - 1, listPage + 1); renderMain(); }));
  await updatePermBanner();
}

const EXPLORE_PAGE_SIZE = 10;
let exploreResults = [];
let explorePage = 0;

$("#exploreBtn").onclick = async () => {
  const q = $("#exploreQ").value.trim();
  $("#exploreResults").replaceChildren("Buscando…");
  try {
    exploreResults = await searchPublicGroups(q);
    explorePage = 0;
    renderExplore();
  } catch (e) { $("#exploreResults").replaceChildren("Error: " + explain(e)); }
};

function exploreCard(g) {
  const st = el("div", { className: "st" });
  const stars = el("select", {});
  stars.replaceChildren(...[1, 2, 3, 4, 5].map(n => el("option", { value: n, textContent: `${n} ★` })));
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      el("div", { className: "st", textContent:
        g.rating_count ? `${g.rating_avg.toFixed(1)} ★ (${g.rating_count})` : "Sin valoraciones" }),
      el("div", { className: "actions" },
        btn("Suscribirme", async () => {
          await groups.subscribe(g, live(await get("watchlist", [])));
          st.textContent = "Suscrito.";
          sync();
        }),
        stars,
        btn("Valorar", async () => {
          try { await rateGroup(g.user_id, g.id, +stars.value); st.textContent = "Gracias por valorar."; }
          catch (e) { st.textContent = "Error: " + explain(e); }
        })),
      st));
}

function renderExplore() {
  const pages = Math.max(1, Math.ceil(exploreResults.length / EXPLORE_PAGE_SIZE));
  explorePage = Math.min(explorePage, pages - 1);
  const start = explorePage * EXPLORE_PAGE_SIZE;
  const page = exploreResults.slice(start, start + EXPLORE_PAGE_SIZE);
  $("#exploreResults").replaceChildren(...(page.length ? page.map(exploreCard) : ["Sin resultados"]));
  $("#explorePager").replaceChildren(
    btn("◀", () => { explorePage = Math.max(0, explorePage - 1); renderExplore(); }),
    el("span", { textContent: `Página ${explorePage + 1} de ${pages}` }),
    btn("▶", () => { explorePage = Math.min(pages - 1, explorePage + 1); renderExplore(); }));
}
```

Ahora actualiza el import de `sync.js` para traer las dos funciones nuevas. Busca:

```js
import { getSession } from "./sync.js";
```

Sustitúyela por:

```js
import { getSession, searchPublicGroups, rateGroup } from "./sync.js";
```

Actualiza el resto de sitios que llamaban a `renderList()`/`renderGroups()`. Busca:

```js
async function sync(quiet = true) {
  if (!(await getSession())) { $("#cloud").textContent = ""; if (!quiet) msg("Inicia sesión en Opciones para sincronizar."); return; }
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders();
    renderList();
    if (!$("#groupsView").hidden) renderGroups();
    if (!quiet) msg("Sincronizado");
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) msg("Error de sync: " + explain(e));
  }
}
```

Sustitúyela por:

```js
async function sync(quiet = true) {
  if (!(await getSession())) { $("#cloud").textContent = ""; if (!quiet) msg("Inicia sesión en Opciones para sincronizar."); return; }
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders();
    if (!$("#allView").hidden) renderMain();
    if (!quiet) msg("Sincronizado");
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) msg("Error de sync: " + explain(e));
  }
}
```

Busca:

```js
async function init() {
  $("#opts").onclick = () => chrome.runtime.openOptionsPage();
  $("#sync").onclick = () => sync(false);
  chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.news) renderNews(); });
  await fillProviders();
  renderNews();
  renderList();
  sync();
}
```

Sustitúyela por:

```js
async function init() {
  $("#opts").onclick = () => chrome.runtime.openOptionsPage();
  $("#sync").onclick = () => sync(false);
  chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.news) renderNews(); });
  await fillProviders();
  renderNews();
  renderMain();
  sync();
}
```

Busca (dentro de `markSeen`):

```js
async function markSeen(item) {
  const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
  if (it) {
    const news = await get("news", []);
    await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
  }
  renderList();
  sync();
}
```

Sustitúyela por:

```js
async function markSeen(item) {
  const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
  if (it) {
    const news = await get("news", []);
    await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
  }
  renderMain();
  sync();
}
```

Busca:

```js
$("#all").onclick = async () => {
  await ensurePermissions();
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderList(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};
```

Sustitúyela por:

```js
$("#all").onclick = async () => {
  await ensurePermissions();
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderMain(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};
```

Busca (dentro de `$("#go").onclick`, el botón "＋ Guardar" de un resultado de
búsqueda):

```js
          btn("＋ Guardar", async () => { await add(r); renderList(); msg("Guardada"); sync(); }),
```

Sustitúyela por:

```js
          btn("＋ Guardar", async () => { await add(r); renderMain(); msg("Guardada"); sync(); }),
```

Busca `$("#newGroup").onclick`:

```js
$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#stepFrom").value = "1";
```

Sustitúyela por (añade el reseteo del checkbox de visibilidad):

```js
$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
```

Busca `$("#saveGroupBtn").onclick`:

```js
$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { msg("Ponle un nombre al grupo"); return; }
  if (!draftSteps.length) { msg("Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"); return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  $("#groupForm").hidden = true;
  renderGroups();
  sync();
};
```

Sustitúyela por:

```js
$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { msg("Ponle un nombre al grupo"); return; }
  if (!draftSteps.length) { msg("Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"); return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  if ($("#groupPublic").checked) await groups.setPublic(g.id, true);
  $("#groupForm").hidden = true;
  renderMain();
  sync();
};
```

- [ ] **Step 3: Verificación**

```bash
node --check extension/popup.js
bash tests/run.sh
```

Expected: sintaxis correcta y la suite entera sigue en verde (este archivo no tiene
test automático propio).

- [ ] **Step 4: Commit**

```bash
git add extension/popup.html extension/popup.js
git commit -m "feat: extensión — lista unificada con filtro/paginación y pestaña Explorar"
```

---

### Task 5: PWA — lista unificada + pestaña "Explorar"

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`
- Modify: `web/style.css`

**Interfaces:** mismas de la Task 4, sobre `web/app.js` (sin `ensurePermissions` /
`watchlistCache` — la PWA no usa permisos de Chrome).

- [ ] **Step 1: `web/style.css` — estilos de filtro y radios**

Busca:

```css
#importRows .row { align-items: center; }
#importRows input[type="checkbox"] { width: auto; flex: 0 0 auto; }
```

Sustitúyelo por:

```css
#importRows .row { align-items: center; }
#importRows input[type="checkbox"] { width: auto; flex: 0 0 auto; }
#listFilter { display: flex; gap: 12px; margin: 6px 0; }
#listFilter label { display: flex; align-items: center; gap: 4px; font-size: .85rem; }
#listFilter input { width: auto; }
```

- [ ] **Step 2: `web/index.html` — pestañas, filtro, paginador y vista Explorar**

Busca:

```html
    <h2>Buscar</h2>
    <div id="langFilter"></div>
    <div class="row"><input id="q" placeholder="Re:Zero"><button id="go">Buscar</button></div>
    <p id="searchMsg" class="msg"></p>
    <div id="results"></div>

    <div class="tabs">
      <button id="tabAll" class="active">Todo</button>
      <button id="tabGroups">Grupos</button>
      <button id="tabConfig" hidden>Config</button>
    </div>

    <div id="allView">
      <h2>Mi lista <button id="all" class="small">Comprobar todos</button></h2>
      <div id="list"></div>
    </div>

    <div id="groupsView" hidden>
      <div id="groups"></div>
      <button id="newGroup" class="small">＋ Nuevo grupo</button>
      <div id="groupForm" hidden>
        <input id="groupName" placeholder="Nombre del grupo">
```

Sustitúyelo por:

```html
    <div class="tabs">
      <button id="tabAll" class="active">Mi lista</button>
      <button id="tabExplore">Explorar</button>
      <button id="tabConfig" hidden>Config</button>
    </div>

    <div id="allView">
      <h2>Buscar</h2>
      <div id="langFilter"></div>
      <div class="row"><input id="q" placeholder="Re:Zero"><button id="go">Buscar</button></div>
      <p id="searchMsg" class="msg"></p>
      <div id="results"></div>

      <h2>Mi lista <button id="all" class="small">Comprobar todos</button></h2>
      <div id="listFilter">
        <label><input type="radio" name="listf" value="media"> Media</label>
        <label><input type="radio" name="listf" value="groups"> Listas</label>
        <label><input type="radio" name="listf" value="both" checked> Ambos</label>
      </div>
      <div id="list"></div>
      <div class="row hint" id="listPager"></div>

      <button id="newGroup" class="small">＋ Nuevo grupo</button>
      <div id="groupForm" hidden>
        <input id="groupName" placeholder="Nombre del grupo">
        <label class="hint"><input type="checkbox" id="groupPublic"> Pública (cualquiera con cuenta puede verla y suscribirse)</label>
```

Busca el cierre de esa sección y el inicio de la de Config:

```html
        <p id="groupMsg" class="msg"></p>
      </div>
    </div>

    <div id="configView" hidden>
```

Sustitúyelo por (se cierra `#allView` en vez de `#groupsView`, y se añade la vista
Explorar antes de Config):

```html
        <p id="groupMsg" class="msg"></p>
      </div>
    </div>

    <div id="exploreView" hidden>
      <h2>Explorar listas públicas</h2>
      <div class="row"><input id="exploreQ" placeholder="Buscar por nombre"><button id="exploreBtn" class="small">Buscar</button></div>
      <div id="exploreResults"></div>
      <div class="row hint" id="explorePager"></div>
    </div>

    <div id="configView" hidden>
```

- [ ] **Step 3: `web/app.js` — vista unificada, tarjetas extraídas y Explorar**

Busca:

```js
$("#tabAll").onclick = () => setView("all");
$("#tabGroups").onclick = () => setView("groups");
$("#tabConfig").onclick = () => setView("config");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#groupsView").hidden = v !== "groups";
  $("#configView").hidden = v !== "config";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabGroups").classList.toggle("active", v === "groups");
  $("#tabConfig").classList.toggle("active", v === "config");
  if (v === "groups") renderGroups();
  if (v === "config") renderConfig();
}
```

Sustitúyelo por:

```js
$("#tabAll").onclick = () => setView("all");
$("#tabExplore").onclick = () => setView("explore");
$("#tabConfig").onclick = () => setView("config");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#exploreView").hidden = v !== "explore";
  $("#configView").hidden = v !== "config";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabExplore").classList.toggle("active", v === "explore");
  $("#tabConfig").classList.toggle("active", v === "config");
  if (v === "all") renderMain();
  if (v === "config") renderConfig();
}

$("#listFilter").addEventListener("change", () => { listFilter = document.querySelector('input[name="listf"]:checked').value; listPage = 0; renderMain(); });
```

Busca la función `renderList` completa:

```js
async function renderList() {
  const list = live(await get("watchlist", []));
  $("#list").replaceChildren(...list.map(item => {
    const st = el("div", { className: "msg" });
    const eps = el("div", { className: "eps" });
    return el("div", { className: "card" },
      item.image ? el("img", { src: safe(item.image) }) : "",
      el("div", { className: "body" },
        el("b", { textContent: item.title }),
        el("div", { className: "hint", textContent: "Visto hasta el episodio " + (item.last || 0) }),
        el("div", { className: "actions" },
          btn("Siguiente", async () => {
            const p = prov(item.provider);
            const n = (item.last || 0) + 1;
            st.textContent = "Comprobando…";
            try {
              const r = await engine.checkEpisode(p, item.slug, n);
              st.replaceChildren(r.exists ? link(r.url, `Ep ${n} disponible ▶`) : `Ep ${n}: aún no`);
            } catch (e) { st.textContent = "Error: " + explain(e); }
          }),
          btn("Episodios", async () => {
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
          btn("Visto +1", async () => {
            const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
            if (it) {
              const news = await get("news", []);
              await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
            }
            renderList(); requestSync();
          }),
          btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderList(); requestSync(); })),
        st, eps));
  }));
}
```

Sustitúyela por:

```js
function itemCard(item) {
  const st = el("div", { className: "msg" });
  const eps = el("div", { className: "eps" });
  return el("div", { className: "card" },
    item.image ? el("img", { src: safe(item.image) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      el("div", { className: "hint", textContent: "Visto hasta el episodio " + (item.last || 0) }),
      el("div", { className: "actions" },
        btn("Siguiente", async () => {
          const p = prov(item.provider);
          const n = (item.last || 0) + 1;
          st.textContent = "Comprobando…";
          try {
            const r = await engine.checkEpisode(p, item.slug, n);
            st.replaceChildren(r.exists ? link(r.url, `Ep ${n} disponible ▶`) : `Ep ${n}: aún no`);
          } catch (e) { st.textContent = "Error: " + explain(e); }
        }),
        btn("Episodios", async () => {
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
        btn("Visto +1", async () => {
          const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
          if (it) {
            const news = await get("news", []);
            await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
          }
          renderMain(); requestSync();
        }),
        btn("Quitar", async () => { await mutate(item.provider, item.slug, x => { x.deleted = true; }); renderMain(); requestSync(); })),
      st, eps));
}
```

Busca la función `renderGroups` completa:

```js
async function renderGroups() {
  const list = groups.live(await get("groups", []));
  const watchlist = live(await get("watchlist", []));
  $("#groups").replaceChildren(...list.map(g => {
    const cur = groups.currentStep(g, watchlist);
    const st = el("div", { className: "msg" });
    const onMark = async (step, episode) => {
      const it = await groups.markUpTo(step, episode);
      if (it) {
        const news = await get("news", []);
        await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
      }
      renderGroups(); requestSync();
    };
    const body = !cur
      ? el("div", { textContent: "✓ Terminado" })
      : el("div", {},
          el("div", { textContent:
            `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
            `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
          cur.item
            ? el("div", { className: "actions" },
                btn("Siguiente", async () => {
                  const p = prov(cur.step.provider);
                  st.textContent = "Comprobando…";
                  try {
                    const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                    st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
                  } catch (e) { st.textContent = "Error: " + explain(e); }
                }),
                btn("Visto", () => onMark(cur.step, cur.next)))
            : el("div", { className: "hint",
                textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
          st);
    const missing = groups.missingSteps(g, watchlist);
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("b", { textContent: g.name }),
        missing.length
          ? el("div", { className: "hint" },
              `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
              btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderGroups(); requestSync(); }))
          : "",
        renderAvatars(g, cur, watchlist),
        body,
        renderItinerary(g, cur, watchlist, () => { renderGroups(); requestSync(); }),
        el("div", { className: "actions" },
          btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderGroups(); requestSync(); }))));
  }));
}
```

Sustitúyela por:

```js
function groupCard(g, watchlist, owned) {
  const cur = groups.currentStep(g, watchlist);
  const st = el("div", { className: "msg" });
  const onMark = async (step, episode) => {
    const it = await groups.markUpTo(step, episode);
    if (it) {
      const news = await get("news", []);
      await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
    }
    renderMain(); requestSync();
  };
  const body = !cur
    ? el("div", { textContent: "✓ Terminado" })
    : el("div", {},
        el("div", { textContent:
          `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
          `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
        cur.item
          ? el("div", { className: "actions" },
              btn("Siguiente", async () => {
                const p = prov(cur.step.provider);
                st.textContent = "Comprobando…";
                try {
                  const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                  st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
                } catch (e) { st.textContent = "Error: " + explain(e); }
              }),
              btn("Visto", () => onMark(cur.step, cur.next)))
          : el("div", { className: "hint",
              textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
        st);
  const missing = groups.missingSteps(g, watchlist);
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      owned ? "" : el("div", { className: "hint", textContent: `de ${String(g.user_id || "").slice(0, 8)}…` }),
      missing.length
        ? el("div", { className: "hint" },
            `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
            btn("Reparar", async () => { await groups.repairGroup(g, watchlist); renderMain(); requestSync(); }))
        : "",
      renderAvatars(g, cur, watchlist),
      body,
      renderItinerary(g, cur, watchlist, () => { renderMain(); requestSync(); }),
      el("div", { className: "actions" },
        owned
          ? btn("Borrar grupo", async () => { await groups.removeGroup(g.id); renderMain(); requestSync(); })
          : btn("Darse de baja", async () => { await groups.unsubscribe(g.user_id, g.id); renderMain(); requestSync(); }))));
}

const LIST_PAGE_SIZE = 10;
let listFilter = "both";
let listPage = 0;

async function renderMain() {
  const watchlist = live(await get("watchlist", []));
  const myGroups = groups.live(await get("groups", []));
  const subGroups = await get("subscribed_groups", []);
  const entries = [];
  if (listFilter !== "groups") entries.push(...watchlist.map(item => ({ kind: "item", data: item, ts: item.updated_at })));
  if (listFilter !== "media") {
    entries.push(...myGroups.map(g => ({ kind: "group", data: g, owned: true, ts: g.updated_at })));
    entries.push(...subGroups.map(g => ({ kind: "group", data: g, owned: false, ts: g.updated_at })));
  }
  entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  listPage = Math.min(listPage, pages - 1);
  const start = listPage * LIST_PAGE_SIZE;
  const page = entries.slice(start, start + LIST_PAGE_SIZE);

  $("#list").replaceChildren(...(page.length
    ? page.map(e => (e.kind === "item" ? itemCard(e.data) : groupCard(e.data, watchlist, e.owned)))
    : ["Nada que mostrar con este filtro."]));
  $("#listPager").replaceChildren(
    btn("◀", () => { listPage = Math.max(0, listPage - 1); renderMain(); }),
    el("span", { textContent: `Página ${listPage + 1} de ${pages}` }),
    btn("▶", () => { listPage = Math.min(pages - 1, listPage + 1); renderMain(); }));
}

const EXPLORE_PAGE_SIZE = 10;
let exploreResults = [];
let explorePage = 0;

$("#exploreBtn").onclick = async () => {
  const q = $("#exploreQ").value.trim();
  $("#exploreResults").replaceChildren("Buscando…");
  try {
    exploreResults = await searchPublicGroups(q);
    explorePage = 0;
    renderExplore();
  } catch (e) { $("#exploreResults").replaceChildren("Error: " + explain(e)); }
};

function exploreCard(g) {
  const st = el("div", { className: "hint" });
  const stars = el("select", {});
  stars.replaceChildren(...[1, 2, 3, 4, 5].map(n => el("option", { value: n, textContent: `${n} ★` })));
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      el("div", { className: "hint", textContent:
        g.rating_count ? `${g.rating_avg.toFixed(1)} ★ (${g.rating_count})` : "Sin valoraciones" }),
      el("div", { className: "actions" },
        btn("Suscribirme", async () => {
          await groups.subscribe(g, live(await get("watchlist", [])));
          st.textContent = "Suscrito.";
          requestSync();
        }),
        stars,
        btn("Valorar", async () => {
          try { await rateGroup(g.user_id, g.id, +stars.value); st.textContent = "Gracias por valorar."; }
          catch (e) { st.textContent = "Error: " + explain(e); }
        })),
      st));
}

function renderExplore() {
  const pages = Math.max(1, Math.ceil(exploreResults.length / EXPLORE_PAGE_SIZE));
  explorePage = Math.min(explorePage, pages - 1);
  const start = explorePage * EXPLORE_PAGE_SIZE;
  const page = exploreResults.slice(start, start + EXPLORE_PAGE_SIZE);
  $("#exploreResults").replaceChildren(...(page.length ? page.map(exploreCard) : ["Sin resultados"]));
  $("#explorePager").replaceChildren(
    btn("◀", () => { explorePage = Math.max(0, explorePage - 1); renderExplore(); }),
    el("span", { textContent: `Página ${explorePage + 1} de ${pages}` }),
    btn("▶", () => { explorePage = Math.min(pages - 1, explorePage + 1); renderExplore(); }));
}
```

Actualiza el import de `sync.js`. Busca:

```js
import { signIn, signUp, signOut, getSession, syncNow, saveAppProviders } from "../extension/sync.js";
```

Sustitúyela por:

```js
import { signIn, signUp, signOut, getSession, syncNow, saveAppProviders, searchPublicGroups, rateGroup } from "../extension/sync.js";
```

Actualiza el resto de sitios que llamaban a `renderList()`/`renderGroups()`. Busca:

```js
async function sync(quiet = true) {
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders(); await renderList(); await renderFeed();
    await applyAdminVisibility();
    if (!$("#groupsView").hidden) renderGroups();
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) $("#authMsg").textContent = "Error de sync: " + explain(e);
  }
}
```

Sustitúyela por:

```js
async function sync(quiet = true) {
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders(); await renderMain(); await renderFeed();
    await applyAdminVisibility();
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) $("#authMsg").textContent = "Error de sync: " + explain(e);
  }
}
```

Busca:

```js
async function showMain() {
  const s = await getSession();
  $("#authView").hidden = true;
  $("#mainView").hidden = false;
  $("#who").textContent = s.user.email;
  await fillProviders(); await renderList(); await renderFeed();
  sync();
}
```

Sustitúyela por:

```js
async function showMain() {
  const s = await getSession();
  $("#authView").hidden = true;
  $("#mainView").hidden = false;
  $("#who").textContent = s.user.email;
  await fillProviders(); await renderMain(); await renderFeed();
  sync();
}
```

Busca (dentro de `$("#go").onclick`, el botón "＋ Guardar"):

```js
        btn("＋ Guardar", async () => { await add(r); await renderList(); requestSync(); $("#searchMsg").textContent = "Guardada"; }),
```

Sustitúyela por:

```js
        btn("＋ Guardar", async () => { await add(r); await renderMain(); requestSync(); $("#searchMsg").textContent = "Guardada"; }),
```

Busca `$("#newGroup").onclick`:

```js
$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#stepFrom").value = "1";
```

Sustitúyela por:

```js
$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
```

Busca `$("#saveGroupBtn").onclick`:

```js
$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { $("#groupMsg").textContent = "Ponle un nombre al grupo"; return; }
  if (!draftSteps.length) { $("#groupMsg").textContent = "Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"; return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  $("#groupForm").hidden = true;
  renderGroups();
  requestSync();
};
```

Sustitúyela por:

```js
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

- [ ] **Step 4: Verificación**

```bash
node --check web/app.js
```

Deja anotado para probar más tarde en el navegador: pestaña "Mi lista" con filtro y
paginación, pestaña "Explorar" buscando un grupo público, suscribirse, valorar.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/app.js web/style.css
git commit -m "feat: PWA — lista unificada con filtro/paginación y pestaña Explorar"
```

---

### Task 6: README + verificación final

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Añadir la sección de grupos públicos**

Busca (el final de la subsección "Grupos" existente — usa `grep -n "^### Grupos" -A
50 README.md` para localizar dónde termina esa subsección si el texto exacto de abajo
no coincide letra por letra con el README actual, y añade el bloque nuevo justo
después de su último párrafo, antes del siguiente `##`/`###`):

```
### Grupos
```

Añade, al final de esa subsección (antes de que empiece la siguiente `##`/`###` o el
final del archivo), este bloque nuevo:

```

Un grupo puede hacerse público al crearlo ("Pública"): cualquier cuenta lo encuentra
en la pestaña **Explorar**, se suscribe (sin copiarlo — sigue el original en vivo) y
lo valora con estrellas. Suscribirte repara sola tu lista para poder marcar progreso
desde el primer momento; tu progreso es tuyo, separado del de cualquier otro
suscriptor. Solo el dueño puede editar o borrar un grupo; el resto solo puede darse de
baja. Ver `docs/superpowers/specs/2026-09-26-public-groups-design.md` para el detalle
completo.
```

- [ ] **Step 2: Verificación final de todo el repo**

```bash
bash tests/run.sh
node --check extension/groups.js && node --check extension/sync.js && node --check extension/popup.js && node --check web/app.js && node --check cron/generate-feed.mjs
git status --short
```

Expected: suite completa en verde, sin errores de sintaxis, y `git status` solo
muestra archivos tocados por este plan más lo que ya estuviera pendiente de antes
(`.env.example`, `db-migrate.yml`).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README explica grupos públicos, suscripción y valoración"
```
