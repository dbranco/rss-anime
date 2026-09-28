// Operaciones sobre la lista local. Borrar = marcar deleted (para que la sync propague el borrado).
// Identidad: tmdb_id (ver docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md) —
// ya no {provider, slug}. `players` es el caché de "última combinación elegida" por idioma|pista,
// nunca una fijación (ver src/app/ui/resolve.js).
import { get, set } from "./store.js";

export const live = list => list.filter(x => !x.deleted && x.tmdb_id != null);
const same = (x, tmdbId) => x.tmdb_id === tmdbId;

// visible=true (por defecto): aparece como tarjeta suelta en "Mi lista". visible=false: solo
// repairGroup, para no ensuciar la lista con algo que nadie pidió a propósito. Una vez visible,
// nunca se baja aquí (solo con "Ocultar", acción explícita).
// título/poster_path SIEMPRE se refrescan con lo que traiga `r` — da igual visible o no.
export async function add(r, { visible = true } = {}) {
  const l = await get("watchlist", []);
  const now = new Date().toISOString();
  const it = l.find(x => same(x, r.tmdb_id));
  if (it) {
    it.deleted = false;
    it.updated_at = now;
    it.title = r.title; it.media_type = r.media_type; it.poster_path = r.poster_path ?? it.poster_path;
    it.original_title = r.original_title ?? it.original_title ?? null;
    if (visible) it.visible = true;
  } else {
    l.push({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title,
             original_title: r.original_title ?? null,
             poster_path: r.poster_path ?? null, last: 0, players: {},
             visible, deleted: false, updated_at: now });
  }
  await set("watchlist", l);
}

export async function mutate(tmdbId, fn) {
  const l = await get("watchlist", []);
  const it = l.find(x => same(x, tmdbId));
  if (!it) return null;
  fn(it);
  it.updated_at = new Date().toISOString();
  await set("watchlist", l);
  return it;
}
