# Providers a nivel de app (no por usuario) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `providers` deja de ser una columna por usuario en `user_settings` y pasa a ser
configuración compartida de la app (tabla `app_config`, una fila), de solo lectura para
todo el mundo salvo una cuenta admin (tabla `admins`). `watchlist` y `groups` siguen siendo
100% individuales — no cambian.

**Architecture:** Dos tablas nuevas en Supabase con RLS (`app_config` lectura abierta/escritura
solo-admin, `admins` lista de `user_id`). `extension/sync.js` gana `syncAppConfig()` (pull +
detecta si eres admin) y `saveAppProviders()` (único punto de escritura, solo admin). La UI de
edición (textarea JSON + Guardar) se oculta por completo si no eres admin, tanto en la extensión
(`options.html`) como en la PWA (`index.html`). La extensión, que necesita permiso de Chrome por
dominio para poder hacer `fetch`, lo pide de forma transparente en el primer uso real de cada
provider (Buscar/Siguiente/Episodios/Comprobar todos) en vez de en un botón dedicado. El cron
pasa a leer `app_config` una vez, no `providers` por usuario.

**Tech Stack:** Igual que el resto del proyecto — JS vanilla + `fetch`, Supabase (Postgres + RLS +
PostgREST), Python (`http.server`) para los mocks de test, Node para los tests de integración.

**Spec:** `docs/superpowers/specs/2026-09-26-app-wide-providers-design.md`

## Global Constraints

- Toda política RLS nueva usa `to authenticated` (nunca abierta a `anon`/internet), igual que las
  políticas existentes de `watchlist`/`groups`.
- La forma y validación del JSON de providers no cambia: array de objetos con `id`, `base_url`,
  `search` (con `search.slug_regex`), `episode` obligatorios; `new URL(base_url)` debe ser válida.
- `is_admin`, `providers`, `providers_updated_at` son claves locales leídas/escritas con
  `get`/`set` de `extension/store.js` (dual-mode `chrome.storage`/`localStorage`), igual que el
  resto del estado sincronizado.
- La sección de edición de providers (textarea + botón Guardar) se **oculta por completo** si no
  eres admin — no se muestra en modo solo-lectura, ni en la extensión ni en la PWA.
- `chrome.permissions.request(...)` debe invocarse sin ningún `await` previo dentro del mismo
  handler de clic (requisito del gesto de usuario de Chrome) — patrón ya usado en `options.js`.
- `watchlist`, `groups`, `feed_token`: su sincronización no cambia en este plan.
- Los archivos de migración (`supabase/migrations/*.sql`) deben contener el mismo SQL que se
  añade a `supabase/schema.sql`, terminando en `notify pgrst, 'reload schema';` — convención ya
  usada en `supabase/migrations/20260925120000_groups.sql`.
- Verificación de cada tarea con test automático: `bash tests/run.sh` desde la raíz del repo.

---

### Task 1: Esquema de Supabase — `app_config` + `admins`

**Files:**
- Create: `supabase/migrations/20260926130000_app_providers.sql`
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produce las tablas `public.app_config` (fila única `id=1`, columna `providers jsonb`,
  `updated_at`) y `public.admins` (`user_id uuid primary key`), con RLS, que las Tasks 2-5
  consumen vía PostgREST (`/rest/v1/app_config`, `/rest/v1/admins`).

- [ ] **Step 1: Crear el archivo de migración**

Crea `supabase/migrations/20260926130000_app_providers.sql` con este contenido exacto:

```sql
-- Providers de la app (config compartida, no por usuario). Ver
-- docs/superpowers/specs/2026-09-26-app-wide-providers-design.md
create table if not exists public.app_config (
  id         int primary key default 1,
  providers  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.app_config enable row level security;
alter table public.admins     enable row level security;

drop policy if exists "read app config" on public.app_config;
create policy "read app config" on public.app_config
  for select to authenticated using (true);

drop policy if exists "admin insert app config" on public.app_config;
create policy "admin insert app config" on public.app_config
  for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "admin update app config" on public.app_config;
create policy "admin update app config" on public.app_config
  for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "read own admin flag" on public.admins;
create policy "read own admin flag" on public.admins
  for select to authenticated using (auth.uid() = user_id);

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Añadir el mismo bloque a `supabase/schema.sql`**

Abre `supabase/schema.sql`. Busca el final del archivo:

```sql
-- Bucket público donde el cron publica los feeds. Sin política de listado: solo se accede
-- conociendo la URL completa (que incluye el feed_token secreto).
insert into storage.buckets (id, name, public) values ('feeds', 'feeds', true)
on conflict (id) do nothing;

notify pgrst, 'reload schema';
```

Sustitúyelo por (el mismo bloque del bucket, seguido del bloque nuevo, seguido del `notify`
final — solo debe quedar un `notify pgrst, 'reload schema';` al final del archivo):

```sql
-- Bucket público donde el cron publica los feeds. Sin política de listado: solo se accede
-- conociendo la URL completa (que incluye el feed_token secreto).
insert into storage.buckets (id, name, public) values ('feeds', 'feeds', true)
on conflict (id) do nothing;

-- Providers de la app (config compartida, no por usuario). Ver
-- docs/superpowers/specs/2026-09-26-app-wide-providers-design.md
create table if not exists public.app_config (
  id         int primary key default 1,
  providers  jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.app_config enable row level security;
alter table public.admins     enable row level security;

drop policy if exists "read app config" on public.app_config;
create policy "read app config" on public.app_config
  for select to authenticated using (true);

drop policy if exists "admin insert app config" on public.app_config;
create policy "admin insert app config" on public.app_config
  for insert to authenticated
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "admin update app config" on public.app_config;
create policy "admin update app config" on public.app_config
  for update to authenticated
  using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));

drop policy if exists "read own admin flag" on public.admins;
create policy "read own admin flag" on public.admins
  for select to authenticated using (auth.uid() = user_id);

notify pgrst, 'reload schema';
```

- [ ] **Step 3: Verificación**

No hay test automático para SQL de Supabase (mismo criterio que el resto de `schema.sql`): revisa
que ambos archivos tengan el bloque idéntico y que el archivo termine con un único
`notify pgrst, 'reload schema';`. El usuario ejecutará este SQL contra su proyecto real más
adelante (fuera de este plan).

- [ ] **Step 4: Commit**

```bash
git add supabase/schema.sql supabase/migrations/20260926130000_app_providers.sql
git commit -m "feat: esquema app_config + admins para providers compartidos"
```

---

### Task 2: Capa de datos — `sync.js`, `cron/generate-feed.mjs` y el harness de test

**Files:**
- Modify: `extension/sync.js`
- Modify: `cron/generate-feed.mjs`
- Modify: `tests/mock_supabase.py`
- Modify: `tests/test-sync-cron.mjs`

**Interfaces:**
- Consume: las tablas/políticas de Task 1.
- Produce: `syncAppConfig(uid)` (interna) y `export async function saveAppProviders(arr)` en
  `extension/sync.js` — Tasks 3 y 5 llaman a `saveAppProviders`. `syncNow()` sigue exportada con
  la misma firma (sin argumentos). Claves locales nuevas: `is_admin` (boolean, vía `get`/`set` de
  `store.js`).

- [ ] **Step 1: `tests/mock_supabase.py` — modelar `app_config` con escritura solo-admin**

El fake no simula RLS de verdad (filtra cada tabla por `user_id`). `app_config` no tiene
`user_id`, así que necesita dos casos especiales: lectura abierta, escritura solo si el uid está
en la tabla `admins`.

En `do_GET`, busca:

```python
            rows = list(TABLES.get(m[1], []))
            if kind == "user":  # simula RLS
                rows = [r for r in rows if r.get("user_id") == uid]
```

Sustitúyelo por:

```python
            rows = list(TABLES.get(m[1], []))
            if kind == "user" and m[1] != "app_config":  # simula RLS (app_config: lectura abierta)
                rows = [r for r in rows if r.get("user_id") == uid]
```

En `do_POST`, busca:

```python
            table = TABLES.setdefault(m[1], [])
            for row in json.loads(data):
                if kind == "user" and row.get("user_id") != uid:
                    return self.send(403, {"message": "RLS: new row violates policy"})
                cur = next((r for r in table if all(r.get(k) == row.get(k) for k in pk)), None)
```

Sustitúyelo por:

```python
            table = TABLES.setdefault(m[1], [])
            is_admin = uid in {r.get("user_id") for r in TABLES.get("admins", [])}
            for row in json.loads(data):
                if m[1] == "app_config":
                    if kind == "user" and not is_admin:
                        return self.send(403, {"message": "RLS: solo admin puede escribir app_config"})
                elif kind == "user" and row.get("user_id") != uid:
                    return self.send(403, {"message": "RLS: new row violates policy"})
                cur = next((r for r in table if all(r.get(k) == row.get(k) for k in pk)), None)
```

- [ ] **Step 2: `extension/sync.js` — `syncAppConfig` + `saveAppProviders`**

Busca la función `syncSettings` completa:

```js
async function syncSettings(uid) {
  const [remote] = await rest(`user_settings?select=providers,updated_at&user_id=eq.${uid}`);
  const providers = await get("providers", []);
  const localTs = await get("providers_updated_at", null);

  const push = async t => {
    await rest("user_settings?on_conflict=user_id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: [{ user_id: uid, providers, updated_at: t }]
    });
    await set("providers_updated_at", t);
  };
  const pull = async () => {
    await set("providers", remote.providers || []);
    await set("providers_updated_at", remote.updated_at);
  };

  if (!remote) await push(localTs || now());
  else if (!localTs) await pull();
  else if (ts(localTs) > ts(remote.updated_at)) await push(localTs);
  else if (ts(remote.updated_at) > ts(localTs)) await pull();

  const [row] = await rest(`user_settings?select=feed_token&user_id=eq.${uid}`);
  if (row?.feed_token) await set("feed_token", row.feed_token);
}
```

Sustitúyela por estas dos funciones:

```js
// Asegura que exista la fila de user_settings del usuario (para su feed_token) y lo lee.
// providers ya no vive aquí: ver syncAppConfig.
async function syncFeedToken(uid) {
  const [row] = await rest(`user_settings?select=feed_token&user_id=eq.${uid}`);
  if (row?.feed_token) { await set("feed_token", row.feed_token); return; }
  await rest("user_settings?on_conflict=user_id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ user_id: uid }]
  });
  const [created] = await rest(`user_settings?select=feed_token&user_id=eq.${uid}`);
  if (created?.feed_token) await set("feed_token", created.feed_token);
}

// providers es config de la app (no por usuario): todos hacen pull de app_config,
// solo el admin (fila en `admins`) puede escribir con saveAppProviders().
async function syncAppConfig(uid) {
  const [row] = await rest("app_config?select=providers,updated_at&id=eq.1");
  await set("providers", row?.providers || []);
  await set("providers_updated_at", row?.updated_at || null);
  const adminRows = await rest(`admins?select=user_id&user_id=eq.${uid}`);
  await set("is_admin", adminRows.length > 0);
}

export async function saveAppProviders(arr) {
  await session();
  const t = now();
  await rest("app_config?on_conflict=id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ id: 1, providers: arr, updated_at: t }]
  });
  await set("providers", arr);
  await set("providers_updated_at", t);
}
```

Busca `export async function syncNow()`:

```js
export async function syncNow() {
  const s = await session();
  await syncSettings(s.user.id);
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
  await set("last_sync", now());
}
```

- [ ] **Step 3: `cron/generate-feed.mjs` — leer providers de `app_config`, no por usuario**

Busca:

```js
const settings = await rest("user_settings?select=user_id,providers,feed_token");
```

Sustitúyelo por:

```js
const [appConfig] = await rest("app_config?select=providers&id=eq.1");
const providers = appConfig?.providers || [];
const settings = await rest("user_settings?select=user_id,feed_token");
```

Busca dentro del bucle `for (const st of settings) { try {`:

```js
  try {
    const providers = st.providers || [];
    const mine = watch.filter(w => w.user_id === st.user_id);
```

Sustitúyelo por (se elimina la línea de `providers`, que ahora es la constante de fuera):

```js
  try {
    const mine = watch.filter(w => w.user_id === st.user_id);
```

- [ ] **Step 4: `tests/test-sync-cron.mjs` — admin/no-admin**

Busca la línea de import de `sync.js`:

```js
const { signUp, signIn, syncNow } = await import("../extension/sync.js");
```

Sustitúyela por:

```js
const { signUp, signIn, syncNow, saveAppProviders } = await import("../extension/sync.js");
```

Busca el bloque de la máquina A:

```js
// Máquina A: cuenta nueva, providers y una serie
use(A);
await set("supabase", { url: SB, anonKey: "anon" });
assert.equal((await signUp("dbranco@test.dev", "secreto123")).confirmed, true);
await set("providers", providers);
await set("providers_updated_at", new Date().toISOString());
await add({ provider: "mock", slug: "re-zero", title: "Re:Zero", link: "http://127.0.0.1:8001/blabla/re-zero", image: null });
await syncNow();
console.log("A subió providers y lista");
```

Sustitúyelo por:

```js
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
```

Busca el bloque de la máquina B justo después (inicia sesión con la misma cuenta que A —
sigue siendo admin, porque es el mismo `uid`):

```js
use(B);
await set("supabase", { url: SB, anonKey: "anon" });
await signIn("dbranco@test.dev", "secreto123");
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(live(await get("watchlist", [])).length, 1);
```

Sustitúyelo por:

```js
use(B);
await set("supabase", { url: SB, anonKey: "anon" });
await signIn("dbranco@test.dev", "secreto123");
await syncNow();
assert.equal((await get("providers", [])).length, 1);
assert.equal(await get("is_admin", false), true); // misma cuenta que A: también admin
assert.equal(live(await get("watchlist", [])).length, 1);
```

Por último, busca la línea final del archivo:

```js
console.log("TODO OK");
```

Sustitúyela por (el bloque nuevo de la máquina C, no-admin, seguido de la línea final):

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

console.log("TODO OK");
```

- [ ] **Step 5: Ejecutar la suite completa**

```bash
bash tests/run.sh
```

Expected: todo pasa, incluyendo la nueva línea `C (no admin) recibió providers en solo lectura y
no pudo escribir` y el resto de líneas existentes (`cron OK...`, `grupo: ...`, etc.) sin cambios.

- [ ] **Step 6: Commit**

```bash
git add extension/sync.js cron/generate-feed.mjs tests/mock_supabase.py tests/test-sync-cron.mjs
git commit -m "feat: providers como config de la app (app_config + admins) en sync y cron"
```

---

### Task 3: Extensión — Opciones solo-admin

**Files:**
- Modify: `extension/options.html`
- Modify: `extension/options.js`

**Interfaces:**
- Consume: `saveAppProviders` de `extension/sync.js` (Task 2), clave local `is_admin`.

- [ ] **Step 1: `options.html` — envolver la sección de providers**

Busca:

```html
<h2>Providers (JSON)</h2>
<p>Plantillas: <code>{base_url}</code> <code>{query}</code> <code>{slug}</code> <code>{episode}</code>.
Las regex van en JSON, así que las barras se duplican (<code>"(\\d+)/?$"</code>).
Al guardar, el navegador pide permiso para acceder al dominio de cada provider.</p>
<textarea id="json" spellcheck="false"></textarea>
<p>Comprobar cada <input id="interval" type="number" min="10" value="60" style="width:70px"> minutos (mínimo 10)</p>
<button id="save">Guardar providers</button><span id="status" class="st"></span>
```

Sustitúyelo por:

```html
<h2>Providers (JSON)</h2>
<div id="providersSection" hidden>
  <p>Plantillas: <code>{base_url}</code> <code>{query}</code> <code>{slug}</code> <code>{episode}</code>.
  Las regex van en JSON, así que las barras se duplican (<code>"(\\d+)/?$"</code>).
  Al guardar, el navegador pide permiso para acceder al dominio de cada provider.</p>
  <textarea id="json" spellcheck="false"></textarea>
  <button id="save">Guardar providers</button><span id="status" class="st"></span>
</div>
<p id="providersReadonly">Los providers los gestiona el admin de la app.</p>

<h2>Comprobación</h2>
<p>Comprobar cada <input id="interval" type="number" min="10" value="60" style="width:70px"> minutos (mínimo 10)</p>
<button id="saveInterval">Guardar</button><span id="intervalStatus" class="st"></span>
```

- [ ] **Step 2: `options.js` — import y `loadProviders` gatean por `is_admin`**

Busca:

```js
import { signIn, signUp, signOut, getSession } from "./sync.js";
```

Sustitúyela por:

```js
import { signIn, signUp, signOut, getSession, saveAppProviders } from "./sync.js";
```

Busca:

```js
async function loadProviders() {
  $("#json").value = JSON.stringify(await get("providers", []), null, 2);
  $("#interval").value = await get("interval", 60);
}
```

Sustitúyela por:

```js
async function loadProviders() {
  $("#json").value = JSON.stringify(await get("providers", []), null, 2);
  $("#interval").value = await get("interval", 60);
  const admin = await get("is_admin", false);
  $("#providersSection").hidden = !admin;
  $("#providersReadonly").hidden = admin;
}
```

- [ ] **Step 3: `options.js` — `$("#save")` usa `saveAppProviders`, `$("#saveInterval")` nuevo**

Busca:

```js
$("#save").onclick = () => {
  let arr;
  try {
    arr = JSON.parse($("#json").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { return status("JSON no válido: " + e.message, true); }

  // Debe llamarse directamente desde el clic (gesto del usuario)
  const origins = [...new Set(arr.map(p => { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }))];
  chrome.permissions.request({ origins }).then(async granted => {
    await set("providers", arr);
    await set("providers_updated_at", new Date().toISOString());
    await set("interval", Math.max(10, +$("#interval").value || 60));
    status(granted ? "Guardado y permisos concedidos." : "Guardado, pero SIN permiso a los dominios: las búsquedas fallarán.", !granted);
    try { if (await getSession()) { await requestSync(); renderSb(); } } catch (e) { status("Guardado, pero la sync falló: " + e.message, true); }
  });
};
```

Sustitúyelo por:

```js
$("#save").onclick = () => {
  let arr;
  try {
    arr = JSON.parse($("#json").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { return status("JSON no válido: " + e.message, true); }

  // Debe llamarse directamente desde el clic (gesto del usuario)
  const origins = [...new Set(arr.map(p => { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }))];
  chrome.permissions.request({ origins }).then(async granted => {
    try { await saveAppProviders(arr); }
    catch (e) { return status("Error al guardar: " + e.message, true); }
    status(granted ? "Guardado y permisos concedidos." : "Guardado, pero SIN permiso a los dominios: las búsquedas fallarán.", !granted);
    await loadProviders();
  });
};

$("#saveInterval").onclick = async () => {
  await set("interval", Math.max(10, +$("#interval").value || 60));
  $("#intervalStatus").textContent = "Guardado.";
};
```

- [ ] **Step 4: Verificación manual**

No hay test automático de UI en este proyecto (mismo criterio que el resto de `options.js`).
Verificación de sintaxis:

```bash
node --check extension/options.js
```

Deja anotado para probar más tarde en el navegador real: como admin, la sección de providers
aparece y guarda correctamente; como no-admin (otra cuenta sin fila en `admins`), la sección no
aparece y solo se ve "Los providers los gestiona el admin de la app."

- [ ] **Step 5: Commit**

```bash
git add extension/options.html extension/options.js
git commit -m "feat: Opciones oculta la edición de providers si no eres admin"
```

---

### Task 4: Extensión — permisos de Chrome en el primer uso (sin botón dedicado)

**Files:**
- Modify: `extension/popup.js`

**Interfaces:**
- Consume: `providers`/`prov()` ya presentes en `popup.js`, `chrome.permissions.request`.

- [ ] **Step 1: Helper `ensurePermissions` + mensaje de error actualizado**

Busca:

```js
const explain = e => e instanceof TypeError
  ? "No se pudo conectar. ¿Diste permiso al dominio? Vuelve a guardar el provider en Opciones."
  : e.message;

let providers = [];
const prov = id => providers.find(p => p.id === id);
```

Sustitúyelo por:

```js
const explain = e => e instanceof TypeError
  ? "No se pudo conectar. Puede que falte conceder permiso a ese dominio — vuelve a intentarlo."
  : e.message;

let providers = [];
const prov = id => providers.find(p => p.id === id);
function domainOrigin(p) { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }

// Pide permiso de Chrome para los dominios de los providers en uso, en el mismo gesto de clic
// que ya está en curso. Nadie más lo pide: el admin lo hace en Opciones al guardar, y a un
// usuario normal no le queda otro sitio donde hacerlo. Si ya estaba concedido no muestra nada.
async function ensurePermissions(extraId) {
  const list = live(await get("watchlist", []));
  const ids = new Set(list.map(w => w.provider));
  if (extraId) ids.add(extraId);
  const origins = [...new Set([...ids].map(id => prov(id)).filter(Boolean).map(domainOrigin))];
  if (!origins.length) return;
  try { await chrome.permissions.request({ origins }); } catch { /* el fetch fallará y explain() lo explica */ }
}
```

- [ ] **Step 2: Llamar a `ensurePermissions` en cada acción que usa un provider**

Busca:

```js
$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  const p = prov($("#prov").value);
  if (!q || !p) return;
  msg("Buscando…");
```

Sustitúyelo por:

```js
$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  const p = prov($("#prov").value);
  if (!q || !p) return;
  await ensurePermissions(p.id);
  msg("Buscando…");
```

Busca:

```js
async function checkNext(item, st) {
  const p = prov(item.provider);
  const n = (item.last || 0) + 1;
  st.textContent = "Comprobando…";
```

Sustitúyelo por:

```js
async function checkNext(item, st) {
  const p = prov(item.provider);
  await ensurePermissions();
  const n = (item.last || 0) + 1;
  st.textContent = "Comprobando…";
```

Busca (dentro de `renderList`):

```js
          btn("Episodios", async () => {
            eps.textContent = "Cargando…";
            try {
```

Sustitúyelo por:

```js
          btn("Episodios", async () => {
            await ensurePermissions();
            eps.textContent = "Cargando…";
            try {
```

Busca:

```js
$("#all").onclick = async () => {
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderList(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};
```

Sustitúyelo por:

```js
$("#all").onclick = async () => {
  await ensurePermissions();
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderList(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};
```

Busca (dentro de `renderGroups`):

```js
                btn("Siguiente", async () => {
                  const p = prov(cur.step.provider);
                  st.textContent = "Comprobando…";
                  try {
                    const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
```

Sustitúyelo por:

```js
                btn("Siguiente", async () => {
                  const p = prov(cur.step.provider);
                  await ensurePermissions(cur.step.provider);
                  st.textContent = "Comprobando…";
                  try {
                    const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
```

Busca (dentro de `renderEpisodePanel`):

```js
        p ? btn("▶ Ver aquí", async () => {
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, sel.step.slug, sel.episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
```

Sustitúyelo por:

```js
        p ? btn("▶ Ver aquí", async () => {
              await ensurePermissions(sel.step.provider);
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, sel.step.slug, sel.episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
```

- [ ] **Step 3: Verificación**

```bash
node --check extension/popup.js
bash tests/run.sh
```

Expected: sintaxis correcta y la suite entera sigue en verde (este archivo no tiene test
automático propio, pero no debe romper nada de lo existente).

- [ ] **Step 4: Commit**

```bash
git add extension/popup.js
git commit -m "feat: permisos de Chrome por dominio en el primer uso, sin botón dedicado"
```

---

### Task 5: PWA — Config solo-admin

**Files:**
- Modify: `web/index.html`
- Modify: `web/app.js`

**Interfaces:**
- Consume: `saveAppProviders` de `extension/sync.js` (Task 2), clave local `is_admin`.

- [ ] **Step 1: `index.html` — la pestaña Config empieza oculta**

Busca:

```html
    <div class="tabs">
      <button id="tabAll" class="active">Todo</button>
      <button id="tabGroups">Grupos</button>
      <button id="tabConfig">Config</button>
    </div>
```

Sustitúyelo por:

```html
    <div class="tabs">
      <button id="tabAll" class="active">Todo</button>
      <button id="tabGroups">Grupos</button>
      <button id="tabConfig" hidden>Config</button>
    </div>
```

- [ ] **Step 2: `app.js` — import y `applyAdminVisibility`**

Busca:

```js
import { signIn, signUp, signOut, getSession, syncNow } from "../extension/sync.js";
```

Sustitúyela por:

```js
import { signIn, signUp, signOut, getSession, syncNow, saveAppProviders } from "../extension/sync.js";
```

Busca:

```js
async function sync(quiet = true) {
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders(); await renderList(); await renderFeed();
    if (!$("#groupsView").hidden) renderGroups();
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) $("#authMsg").textContent = "Error de sync: " + explain(e);
  }
}
```

Sustitúyelo por:

```js
async function applyAdminVisibility() {
  const admin = await get("is_admin", false);
  $("#tabConfig").hidden = !admin;
  if (!admin && !$("#configView").hidden) setView("all"); // no lo dejamos varado si deja de ser admin
}

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

- [ ] **Step 3: `app.js` — `$("#saveProvidersBtn")` usa `saveAppProviders`**

Busca:

```js
$("#saveProvidersBtn").onclick = async () => {
  let arr;
  try {
    arr = JSON.parse($("#providersJson").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  await set("providers", arr);
  await set("providers_updated_at", new Date().toISOString());
  await fillProviders();
  $("#configMsg").textContent = "Guardado.";
  try { await requestSync(); } catch (e) { $("#configMsg").textContent = "Guardado, pero la sync falló: " + explain(e); }
};
```

Sustitúyelo por:

```js
$("#saveProvidersBtn").onclick = async () => {
  let arr;
  try {
    arr = JSON.parse($("#providersJson").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  try { await saveAppProviders(arr); }
  catch (e) { $("#configMsg").textContent = "Error al guardar: " + explain(e); return; }
  await fillProviders();
  $("#configMsg").textContent = "Guardado.";
};
```

- [ ] **Step 4: Verificación**

```bash
node --check web/app.js
```

Deja anotado para probar más tarde en el navegador: como admin, la pestaña Config aparece tras
sincronizar y guarda correctamente; como no-admin, la pestaña no aparece nunca.

- [ ] **Step 5: Commit**

```bash
git add web/index.html web/app.js
git commit -m "feat: PWA oculta la pestaña Config si no eres admin"
```

---

### Task 6: README + verificación final

**Files:**
- Modify: `README.md`

**Interfaces:** Ninguna — solo documentación.

- [ ] **Step 1: Actualizar la fila de la tabla de piezas**

Busca:

```
| `supabase/schema.sql` | Tablas + RLS para tener lista y providers en todas tus máquinas |
```

Sustitúyela por:

```
| `supabase/schema.sql` | Tablas + RLS: lista y grupos por usuario, providers compartidos por toda la app |
```

- [ ] **Step 2: Actualizar el paso 2 de la sección Extensión**

Busca:

```
2. ⚙ Opciones: edita el provider (JSON) y guarda (acepta el permiso del dominio).
```

Sustitúyela por:

```
2. Solo la cuenta admin edita providers (⚙ Opciones en la extensión, o Config en la PWA): pega
   el JSON y guarda (acepta el permiso del dominio). El resto de cuentas los reciben ya listos
   al sincronizar — ver "Providers como config de la app" más abajo.
```

- [ ] **Step 3: Añadir la subsección de admin**

Busca:

```
Conflictos: gana el cambio más reciente (`updated_at`). Los borrados se propagan (`deleted`).

### Grupos
```

Sustitúyela por:

```
Conflictos: gana el cambio más reciente (`updated_at`). Los borrados se propagan (`deleted`).

### Providers como config de la app

`providers` (qué sitios sabe scrapear la app) no es por usuario: es una configuración
compartida que mantiene una cuenta admin. El resto de cuentas la reciben en solo lectura al
sincronizar — ni siquiera ven la sección en Opciones/Config.

Para marcarte admin (una vez, por SQL Editor, después de ejecutar `supabase/schema.sql`):

\`\`\`sql
insert into admins (user_id) select id from auth.users where email = 'tu@email.com';
\`\`\`

Luego, en Opciones (extensión) o Config (PWA), pega el JSON de tus providers y Guardar. Ver
`docs/superpowers/specs/2026-09-26-app-wide-providers-design.md` para el detalle completo.

### Grupos
```

- [ ] **Step 4: Verificación final de todo el repo**

```bash
bash tests/run.sh
node --check extension/sync.js && node --check extension/popup.js && node --check extension/options.js && node --check web/app.js
git status --short
```

Expected: suite completa en verde, sin errores de sintaxis, y `git status` solo muestra los
archivos tocados por este plan (más lo que ya estuviera pendiente de antes, como
`.env.example`/`db-migrate.yml`, que este plan no toca).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README explica providers como config de la app y el alta de admin"
```
