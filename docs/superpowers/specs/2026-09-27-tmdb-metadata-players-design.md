# TMDB como fuente de metadata + providers de reproducción pluggables

**Fecha:** 2026-09-27
**Estado:** Aprobado en brainstorming, pendiente de plan de implementación.

## Motivación

Hoy un "provider" hace tres cosas a la vez, todas scrapeando el mismo sitio:
buscar título/imagen, listar episodios, y reproducir. Eso significa que
seguir la misma serie en dos idiomas requiere configurar y buscar en dos
sitios completamente independientes, la metadata (título, imagen, número de
episodios) es tan frágil como el HTML del sitio que la scrapea, y un ítem
del watchlist solo puede tener UNA fuente de reproducción a la vez.

TMDB resuelve la parte de metadata con una API real (no scraping), ya
multi-idioma de fábrica. Este diseño separa esa responsabilidad de la
reproducción: TMDB pasa a ser la única fuente de búsqueda/metadata/listado
de episodios; los sitios de scraping de hoy se reducen a "adaptadores de
reproducción" puros, organizados por idioma y pista (sub/dub), y un ítem
puede tener varias fuentes de reproducción configuradas sin que ninguna sea
"la" fuente fija.

## Modelo de datos: identidad del ítem

La identidad de un ítem del watchlist pasa de `{provider, slug}` a
`tmdb_id`. Los pasos de grupo (`groups.steps`) también referencian
`tmdb_id` en vez de `{provider, slug}`.

```js
{
  tmdb_id: 128729,
  media_type: "tv",              // o "movie"
  title: "Re:Zero",               // de TMDB, en el idioma base del usuario
  poster_path: "/abc123xyz.jpg",  // NO la URL completa — ver "Imagen" abajo
  last: 12,                       // episodios vistos, sin cambios respecto a hoy
  players: {                      // caché de "última combinación elegida", no una fijación
    "es|sub": { providerId: "animeav1", slug: "re-zero" },
    "es|dub": { providerId: "animeav2", slug: "rezero-castellano" }
  },
  updated_at, visible, deleted    // sin cambios respecto a hoy
}
```

No se guarda sinopsis (texto pesado, casi nunca se muestra, se puede pedir
a TMDB al vuelo por `tmdb_id` si algún día hace falta — sería duplicidad
innecesaria guardarla en cada fila sincronizada).

**Imagen:** se guarda `poster_path` (string corto, ej. `/abc123xyz.jpg`),
no la URL completa. La UI construye la URL final combinándolo con el
tamaño que necesite en cada vista (`https://image.tmdb.org/t/p/{size}{poster_path}`).
Como la URL resultante es siempre la misma para un mismo ítem, el navegador
la cachea por HTTP automáticamente — no hace falta ningún código de caché
propio. Cachear las imágenes para uso offline real (no solo carga rápida)
es una mejora aparte vía la Cache API del `sw.js` que ya existe, fuera de
alcance de este diseño.

## Esquema de providers: `app_config.players`

Reemplaza al `app_config.providers` plano de hoy. Anidado por idioma y
pista; cada entrada es autocontenida (mismo `id` puede aparecer bajo
distintas combinaciones idioma/pista con reglas completamente distintas,
sin deduplicación):

```js
{
  "es": {
    "sub": [
      { "id": "animeav1", "rule": {
          "base_url": "https://animeav1.com",
          "search": { "url": "{base_url}/catalogo?q={query}", "item": ".card", "link": "a", "slug_regex": "/anime/([^/]+)" },
          "episode": { "url": "{base_url}/anime/{slug}/{episode}", "embeds_regex": "embeds:(\\{.*?\\});" }
        }}
    ],
    "dub": [
      { "id": "animeav2", "rule": { "...": "..." } }
    ]
  },
  "en": {
    "sub": [
      { "id": "animeflix", "rule": {
          "base_url": "https://animeflix.example",
          "search": { "url": "{base_url}/search?q={query}", "item": ".show", "link": "a", "slug_regex": "/title/([^/]+)" },
          "episode": { "url": "{base_url}/watch/{slug}/{episode}", "mirror_select": { "default_selector": "iframe#player", "option_selector": "select.mirror option" } }
        }}
    ],
    "dub": []
  }
}
```

`rule.search` ya no se usa para extraer título/imagen (eso es TMDB ahora)
— solo para resolver el `slug` de una serie en ese sitio a partir de su
título. `rule.episode` es exactamente igual que el `episode` de un
provider hoy, incluyendo `embeds_regex`/`mirror_select` — **`engine.js` no
cambia su mecanismo de despacho en absoluto**, solo cambia de dónde saca el
objeto `rule` (antes: un provider suelto del array; ahora: una entrada
dentro de `players[idioma][pista]`).

El mismo `rule` (mismo `base_url`/`embeds_regex`) puede aparecer
referenciado tanto en `sub` como en `dub` de un idioma cuando el sitio
entrega ambas pistas desde la misma página (como AnimeAV1 hoy) — el
resolver cachea por `(rule.base_url, slug, episode)` para no golpear el
sitio dos veces si el usuario prueba ambas pistas del mismo sitio.

## Preferencia de idioma del usuario

Global, local (no sincronizada) — mismo patrón que ya usa
`search_languages` hoy. Determina: (a) con qué `language=` se consultan
las llamadas a TMDB (título/imagen ya vienen en ese idioma sin trabajo
extra), y (b) qué rama de `app_config.players` se usa por defecto al
reproducir.

## Flujo de búsqueda → agregar

1. Se busca directo en la API de TMDB (`/search/tv` o `/search/multi`),
   `language={idioma_del_usuario}`. Devuelve candidatos con
   `{tmdb_id, title, poster_path, year, media_type}`.
2. Al agregar, se guarda `{tmdb_id, media_type, title, poster_path, last:0, players:{}}`
   — sin ningún sitio de reproducción resuelto todavía, sin tocar ningún `rule`.
3. La lista de episodios (números, fechas de emisión) viene de
   `/tv/{id}/season/{n}` de TMDB, no de scraping — el `series` de los
   providers de hoy deja de ser necesario.

## Flujo de reproducción

Cascada de selección por defecto, sin pedir ningún clic salvo que el
usuario ya haya cambiado algo antes para ese ítem:

1. **Idioma**: el idioma base del usuario.
2. **Pista**: SUB siempre por defecto.
3. **Sitio**: el primero de la lista configurada para ese idioma+pista
   (`players.es.sub[0]`).

Si `item.players["es|sub"]` ya tiene algo cacheado, esa combinación se usa
y reproduce directo. Si es la primera vez con ese `rule` para ese ítem
(nada cacheado), se busca automáticamente en ese sitio con el título de
TMDB (vía `rule.search`), se muestran los resultados y el usuario confirma
cuál es — mismo patrón ya usado hoy para "buscar en un provider" en pasos
de grupo. Una vez resuelto el slug, se llama
`engine.episodePlayers(rule, slug, episode)` sin cambios, se muestra el
picker de servidores existente, se reproduce embebido.

Cualquier cambio manual de pista o sitio en cualquier momento sobreescribe
`item.players["idioma|pista"]` y se convierte en el default desde ese
momento para ese ítem.

"Marcar visto"/"Siguiente" siguen operando sobre `tmdb_id` + el contador
`last`, sin depender de ningún provider — ya está desacoplado hoy y se
mantiene igual.

## Notificaciones / chequeo en segundo plano

**Por defecto (siempre activo):** se consulta TMDB
(`/tv/{id}/season/{n}`) y se compara `last` contra qué episodios ya tienen
fecha de emisión pasada. Si `last+1` ya emitió según TMDB, notifica
"episodio N ya salió" — sin garantía de que ya esté subido en ningún sitio
de reproducción, solo que ya se transmitió.

**Por rule (opt-in, complementario):** cada entrada de `app_config.players`
puede declarar opcionalmente `rule.check_interval_hours`. Si un ítem ya
tiene un slug resuelto en caché para ese `rule` (`item.players[...]`), el
chequeo en segundo plano también puede consultar ese sitio directamente
con `engine.checkEpisode()` (sin cambios respecto a hoy) para confirmar
disponibilidad real. Si nunca se resolvió ningún `rule` para el ítem, solo
aplica el chequeo por TMDB.

Esto reemplaza el `checkGroups()`/`checkNext` de `background.js` (que hoy
revisa un único provider por ítem) por: TMDB siempre, más cualquier
`(rule, slug)` ya resuelto que declare su propio intervalo.

## TMDB API key

Dos ubicaciones, gestionadas por el admin (mismo patrón ya usado para
Supabase):

- **Cliente (extensión/PWA):** la key real vive en `app_config`,
  sincronizada como los providers hoy. Extensión y PWA llaman a TMDB
  directo desde el navegador. Riesgo evaluado y aceptado: es una key de
  solo lectura de datos públicos, gratuita, sin costo por uso — el riesgo
  real es consumo de cuota o revocación por abuso detectado, no fuga de
  datos ni costo económico. Es el patrón que TMDB espera para apps
  cliente (Jellyfin, Stremio, y decenas de trackers open-source la
  exponen así).
- **Cron:** lee su propia copia desde un secret de GitHub Actions (mismo
  patrón que ya usa para `SUPABASE_SERVICE_KEY`), no depende de
  `app_config`.

## Migración de datos existentes

Ninguna — borrón y cuenta nueva. Se vacía watchlist/grupos/suscripciones
existentes y se resiembra `app_config` con el nuevo esquema `players`. Es
la cuenta real del propio usuario (no un producto multi-tenant), así que
no se justifica el trabajo de una herramienta de re-emparejamiento
asistido. La ejecución del borrado en sí se hace con confirmación
explícita al momento de implementar, no como parte de este diseño.

## Qué NO cambia

- El mecanismo de `engine.js` para extraer embeds (`embeds_regex` /
  `mirror_select`) — sigue funcionando exactamente igual, solo recibe el
  `rule` desde una ubicación distinta en el árbol de configuración.
- El picker de servidor SUB/DUB por episodio (`renderPlayerPicker`) — se
  reutiliza tal cual, solo se le añade un nivel más arriba (elegir sitio)
  con la misma lógica de "auto-selecciona el primero sin pedir un clic
  extra" que ya tiene hoy para pistas/servidores.
- `list.js`/`groups.js`'s manejo de `last`, `visible`, `deleted` — sin
  cambios de comportamiento, solo cambia la clave de identidad que usan
  internamente (`tmdb_id` en vez de `provider+slug`).

## Alcance (para el plan de implementación)

Archivos/áreas que este cambio toca, a nivel de inventario (el detalle
exacto de cada uno es trabajo del plan, no de esta spec):

- `src/app/engine.js`: `search()`/`episodes()` pasan a consultar TMDB en
  vez de scrapear; `checkEpisode`/`episodeUrl`/`episodePlayers` cambian de
  firma para recibir un `rule` en vez de un `provider` completo (mecanismo
  interno sin cambios).
- `src/app/list.js`, `src/app/groups.js`: identidad `tmdb_id` en vez de
  `{provider, slug}`.
- `src/app/ui/*`: toda tarjeta/panel que hoy identifica un ítem por
  `provider+slug` pasa a usar `tmdb_id`; el flujo de búsqueda pasa a
  consultar TMDB; el picker de reproducción gana el nivel de "sitio".
- `src/web/ui/config.js`, `src/extension/options.js`: el editor JSON de
  providers admin pasa a editar el nuevo esquema `players` anidado, más un
  campo para la TMDB key.
- `src/extension/background.js`: `checkGroups()` pasa a consultar TMDB
  por defecto, más chequeo opcional por `rule`.
- `cron/generate-feed.mjs`: mismo cambio de fuente de "próximo episodio".
- `supabase/schema.sql` + nueva migración: `watchlist`/`groups.steps`
  cambian su columna de identidad; `app_config` gana la forma nueva de
  `players` y la TMDB key.
- `.github/workflows/*`: nuevo secret `TMDB_API_KEY` para el cron.
- `src/test/*`: toda la cobertura que asume `{provider, slug}` como
  identidad necesita reescribirse sobre `tmdb_id`; nueva cobertura para la
  resolución lazy de `rule`+caché y para el chequeo híbrido de
  notificaciones.

Dado el tamaño, es plausible que el plan de implementación resulte más
grande que el de la reestructuración a `src/` — vale la pena que el propio
proceso de escritura del plan evalúe si conviene partirlo en más de un
plan secuencial (ej. "cambio de identidad + TMDB metadata" primero,
"players pluggables + notificaciones híbridas" después) en vez de un solo
plan monolítico.
