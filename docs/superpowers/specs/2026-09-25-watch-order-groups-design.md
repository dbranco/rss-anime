# Grupos de orden de visionado ("playlists")

## Motivación

Series Tracker ya sabe buscar, guardar y trackear series episodio a episodio (`extension/list.js`, `extension/engine.js`), pero cada ítem de la lista vive por su cuenta. No hay forma de decir "quiero ver Star Wars en orden cronológico: películas 4-6, luego la serie animada, luego 1-3", mezclando varios ítems ya guardados con un orden y unas reglas propias (rangos de episodios, exclusión de fillers).

Este documento diseña **grupos**: una capa que reordena y filtra ítems que el usuario ya tiene en su lista (`watchlist`), sin introducir un tipo de dato nuevo para "películas" ni tocar cómo se buscan/trackean series individualmente.

## Alcance

Dentro:
- Crear/editar/borrar grupos con una secuencia ordenada de pasos.
- Cada paso referencia un ítem ya existente en `watchlist` (por `provider`+`slug`) y un rango de episodios `[from, to]` con exclusiones opcionales.
- El progreso del grupo se deriva del campo `last` de cada ítem (no hay contador de progreso aparte); marcar "visto" desde el grupo actualiza el mismo `last` que usa el resto de la app.
- Sincronización entre dispositivos vía Supabase, igual que `watchlist`.
- UI en el popup de la extensión y en la PWA: una vista nueva "Grupos" junto a la vista actual ("Todo").
- El cron (`cron/generate-feed.mjs`) y el chequeo en segundo plano (`extension/background.js`) detectan cuándo el episodio que un grupo necesita a continuación ya está disponible, y lo notifican/publican en el feed con el nombre del grupo.

Fuera (YAGNI, se puede añadir después si hace falta):
- Un tipo de ítem "película" distinto de una serie episódica. Las películas se añaden como cualquier otro ítem (buscadas en algún provider) con un paso de grupo `from:1, to:1`.
- Edición de grupos desde Opciones — vive en popup/PWA junto al resto de "tus datos", igual que la lista. Opciones se queda como configuración (providers, Supabase).
- Validación de rangos solapados o hacia atrás entre pasos del mismo ítem — si el usuario define algo así, el resultado es "raro pero no rompe nada" (ver Casos límite).
- Reordenar arrastrando (drag & drop) — se usan botones ↑↓, consistente con el resto de la UI (sin dependencias nuevas).

## Modelo de datos

### Tabla `groups` (nueva, en `supabase/schema.sql`)

```sql
create table if not exists public.groups (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id         text not null,               -- generado en el cliente (crypto.randomUUID())
  name       text not null,
  steps      jsonb not null default '[]'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.groups enable row level security;

create policy "own groups" on public.groups
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

Borrado lógico (`deleted`), igual que `watchlist`, para que se propague entre máquinas.

### Forma de un paso (elemento de `steps`)

```json
{ "provider": "animeav1", "slug": "rezero-kara-hajimeru-isekai-seikatsu", "from": 21, "to": 50, "exclude": [25] }
```

- `from`/`to`: enteros, 1-indexados. Por defecto `1`/`1` al añadir un paso sin tocarlos (cubre el caso "ítem de una sola pieza", como una película).
- `exclude`: array opcional de números dentro de `[from, to]` a saltar (fillers). Ausente o vacío si no aplica.

Local (storage/localStorage vía `store.js`), la lista de grupos del usuario se guarda bajo la clave `"groups"`, mismo patrón que `"watchlist"`.

## Sincronización

Nueva función `syncGroups(uid)` en `extension/sync.js`, calcada de `syncWatchlist` (`extension/sync.js:106-133`):

- Lee `groups?select=*&user_id=eq.{uid}` remoto.
- Merge local↔remoto por `id`, gana el `updated_at` más reciente fila a fila.
- Push de las filas locales más nuevas vía `POST groups?on_conflict=user_id,id` con `resolution=merge-duplicates`.
- Mismo guard de "si la lista local cambió mientras sincronizábamos, no la pisamos" que ya tiene `syncWatchlist`.

`syncNow()` pasa a llamar `syncSettings`, `syncWatchlist` y `syncGroups`.

## Progreso: módulo `extension/groups.js` (nuevo, análogo a `list.js`)

Funciones puras + CRUD sobre `store.js`, igual que `list.js`:

```js
export const live = list => list.filter(g => !g.deleted);

export function currentStep(group, watchlist) {
  for (const step of group.steps) {
    const item = watchlist.find(w => w.provider === step.provider && w.slug === step.slug);
    const last = item?.last || 0;
    const next = nextNeeded(step, last);
    if (next != null) return { step, item, next }; // `next` es null si el paso ya está
    // cubierto (last >= to, o solo quedaban excluidos): sigue al siguiente paso.
  }
  return null; // grupo completo (o sin pasos)
}

function nextNeeded(step, last) {
  const exclude = new Set(step.exclude || []);
  for (let n = Math.max(step.from, last + 1); n <= step.to; n++) {
    if (!exclude.has(n)) return n;
  }
  return null; // ya visto hasta `to`, o solo quedaban excluidos: paso completo
}
```

`add`/`update`/`remove` de grupos y de pasos siguen el mismo patrón que `list.js::add`/`mutate` (mutar el array, re-sellar `updated_at`, `set("groups", ...)`).

Marcar "visto" desde un grupo llama a `list.js::mutate(step.provider, step.slug, x => { x.last = next })` — el mismo `mutate` que ya existe, sin cambios. Como `last` es compartido, esto también actualiza lo que ve la vista "Todo", el cron y las notificaciones normales.

## UI

### Navegación (popup y PWA)

Un toggle arriba de la lista, junto al título: **Todo** | **Grupos**. "Todo" es la vista actual sin cambios. "Grupos" es nueva.

### Vista "Grupos"

Por cada grupo, una tarjeta:
- Nombre del grupo.
- Si `currentStep` devuelve algo: "Paso X de Y: {título del ítem} — episodio {next}", botones **Siguiente** (reutiliza `engine.checkEpisode`, igual que hoy) y **Visto** (aplica `mutate` con `x.last = next` y vuelve a pintar la tarjeta, que salta sola al siguiente paso si este se completó).
- Si `currentStep` devuelve `null`: "✓ Terminado".
- Si el paso actual referencia un ítem que ya no está en la lista (borrado): "⚠ {provider}/{slug} ya no está en tu lista" en vez de los botones, sin bloquear el resto del grupo.

Botón **＋ Nuevo grupo**: nombre + filas repetibles (selector de ítem de tu lista actual + `desde`/`hasta` con `1`/`1` por defecto + `excluir` opcional) + ＋ Añadir paso, con ↑↓/✕ por paso ya añadido. **Guardar grupo** persiste y sincroniza.

## Cron y notificaciones

### `extension/background.js`

Tras el `checkAll()` actual (por ítem), un `checkGroups()` nuevo:

```js
for (const g of live(await get("groups", []))) {
  const cur = currentStep(g, watchlist);
  if (!cur?.next) continue;
  const p = providers.find(x => x.id === cur.step.provider); // mismo patrón que checkAll()
  if (!p) continue;
  const r = await callOffscreen("checkEpisode", p, cur.step.slug, cur.next);
  if (!r.exists) continue;
  const id = `group-${g.id}-e${cur.next}`;
  if (notified.includes(id)) continue;
  // notificar + empujar a `news`, título: `${g.name}: ${cur.item.title} — episodio ${cur.next}`
}
```

Id de notificación con prefijo `group-` para no chocar con los ids `${provider}-${slug}-e${n}` que ya usa el chequeo por ítem (puede notificar el mismo episodio dos veces, una vez por ítem y otra por grupo, si aplica a ambos — es deseado: son avisos con contexto distinto).

### `cron/generate-feed.mjs`

Mismo chequeo, server-side: se añade `rest("groups?select=*&deleted=eq.false")` junto a las lecturas de `watchlist`/`episodes_found` que ya existen (línea 62-64), y por cada grupo con paso actual disponible se inserta en `episodes_found` con el mismo `(user_id, provider_id, slug, episode)` — que ya dedupea si el chequeo normal del ítem detectó el mismo episodio — y se añade al RSS con el nombre del grupo en el título.

## Casos límite

- **Pasos solapados o en orden inverso para el mismo ítem** (p. ej. paso 1 pide episodios 21-50 y paso 2, más adelante en la lista, pide 1-20 del mismo ítem): no se valida. El resultado es que `currentStep` encuentra "completo" el primer paso solo cuando `last` alcance 50, así que el paso 2 nunca se marca como actual hasta que el 1 lo esté — probablemente no es el orden que el usuario quería, pero no rompe nada. Se puede añadir validación más adelante si molesta en la práctica.
- **`exclude` fuera de `[from, to]`**: no-op, se ignora.
- **Grupo sin pasos**: `currentStep` devuelve `null` → se muestra como "✓ Terminado" (caso borde aceptable; alternativa sería "vacío", detalle de implementación sin impacto en el diseño).
- **Mismo ítem en dos grupos distintos**: sin conflicto, ambos leen/escriben el mismo `last` compartido; es el comportamiento esperado (si lo ves por un grupo, cuenta para el otro también).

## Testing

- `tests/test-groups.mjs` (nuevo): prueba `currentStep`/`nextNeeded` como funciones puras (sin red) — casos: paso simple, exclusión, paso completo, grupo completo, ítem borrado.
- `tests/test-sync-cron.mjs`: se extiende el escenario de dos "máquinas" para incluir un grupo, comprobando que se sincroniza igual que `watchlist` (sube, baja, borrado).
- Verificación manual del cron generando un item de feed con nombre de grupo, contra el mock site/mock Supabase ya existentes.

## Archivos que toca

`supabase/schema.sql`, `extension/sync.js`, `extension/groups.js` (nuevo), `extension/background.js`, `extension/popup.html`/`popup.js`, `web/index.html`/`app.js`, `cron/generate-feed.mjs`, `tests/test-groups.mjs` (nuevo), `tests/test-sync-cron.mjs`.
