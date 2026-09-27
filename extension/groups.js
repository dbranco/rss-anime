// Grupos de orden de visionado (playlists). El progreso no tiene contador propio: se
// deriva del `last` de cada ítem de watchlist, igual que ve el resto de la app.
// Ver docs/superpowers/specs/2026-09-25-watch-order-groups-design.md
import { get, set } from "./store.js";
import { mutate, add } from "./list.js";
import * as engine from "./engine.js";

export const live = list => list.filter(g => !g.deleted);

export function nextNeeded(step, last) {
  const exclude = new Set(step.exclude || []);
  for (let n = Math.max(step.from, last + 1); n <= step.to; n++) {
    if (!exclude.has(n)) return n;
  }
  return null; // ya visto hasta `to`, o solo quedaban excluidos: paso completo
}

export function currentStep(group, watchlist) {
  for (const step of group.steps || []) {
    const item = watchlist.find(w => w.provider === step.provider && w.slug === step.slug);
    const last = item?.last || 0;
    const next = nextNeeded(step, last);
    if (next != null) return { step, item, next };
  }
  return null; // grupo completo (o sin pasos)
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

// Marca visto hasta `episode` (incluido) en el ítem de `step`. Monotónico: nunca mueve `last`
// hacia atrás, por si el watchlist que tenía quien llama ya estaba obsoleto (otra pestaña o
// dispositivo pudo avanzarlo entretanto).
export function markUpTo(step, episode) {
  return mutate(step.provider, step.slug, x => { x.last = Math.max(x.last || 0, episode); });
}

// Lo contrario, para corregir un "visto" por error: retrocede `last` a justo antes de
// `episode` (nunca lo sube — para eso está markUpTo).
export function unmarkFrom(step, episode) {
  return mutate(step.provider, step.slug, x => { x.last = Math.min(x.last || 0, episode - 1); });
}

// Marca visto el episodio que toca del paso actual (mismo `mutate` que usa el resto de
// la app para "Visto +1" en list.js, así que actualiza el mismo `last` compartido).
export async function markStepSeen(group, watchlist) {
  const cur = currentStep(group, watchlist);
  if (!cur) return null;
  return markUpTo(cur.step, cur.next);
}

// Aplana todos los pasos del grupo en episodios individuales, en el orden en que se ven —
// para pintar el itinerario completo del grupo de un tirón (no solo "el que toca ahora").
// Cada entrada lleva el número de episodio DENTRO de su propio título (no un número global
// acumulado); `seen` marca si ya está visto según el `last` real del ítem.
export function itinerary(group, watchlist) {
  const out = [];
  for (const step of group.steps || []) {
    const item = watchlist.find(w => w.provider === step.provider && w.slug === step.slug);
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
  const providers = await get("providers", []);
  // Incluye borrados: si el paso apunta a un ítem que ya existía (ej. lo quitaste sin querer y
  // lo estás recuperando), no hay que perder su imagen/título real solo porque esta pasada de
  // búsqueda no encuentre nada — add() ahora refresca siempre con lo que se le pase aquí.
  const all = await get("watchlist", []);
  for (const s of missingSteps(g, watchlist)) {
    const existing = all.find(w => w.provider === s.provider && w.slug === s.slug);
    let title = existing?.title || prettify(s.slug), link = existing?.link || null, image = existing?.image || null;
    if (!image) {
      const p = providers.find(x => x.id === s.provider);
      if (p) {
        try {
          const res = await engine.search(p, prettify(s.slug));
          const hit = res.find(r => r.slug === s.slug) || res[0];
          if (hit) { title = hit.title; link = hit.link; image = hit.image; }
        } catch { /* sin conexión o sin match: se queda con lo que ya había */ }
      }
    }
    await add({ provider: s.provider, slug: s.slug, title, link, image }, { visible: false });
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
