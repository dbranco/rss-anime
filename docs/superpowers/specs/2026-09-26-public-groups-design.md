# Grupos públicos + lista unificada — diseño

**Fecha:** 2026-09-26

## Contexto y objetivo

Hoy un grupo (playlist de orden de visionado) es 100% privado: solo lo ve y edita quien
lo creó. El objetivo es que un grupo pueda hacerse público, que otras personas lo
descubran, se suscriban a él y lo valoren — sin dejar de trackear su propio progreso de
forma individual, igual que ya pasa con `watchlist`.

Decisiones ya tomadas con el usuario:
- Suscribirse **no copia** el grupo: lees el original en vivo. Tu progreso es tuyo.
- Valoración: estrellas 1-5.
- Visibilidad: la eliges por grupo (público/privado), no es un ajuste global.
- Al suscribirte, se repara automáticamente (como ya hace "Reparar" hoy) — puedes marcar
  progreso desde el primer momento.
- Los grupos públicos se descubren en una pestaña/vista nueva "Explorar", no mezclados
  silenciosamente en tu propia lista.

## Alcance

**Dentro:**
- `groups` gana visibilidad pública/privada, elegible por grupo.
- Suscribirse/darse de baja de un grupo ajeno; sincronizado entre tus máquinas.
- Valorar un grupo público (1-5 estrellas), una valoración por persona y grupo.
- Vista "Explorar": buscar grupos públicos por nombre, ordenados por valoración media,
  paginados de 10 en 10.
- Vista principal unificada: "Mi lista" + "Grupos" (propios y a los que estás suscrito) se
  fusionan en una sola lista filtrable (Media / Listas de reproducción / Ambos) y
  paginada de 10 en 10.
- El cron también revisa episodios nuevos de los grupos a los que estás suscrito, no solo
  los tuyos, para tu feed RSS.
- Auto-reparación (crear las entradas de lista que falten) al suscribirte.

**Fuera de alcance (YAGNI):**
- Comentarios o reseñas de texto en un grupo (solo estrellas).
- Quitar tu valoración (puedes cambiarla volviendo a valorar, no borrarla).
- Categorías/géneros para explorar más allá de la búsqueda por nombre.
- Moderación/reporte de contenido público — a esta escala, quien lo hace público asume
  que cualquiera con cuenta puede verlo.
- Transferir la propiedad de un grupo a otra persona.
- Portada/imagen propia del grupo (sigue usando los avatares de sus títulos, como hoy).

## Datos (Supabase)

```sql
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

-- Una fila por persona y grupo. La media se calcula al leer (no hay columna de media).
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

`"own groups"` (la política `for all` que ya existe) sigue dando al dueño lectura y
escritura total de sus propios grupos; `"read public groups"` añade, solo para SELECT,
que cualquier autenticado vea los que son públicos. Ambas se combinan con OR — un
grupo público sigue siendo editable solo por su dueño.

No hay vista SQL para la media de valoraciones: se calculan en el cliente sobre las
filas crudas que trae `group_ratings` (a esta escala, docenas de grupos como mucho, es
más simple que mantener una vista y no complica el modelo de RLS).

## Cliente: `extension/groups.js`

Nuevas funciones, junto a las que ya existen:

```js
export async function setPublic(groupId, isPublic) { /* mutate local group.public + updated_at */ }
export async function subscribe(ownerId, groupId) { /* añade fila en subscriptions locales */ }
export async function unsubscribe(ownerId, groupId) { /* deleted = true */ }
```

`live(groups)` sigue filtrando por `deleted`; se añade el mismo patrón para
`liveSubscriptions`.

## Cliente: `extension/sync.js`

- `syncGroups` no cambia de forma (sigue sincronizando solo TUS grupos, ahora con el
  campo `public` incluido en el payload).
- `syncSubscriptions(uid)`: mismo patrón merge-por-`updated_at` que `syncGroups`, sobre
  `group_subscriptions`.
- `refreshSubscribedGroups(uid)`: tras sincronizar las suscripciones, para cada una viva
  hace `GET groups?select=*&user_id=eq.<owner_id>&id=eq.<group_id>` y guarda el resultado
  en una clave local nueva de **solo lectura**, `subscribed_groups` (no se sube nunca,
  se sobrescribe entera en cada sync). Si el grupo original se volvió privado o se borró,
  simplemente deja de aparecer en esa lista — no hace falta un caso especial.
- Al suscribirte (acción explícita del usuario, no en cada sync): además de escribir la
  fila de suscripción, se llama a la misma lógica que hoy usa "Reparar"
  (`missingSteps`/`repairGroup` de `popup.js`/`app.js`) sobre el grupo recién traído, para
  crear las entradas de lista que falten.
- `export async function searchPublicGroups(query)`: `GET groups?select=*&public=eq.true&name=ilike.*<query>*`
  trae TODOS los que matchean (sin paginar en SQL — a esta escala no hace falta), luego
  `GET group_ratings?select=owner_id,group_id,stars&owner_id=in.(...)&group_id=in.(...)`
  para calcularles la media en JS y ordenar el array por ella antes de devolverlo. La
  paginación de 10 en 10 se hace después, en la UI, troceando ese array ya ordenado —
  mismo patrón que ya usa la paginación del itinerario de un grupo.
- `export async function rateGroup(ownerId, groupId, stars)`: upsert directo (como
  `saveAppProviders`), sin caché local — se re-consulta la media al volver a listar.

## Cliente: `cron/generate-feed.mjs`

Además de `groups` (propios), lee también `group_subscriptions` y resuelve, para cada
suscripción viva, el grupo original (`GET groups?...&user_id=eq.<owner_id>&id=eq.<group_id>`)
para poder revisar su `currentStep` igual que ya hace con los propios. Los episodios
nuevos se añaden al feed del SUSCRIPTOR (su propio `user_id` en `episodes_found`), nunca
al del dueño del grupo.

## UI: vista principal unificada

`popup.html`/`index.html`: las pestañas "Todo" / "Grupos" se sustituyen por una sola
lista con un filtro (radio o checkboxes: **Media**, **Listas**, **Ambos** — por defecto
Ambos) y paginación de 10 en 10. Cada fila de "lista" es una tarjeta de serie (como hoy)
o una tarjeta de grupo (como hoy), mezcladas y ordenadas por `updated_at` descendente.
Un grupo al que estás suscrito se distingue visualmente de uno propio (ej. una etiqueta
"de @autor") y no muestra las acciones de editar/borrar — solo ver, marcar progreso y
"Darse de baja".

`Config` (pestaña admin-only) no cambia, sigue aparte.

## UI: pestaña "Explorar" (nueva)

Buscador de texto + lista paginada de 10 en 10 de grupos públicos (nombre, autor —email
o "anónimo" si prefieres no mostrarlo, valoración media con nº de valoraciones, avatares
de sus títulos). Cada tarjeta tiene "Suscribirme" (si no lo estás ya) y un selector de
estrellas para valorar. Mismo componente en extensión y PWA, como el resto de vistas.

## Errores y casos borde

- Un grupo se vuelve privado con gente ya suscrita: siguen viendo su copia de progreso
  (su `watchlist` no se borra), pero `refreshSubscribedGroups` deja de traer sus datos
  (la política RLS ya no lo permite) — su tarjeta pasa a mostrar "grupo ya no disponible"
  en vez de reventar, igual que hoy pasa con un paso cuyo ítem se borró de la lista.
- Suscribirte dos veces al mismo grupo: `primary key (user_id, owner_id, group_id)` en
  Postgres y el propio merge-por-`updated_at` en el cliente lo hacen idempotente.
- Valorar dos veces: upsert por `primary key`, la segunda sustituye a la primera (cambiar
  de opinión, no acumular).
- Búsqueda en Explorar sin resultados: mensaje igual que el resto de búsquedas de la app.
- El cron encuentra un episodio nuevo en un grupo al que el usuario ya no está suscrito
  (se dio de baja entre pasadas del cron): se filtra igual que ya se filtra `watchlist`
  por `deleted`/pertenencia — solo se procesan suscripciones vivas en esa pasada.

## Testing

`tests/mock_supabase.py` necesita el mismo tipo de caso especial que `app_config`: lectura
abierta de `groups` donde `public=true` (hoy filtra todo por `user_id`), y lectura abierta
de `group_ratings`. `group_subscriptions` no necesita caso especial (ya tiene `user_id`,
el filtro genérico por dueño ya es correcto).

`tests/test-sync-cron.mjs` gana un bloque: una segunda cuenta hace público uno de los
grupos de la primera, la tercera cuenta (la "C" no-admin ya existente) lo encuentra por
`searchPublicGroups`, se suscribe, verifica que se reparó su lista sola, marca un
episodio visto y confirma que el progreso de C y de A quedan separados. Se añade también
una comprobación de que el cron encuentra un episodio nuevo del grupo suscrito en el feed
de C.
