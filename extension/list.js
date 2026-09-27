// Operaciones sobre la lista local. Borrar = marcar deleted (para que la sync propague el borrado).
import { get, set } from "./store.js";

export const live = list => list.filter(x => !x.deleted);
const same = (x, provider, slug) => x.provider === provider && x.slug === slug;

// visible=true (por defecto): la persona lo añadió a propósito (buscar y guardar,
// incluido elegir un resultado al construir un paso de grupo) — se refrescan
// título/link/imagen por si la búsqueda tiene mejores datos que lo que ya había.
// visible=false: creación automática (repairGroup) solo para poder llevar el conteo
// de episodios — nunca pisa datos ya existentes si el ítem ya estaba.
export async function add(r, { visible = true } = {}) {
  const l = await get("watchlist", []);
  const now = new Date().toISOString();
  const it = l.find(x => same(x, r.provider, r.slug));
  if (it) {
    it.deleted = false;
    it.updated_at = now;
    if (visible) { it.visible = true; it.title = r.title; it.link = r.link; it.image = r.image; }
  } else {
    l.push({ provider: r.provider, slug: r.slug, title: r.title, link: r.link, image: r.image,
             last: 0, visible, deleted: false, updated_at: now });
  }
  await set("watchlist", l);
}

export async function mutate(provider, slug, fn) {
  const l = await get("watchlist", []);
  const it = l.find(x => same(x, provider, slug));
  if (!it) return null;
  fn(it);
  it.updated_at = new Date().toISOString();
  await set("watchlist", l);
  return it;
}
