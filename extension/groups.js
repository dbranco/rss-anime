// Grupos de orden de visionado (playlists). El progreso no tiene contador propio: se
// deriva del `last` de cada ítem de watchlist, igual que ve el resto de la app.
// Ver docs/superpowers/specs/2026-09-25-watch-order-groups-design.md
import { get, set } from "./store.js";
import { mutate } from "./list.js";

export const live = list => list.filter(g => !g.deleted);

export function nextNeeded(step, last) {
  const exclude = new Set(step.exclude || []);
  for (let n = Math.max(step.from, last + 1); n <= step.to; n++) {
    if (!exclude.has(n)) return n;
  }
  return null; // ya visto hasta `to`, o solo quedaban excluidos: paso completo
}

export function currentStep(group, watchlist) {
  for (const step of group.steps) {
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

// Marca visto el episodio que toca del paso actual (mismo `mutate` que usa el resto de
// la app para "Visto +1" en list.js, así que actualiza el mismo `last` compartido).
export async function markStepSeen(group, watchlist) {
  const cur = currentStep(group, watchlist);
  if (!cur) return null;
  return mutate(cur.step.provider, cur.step.slug, x => { x.last = cur.next; });
}
