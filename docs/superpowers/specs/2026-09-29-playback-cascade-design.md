# Elección de idioma/pista/proveedor por ítem ("Plan B")

**Fecha:** 2026-09-29
**Estado:** Aprobado en brainstorming, pendiente de plan de implementación.

## Motivación

Desde la migración a TMDB (ver `2026-09-27-tmdb-metadata-players-design.md`),
`app_config.players` ya soporta varios proveedores por idioma y pista
(`sub`/`dub`), pero `resolve.js` (Plan A) solo usa uno: siempre el idioma
global (`lang_pref`), siempre pista `sub`, siempre el primer proveedor
configurado (`players[lang].sub[0]`). Esto ya no alcanza: un usuario puede
tener varios proveedores configurados para un mismo idioma (o proveedores en
varios idiomas), y necesita poder elegir cuál usar para cada título — sin
que cambiar de proveedor para una serie afecte a las demás, y sin perder la
resolución ya cacheada de una combinación al probar otra.

Caso real que lo motiva: un ítem puede tener AnimeAV1 configurado en
`es-ES` y Meus Animes en `pt-PT` (sub y dub como catálogos separados). Hoy
solo se puede usar uno de los dos a la vez, cambiando `lang_pref` de forma
global para toda la cuenta.

## Modelo de datos

Nuevo campo opcional en cada ítem del watchlist:

```js
{
  ...
  player_pref: { lang: "pt-PT", track: "dub", providerId: "meusanimes-dub" }
}
```

Los tres campos son independientes y opcionales — cualquiera ausente cae al
valor por defecto correspondiente:

- `lang` ausente → `lang_pref` global (como hoy).
- `track` ausente → `"sub"`.
- `providerId` ausente → el primer proveedor configurado para ese
  `lang`+`track` (`players[lang][track][0]`).

Un ítem que nunca tocó estos selectores no tiene `player_pref` en absoluto
(o lo tiene vacío `{}`) y se comporta exactamente como hoy — no hace falta
migración de datos existentes ni tocar Supabase.

**Caché de resolución** (`item.players`, ya existente): la clave pasa de
estar fija en `"<lang>|sub"` a `"<lang>|<track>"` — un cambio de
generalización, no de forma; el valor sigue siendo `{providerId, slug}` sin
cambios. Cada combinación lang+track que se haya resuelto alguna vez queda
cacheada por separado, así que alternar entre dos combinaciones (ej. probar
`es-ES|sub` y luego volver a `pt-PT|dub`) no pierde la resolución de
ninguna de las dos. Un cambio de proveedor dentro de la misma combinación ya
se auto-invalida con el chequeo existente (`cached.providerId === entry.id`
en `resolveSlug`) — no hace falta lógica nueva para eso.

## resolve.js

`resolveAndPlay(item, episode, playerBox)` mantiene exactamente su firma
actual — los call sites en `episode-panel.js` (ambos, item suelto y grupo)
no cambian. Internamente:

```js
function chosenTrack(item) { return item.player_pref?.track || "sub"; }

async function chosenLang(item) {
  return item.player_pref?.lang || await get("lang_pref", "es-ES");
}

async function chosenRule(item, lang, track) {
  const players = await get("players", {});
  const entries = players[lang]?.[track] || [];
  const id = item.player_pref?.providerId;
  return (id && entries.find(e => e.id === id)) || entries[0] || null;
}
```

`resolveAndPlay` pasa a calcular `lang`/`track`/`entry` con estas tres
funciones en vez de `get("lang_pref", ...)` + `firstRule(lang)` (que se
elimina). El resto del flujo (`resolveSlug`, los tres intentos de búsqueda,
el caché) no cambia — solo la clave de caché usa `track` en vez de la
constante `"sub"`.

## UI

Los tres `<select>` encadenados (idioma → pista → proveedor) son un
componente nuevo y compartido, `renderPlayerPrefSelectors(item, onChange)`
en `src/app/ui/player-pref.js`:

- Poblar `idioma` con `Object.keys(players)`.
- Al elegir un idioma, poblar `pista` solo con `"sub"`/`"dub"` que tengan
  al menos un proveedor no vacío para ese idioma.
- Al elegir pista, poblar `proveedor` con `players[lang][track]` (mostrando
  `rule.name || entry.id`).
- Cualquier cambio persiste `item.player_pref` vía `mutate(item.tmdb_id, ...)`
  y llama a `onChange()`.
- El componente se comporta igual para `tv` y `movie` — los proveedores
  tienen idioma/pista sin importar el tipo de media. Si `players` está
  vacío (nadie configuró nada aún), no renderiza nada (mismo criterio que
  ya usa "Ver aquí" hoy al no encontrar `entry`).

Dos puntos de uso:

- **`list-item.js`** (`itemCard`): se inserta justo debajo del título,
  antes de la línea "Visto hasta el episodio N" — la posición marcada en
  la captura.
- **`group-card.js`** (`groupCard`): no hay una card por ítem (una card es
  un grupo con varios pasos), así que se inserta justo después de la línea
  "Paso X de Y: ... — episodio N" del `body`, aplicado a `cur.item` (el
  ítem del paso actual). El panel compartido `episode-panel.js` (usado por
  ambos flujos para "Ver aquí") no cambia.

## Casos límite

- **Sin ningún proveedor configurado:** el componente no renderiza nada;
  "Ver aquí" sigue mostrando el mensaje actual ("No hay ningún sitio de
  reproducción configurado para...").
- **`item.player_pref` apunta a un proveedor que ya no existe en
  `app_config.players`** (el admin lo borró): `chosenRule` no lo encuentra
  (`entries.find` da `undefined`) y cae a `entries[0]` — mismo
  comportamiento que "sin elección", sin romper nada. El selector, al
  repoblarse, simplemente no preseleccionará nada inválido.
- **Cambiar de pista a una sin resolución cacheada:** dispara una búsqueda
  nueva la próxima vez que se abra "Ver aquí" — igual que el flujo de
  búsqueda que ya existe hoy para la primera resolución de `sub`.

## Testing

- `src/test/ui/resolve.spec.js`: casos nuevos para caché por `lang|track`
  (en vez de siempre `sub`), y para que `chosenRule` respete
  `item.player_pref.providerId` cuando hay más de un proveedor configurado
  para la misma combinación.
- `src/test/list.spec.js`: persistencia de `player_pref` vía `mutate`.
- El renderizado de `list-item.js`/`group-card.js`/`player-pref.js` no
  tiene cobertura de `node:test` hoy (no hay tests de DOM para esos
  archivos) — se verifica en vivo en el navegador, como las últimas
  features de esta sesión.

## Fuera de alcance

- Cascada automática (probar el segundo proveedor si el primero no tiene
  el episodio) — el usuario elige explícitamente, no hay fallback
  automático entre proveedores del mismo idioma+pista.
- Mapeo de rangos de episodios por proveedor (el problema de
  numeración TMDB-vs-sitio de Re:Zero/One Piece) — sigue siendo un
  problema aparte, no resuelto por este diseño.
- Sincronizar `player_pref` entre dispositivos vía un mecanismo distinto
  al que ya sincroniza el resto de `watchlist` — no hace falta: viaja con
  el ítem igual que `players`/`last`/etc.
