# Reestructuración a src/ con UI compartida entre extensión y PWA

**Fecha:** 2026-09-27
**Estado:** Aprobado en brainstorming, pendiente de plan de implementación.

## Motivación

Tras dividir `web/app.js` y `extension/popup.js` en módulos ES nativos (commits
`13e8e56` y `85b0db5`), quedaron dos árboles `web/ui/` y `extension/ui/` con
exactamente los mismos 10 módulos (`dom`, `state`, `player`, `episode-panel`,
`list-item`, `group-card`, `main-list`, `explore`, `group-builder`, `search`)
y lógica casi idéntica. Duplicar cada bug/feature en dos sitios es un costo
recurrente. Esta spec fusiona esa capa de UI y, de paso, ordena todo el
repositorio bajo `src/` con una separación clara entre lógica compartida y
lo que cada plataforma necesita para arrancar.

## Estructura de carpetas

```
src/
  app/                    # lógica de negocio + UI compartida (agnóstica de plataforma)
    engine.js  store.js  list.js  groups.js  sync.js
    ui/
      dom.js  state.js  permissions.js  sync.js  player.js
      episode-panel.js  list-item.js  group-card.js
      main-list.js  explore.js  group-builder.js  search.js
  web/                    # todo lo que la PWA necesita para funcionar
    index.html  app.js  style.css  sw.js  proxy.js  config.js
    manifest.webmanifest  icons/
    ui/
      config.js            # editor JSON de providers — exclusivo del tab admin de la PWA
  extension/              # todo lo que la extensión MV3 necesita
    manifest.json  popup.html  popup.js  options.html  options.js
    background.js  offscreen.html  offscreen.js  syncClient.js  icons/
    ui/
      news.js               # caja "nuevos episodios" — exclusivo de la extensión
src/test/                 # ver sección Tests más abajo
tests/                    # se retira; su contenido se mueve a src/test/
```

`cron/`, `supabase/`, `docs/` no se mueven — solo se les actualizan los
imports que apuntaban a `extension/*.js` para que apunten a `src/app/*.js`.

Base de implementación: `extension/ui/*.js` ya tiene el superset de
comportamiento (chequeos de permiso, mensajes por vista) — los archivos
fusionados en `src/app/ui/` parten de ahí, incorporando las diferencias de
la PWA vía los mecanismos descritos abajo, no al revés.

## Reconciliación de las 4 diferencias reales

Todo lo demás entre `web/ui/` y `extension/ui/` ya es idéntico salvo nombres
de clase CSS. Solo hay 4 puntos de comportamiento genuinamente distintos:

### A. Permisos (`ensurePermissions` / `watchlistCache` / `updatePermBanner`)

Se fusiona `permissions.js` con detección de entorno en runtime, mismo
idioma que ya usa `store.js` (`hasChromeStorage()`):

```js
export function ensurePermissions(extraIds) {
  if (typeof chrome === "undefined" || !chrome.permissions) return Promise.resolve(); // PWA: no-op
  // ...lógica real de extensión sin cambios...
}
export async function updatePermBanner() {
  const el = $("#permBanner");
  if (!el || typeof chrome === "undefined" || !chrome.permissions) return; // la PWA no tiene el banner
  // ...
}
```

`$("#grantPerms").onclick = ...` se queda dentro del propio `permissions.js`
(no hay elemento `#grantPerms` en la PWA, así que ese `onclick` nunca se
dispara ahí — no requiere guardia adicional porque `$()` sobre un selector
inexistente simplemente no engancha nada).

### B. Sincronización (`requestSync`)

Mismo patrón de detección de entorno: si existe un service worker al que
delegar (`chrome.runtime`), se delega ahí (la extensión necesita esto
porque el popup es un contexto efímero que se destruye al perder el foco);
si no, se usa `syncNow()` directo con deduplicación en memoria (como ya
hace hoy `web/ui/sync.js`).

### C. Mensajes de estado

No necesita inyección de código. Los módulos compartidos ya escriben a IDs
específicos por vista (`#searchMsg`, `#groupMsg`) o a un elemento local de
la propia tarjeta (`st.textContent` en el bloqueo de "Quitar", en el
chequeo de episodio) — eso ya es idéntico en ambos árboles. Lo único que
falta es que `popup.html` gane esos dos elementos (`#searchMsg`,
`#groupMsg`), que hoy no tiene porque usa un único `#msg` global. Ese
`#msg` global se queda, pero solo para lo que es exclusivo del entry point
(`popup.js`: errores de "Comprobar todos", fallo al pedir permiso).

### D. Clases CSS

Se estandariza en `.st` / `.itin` (nombres de la extensión, más cortos, ya
usados en más sitios). `web/style.css` gana las reglas equivalentes bajo
esos nombres; se retiran `.hint` y el `.msg` de tarjeta (el `#msg` de
página en la PWA no se toca, es un elemento distinto).

### E. Texto de error (`explain()`)

Una sola función, rama sobre la misma señal que (A): si es `TypeError` y
hay `chrome.permissions`, usa el mensaje "puede que falte permiso"; si no,
el genérico "No se pudo conectar."

## Qué NO se comparte (y por qué)

| Archivo | Se queda en | Motivo |
|---|---|---|
| `ui/config.js` (editor JSON de providers) | `src/web/ui/` | Tab de la PWA; en la extensión el mismo flujo vive en `options.js`/`options.html`, una página completa con DOM distinto. Ambos ya son ~20 líneas envolviendo `saveAppProviders` — fusionarlos no ahorra nada. |
| `ui/news.js` (caja "nuevos episodios") | `src/extension/ui/` | Sin equivalente en la PWA, que resuelve esa necesidad con el feed RSS de cron, no con una caja in-app. |
| `options.js`/`options.html`, `background.js`, `offscreen.js`/`.html`, `syncClient.js`, `manifest.json` | `src/extension/` | Glue 100% específico de APIs de Chrome (alarms, offscreen documents, mensajería con el service worker). |
| `app.js` / `popup.js` (entry points) | cada uno en su carpeta | Cada app orquesta sus propios tabs/vistas (la PWA tiene login + tab Config admin; la extensión tiene banner de permisos, sin login propio) — es la capa que monta los módulos compartidos, no lógica compartible en sí. |

## Tests: migración a `src/test/` con `node:test`

Node 24 (versión de este proyecto) incluye `node:test` sin dependencias
nuevas, descubre `*.spec.js` recursivamente con `node --test <dir>` y
excluye `node_modules` automáticamente (verificado en este mismo entorno).
El harness actual (`tests/run.sh` + 3 scripts con `assert` + `console.log`
narrativo) se reescribe a `describe`/`it`:

```
src/test/
  run.sh                    # levanta mock_site.py + mock_supabase.py, luego `node --test src/test`
  mock_site.py
  mock_supabase.py
  mock-provider.json
  mock-provider-mirror.json
  engine.spec.js            # espejo de src/app/engine.js (puerto directo de test-engine.mjs)
  store.spec.js             # NUEVO: fija el fallback chrome.storage.local vs localStorage
  list.spec.js              # espejo de src/app/list.js (la parte CRUD de test-groups.mjs)
  groups.spec.js            # espejo de src/app/groups.js (el resto de test-groups.mjs)
  sync.spec.js              # espejo de src/app/sync.js
  ui/
    permissions.spec.js     # NUEVO: ensurePermissions con y sin chrome.permissions presente
    sync.spec.js            # NUEVO: requestSync delega a chrome.runtime si existe, si no syncNow()+dedup
  integration/
    sync-cron.spec.js       # puerto de test-sync-cron.mjs — escenarios multiusuario/cron/grupos
                             # públicos no mapean a un módulo, se quedan como suite de integración
```

`package.json` gana `"scripts": { "test": "bash src/test/run.sh" }` (hoy no
tiene sección `scripts`).

**Fuera de alcance explícito:** no se agrega cobertura de renderizado/DOM
para `dom.js`, `state.js`, `player.js`, `episode-panel.js`, `list-item.js`,
`group-card.js`, `main-list.js`, `explore.js`, `group-builder.js`,
`search.js` — eso sería un esfuerzo aparte (simular clics sobre el DOM
construido por `el()`) y no estaba en el alcance pedido. `store.spec.js` y
`ui/{permissions,sync}.spec.js` son las únicas piezas de cobertura nueva,
porque fijan justo el mecanismo de detección de entorno del que depende
toda esta fusión.

## CI: deploy automático a GitHub Pages

Nuevo `.github/workflows/deploy-pages.yml`: en cada push a `master` que
toque `src/web/**`, empaqueta esa carpeta con `actions/upload-pages-artifact`
y la publica con `actions/deploy-pages`. Esto reemplaza la dependencia de
que Settings → Pages apunte a una carpeta fija — una vez configurado el
modo "GitHub Actions" en Pages (cambio manual de una sola vez, con
confirmación explícita antes de tocarlo), la carpeta servida puede moverse
sin volver a tocar esa configuración.

## Alcance de la migración de imports

Archivos fuera de `extension/`/`web/` que referencian esas rutas hoy y
necesitan actualizarse a `src/app/...`:

- `cron/generate-feed.mjs` (2 líneas: `../extension/engine.js`, `../extension/groups.js`)
- `tests/test-engine.mjs`, `tests/test-groups.mjs`, `tests/test-sync-cron.mjs`
  — se retiran junto con `tests/`, su contenido pasa a `src/test/` (ver arriba)
- Dentro de `src/extension/`: `background.js`, `options.js`, `popup.js`,
  `offscreen.js` pasan de `./store.js` etc. a `../app/store.js` etc.
  (los módulos de `src/app/` no cambian sus imports internos entre sí,
  se mueven como unidad).
- Dentro de `src/web/`: `app.js`, `proxy.js`, `sw.js`, `ui/config.js` pasan
  de `../extension/store.js` a `../app/store.js` (y análogos).
- `manifest.json`: se mueve a `src/extension/manifest.json`; sus rutas
  internas (`popup.html`, `background.service_worker`, `options_page`) no
  cambian porque son relativas a su propia ubicación.
- `README.md`: instrucciones de "carga `extension/` como extensión sin
  empaquetar" y de servir `web/` con GitHub Pages pasan a `src/extension/`
  y `src/web/`.

El corte es de una sola vez (`git mv` + ediciones), sin mantener las rutas
viejas en paralelo — coherente con seguir trabajando directo en `master`
sin worktree, como el resto de esta sesión.
