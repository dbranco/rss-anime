# Providers a nivel de app (no por usuario) — diseño

**Fecha:** 2026-09-26

## Contexto y objetivo

Hoy `providers` (el JSON que describe cómo scrapear cada sitio) vive en
`user_settings.providers`, una columna por usuario sincronizada con el mismo
mecanismo que `watchlist`/`groups` (gana el `updated_at` más reciente). Cada
usuario nuevo empieza sin providers y tiene que pegarlos a mano.

Objetivo: que `providers` sea una configuración **de la app**, compartida por
todos los usuarios, mantenida por una cuenta admin. Un usuario nuevo se
registra y ya tiene todos los providers disponibles sin configurar nada. Su
`watchlist` y sus `groups` siguen siendo 100% individuales — eso no cambia.

## Alcance

**Dentro:**
- Tabla compartida `app_config` (una fila) con los providers.
- Tabla `admins` (lista de `user_id`) para decidir quién puede escribir.
- RLS: lectura abierta a cualquier usuario autenticado, escritura solo admin.
- Extensión y PWA: la sección/pestaña "Config" (editor JSON) solo se
  renderiza si el usuario es admin. Para el resto, no existe en la UI.
- La extensión sigue necesitando permiso de Chrome (`host_permissions`) por
  dominio para poder hacer `fetch` a cada provider — se pide de forma
  transparente en el primer uso real (Buscar/Siguiente/Comprobar), no en un
  botón dedicado.
- Migración SQL (`supabase/schema.sql` + `supabase/migrations/`).
- Alta del primer admin: paso manual por SQL Editor (no vía migración con
  el email de nadie hardcodeado).

**Fuera de alcance (YAGNI):**
- UI para gestionar admins (se añaden/quitan por SQL Editor).
- Providers por-usuario como override del global (todos ven la misma lista).
- Editor de providers como formulario estructurado (sigue siendo un textarea
  JSON, igual que ahora).
- Borrar la columna `user_settings.providers`: se deja de usar pero no se
  elimina la columna (evita una migración destructiva sin necesidad real).

## Datos (Supabase)

```sql
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

drop policy if exists "admin write app config" on public.app_config;
create policy "admin write app config" on public.app_config
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
```

No hay política de insert/delete en `admins` vía API: se gestiona a mano por
SQL Editor con la cuenta de Postgres (bypassa RLS), igual que ya haces con el
resto del schema.

`app_config` no se pre-siembra con una fila: el cliente trata "sin fila" como
`providers: []`, igual que hoy hace con una fila ausente de `user_settings`.
La primera vez que el admin guarda, esa fila se crea (`upsert` con
`on_conflict=id`).

## Cliente: `extension/sync.js`

Se retira la parte de `providers` de `syncSettings` (que pasa a encargarse
solo de `feed_token`) y se añade una función nueva:

```js
async function syncAppConfig(uid) {
  const [row] = await rest("app_config?select=providers,updated_at&id=eq.1");
  await set("providers", row?.providers || []);
  await set("providers_updated_at", row?.updated_at || null);
  const adminRows = await rest(`admins?select=user_id&user_id=eq.${uid}`);
  await set("is_admin", adminRows.length > 0);
}

export async function saveAppProviders(arr) {
  const s = await session();
  await rest("app_config?on_conflict=id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ id: 1, providers: arr, updated_at: now() }]
  });
  await set("providers", arr);
  await set("providers_updated_at", now());
  void s; // solo para forzar sesión válida antes de escribir
}
```

`syncSettings` (renombrada a lo que hace de verdad, `syncFeedToken`) se queda
solo con el `upsert` de `user_settings` para asegurar que la fila exista y
leer `feed_token`, sin tocar `providers`.

`syncNow()` pasa a llamar a `syncAppConfig(uid)` en vez de la parte de
providers de la antigua `syncSettings`.

Si `saveAppProviders` recibe un 403 (RLS rechaza porque no eres admin — no
debería poder llegar aquí desde la UI, pero es la red de seguridad), se
propaga el error tal cual para que la UI lo muestre.

## Extensión: permisos de Chrome sin botón dedicado

`popup.js` ya tiene los puntos de entrada que usan un provider: `$("#go")`
(Buscar), "Siguiente", "Episodios", "Comprobar todos". Cada uno de estos
handlers, como primera línea (antes de cualquier `await`, para conservar el
gesto de usuario), pide el permiso del dominio del provider implicado:

```js
function domainOrigin(p) { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }
function ensurePermission(p) { return chrome.permissions.request({ origins: [domainOrigin(p)] }); }
```

Si el permiso ya estaba concedido, `chrome.permissions.request` resuelve
`true` sin mostrar ningún diálogo — no hay coste para el admin (que ya
concedió todo al guardar) ni para un no-admin que repite una búsqueda con el
mismo provider.

`options.js` mantiene su lógica de `chrome.permissions.request` con el
conjunto completo de orígenes, pero solo se ejecuta (y el botón "Guardar"
solo existe) cuando `is_admin` es `true`.

## UI: sección Config solo para admin

**Extensión (`options.html`/`options.js`):** la sección "Providers (JSON)"
completa (textarea + botón Guardar) se oculta con `hidden` si
`!(await get("is_admin", false))`. Nada de textarea de solo lectura: si no
eres admin, esa sección no existe.

**PWA (`index.html`/`app.js`):** el botón `#tabConfig` y la vista
`#configView` se ocultan igual, condicionados a `is_admin`. Se comprueba
tras `showMain()` (ya se hizo `syncAppConfig` dentro del primer `sync()`).

El guardado (ambos sitios) usa `saveAppProviders()` de `sync.js` en vez del
`set("providers", arr)` + upsert manual de antes; conserva toda la
validación existente (JSON válido, campos requeridos, `slug_regex`, URL
válida) sin cambios.

## Cron: `cron/generate-feed.mjs`

Hoy el cron lee `providers` **por usuario** desde `user_settings` (con la
service key, que bypassa RLS) y usa la lista de cada fila para resolver los
providers de sus propios items. Al dejar de escribir `providers` en
`user_settings`, esa lista quedaría vacía para todos y el cron dejaría de
encontrar episodios nuevos.

Cambio: leer `app_config` **una vez**, fuera del bucle por usuario, y usar
esa misma lista para todos:

```js
const [appConfig] = await rest("app_config?select=providers&id=eq.1");
const providers = appConfig?.providers || [];
const settings = await rest("user_settings?select=user_id,feed_token"); // ya no pide providers
```

Dentro del bucle `for (const st of settings)` se elimina la línea
`const providers = st.providers || [];` (ahora `providers` es la constante
de fuera, compartida). El resto del cron no cambia: sigue resolviendo el
provider de cada item con `providers.find(x => x.id === it.provider_id)`.

## Migración

Nuevo archivo `supabase/migrations/20260926130000_app_providers.sql` con el
SQL de la sección "Datos" de arriba, y la misma sección añadida a
`supabase/schema.sql` (se mantienen ambos en sync a mano, como ya se hace).

Pasos manuales para ti (documentados en el plan, no automatizados):
1. Ejecutar la migración (SQL Editor o `supabase db push`).
2. Marcarte admin: `insert into admins (user_id) select id from auth.users where email = 'TU_EMAIL';`
3. Entrar a Opciones/Config (ya visible) y pegar el JSON combinado de
   providers que ya tienes (AnimeAV1 + AnimeFlix) → Guardar.

## Testing

`tests/mock_supabase.py` no modela RLS de verdad (es un fake simplificado
que filtra por `user_id` en cada fila). Se le añaden dos casos especiales
solo para `app_config`:
- `GET`: no se filtra por `user_id` (lectura abierta a cualquier "user").
- `POST` (upsert): si `kind == "user"`, se exige que el uid esté en
  `TABLES["admins"]`; si no, `403`. Sembrar `admins` en el test se hace con
  la service key (`Authorization: Bearer service-key`), que ya bypassa el
  chequeo de ownership — igual que en Postgres real un superusuario bypassa
  RLS.

`tests/test-sync-cron.mjs` gana un bloque nuevo: máquina admin guarda
providers vía `saveAppProviders`, máquina no-admin sincroniza y los recibe
en modo lectura (`is_admin` es `false`), y un intento de escritura desde la
máquina no-admin es rechazado con el error de `saveAppProviders` propagado.

## Errores y casos borde

- Usuario nuevo sin fila en `admins`: `adminRows.length === 0` → `is_admin
  = false`. Comportamiento correcto por defecto (no-admin).
- `app_config` sin fila todavía (antes del primer guardado del admin):
  `providers: []` en todo el mundo, incluido el propio admin hasta que
  guarde por primera vez.
- Dominio de un provider nuevo añadido por el admin: al no-admin se le pide
  el permiso de Chrome la próxima vez que use ESE provider concreto (no
  antes) — no hay lista global de "todos los dominios conocidos" que pedir
  de golpe para el no-admin.
