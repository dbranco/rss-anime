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
