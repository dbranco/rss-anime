// Grupos de orden de visionado (playlists). El progreso no tiene contador propio: se
// deriva del `last` de cada ítem de watchlist, igual que ve el resto de la app.
// Identidad de paso: tmdb_id (ver docs/superpowers/specs/2026-09-27-tmdb-metadata-players-design.md).
import { get, set } from "./store.js";
import { mutate, add } from "./list.js";
import * as tmdb from "./tmdb.js";

export const live = list => list.filter(g => !g.deleted);

export function nextNeeded(step, last) {
  const exclude = new Set(step.exclude || []);
  for (let n = Math.max(step.from, last + 1); n <= step.to; n++) {
    if (!exclude.has(n)) return n;
  }
  return null;
}

export function currentStep(group, watchlist) {
  for (const step of group.steps || []) {
    const item = watchlist.find(w => w.tmdb_id === step.tmdb_id);
    const last = item?.last || 0;
    const next = nextNeeded(step, last);
    if (next != null) return { step, item, next };
  }
  return null;
}

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

export function markUpTo(step, episode) {
  return mutate(step.tmdb_id, x => { x.last = Math.max(x.last || 0, episode); });
}

export function unmarkFrom(step, episode) {
  return mutate(step.tmdb_id, x => { x.last = Math.min(x.last || 0, episode - 1); });
}

export async function markStepSeen(group, watchlist) {
  const cur = currentStep(group, watchlist);
  if (!cur) return null;
  return markUpTo(cur.step, cur.next);
}

export function itinerary(group, watchlist) {
  const out = [];
  for (const step of group.steps || []) {
    const item = watchlist.find(w => w.tmdb_id === step.tmdb_id);
    const last = item?.last || 0;
    const exclude = new Set(step.exclude || []);
    for (let n = step.from; n <= step.to; n++) {
      if (exclude.has(n)) continue;
      out.push({ step, item, episode: n, seen: n <= last });
    }
  }
  return out;
}

export const setPublic = (id, isPublic) => mutateGroup(id, g => { g.public = !!isPublic; });

export function missingSteps(g, watchlist) {
  const seen = new Set();
  return (g.steps || []).filter(s => {
    if (seen.has(s.tmdb_id)) return false;
    seen.add(s.tmdb_id);
    return !watchlist.find(w => w.tmdb_id === s.tmdb_id);
  });
}

// Reconstruye ítems que faltan pidiendo el detalle exacto a TMDB por tmdb_id — sin ambigüedad
// posible (a diferencia de una búsqueda por texto), así que no hace falta ningún fallback de
// "adivinar" ni elegir provider: siempre hay una única respuesta correcta o ninguna.
export async function repairGroup(g, watchlist) {
  const lang = await get("lang_pref", "es-ES");
  for (const s of missingSteps(g, watchlist)) {
    let title = null, poster_path = null, media_type = s.media_type || "tv";
    try {
      const info = await tmdb.getShow(s.tmdb_id, media_type, lang);
      title = info.title; poster_path = info.poster_path; media_type = info.media_type;
    } catch { /* sin conexión: se agrega con lo mínimo, se corrige solo en el próximo intento */ }
    await add({ tmdb_id: s.tmdb_id, media_type, title: title || `#${s.tmdb_id}`, poster_path },
              { visible: false });
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

export async function subscribe(group, watchlist) {
  await mutateSubscription(group.user_id, group.id, s => { s.deleted = false; });
  await repairGroup(group, watchlist);
}

export const unsubscribe = (ownerId, groupId) => mutateSubscription(ownerId, groupId, s => { s.deleted = true; });
