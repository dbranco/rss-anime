// Operaciones sobre la lista local. Borrar = marcar deleted (para que la sync propague el borrado).
import { get, set } from "./store.js";

export const live = list => list.filter(x => !x.deleted);
const same = (x, provider, slug) => x.provider === provider && x.slug === slug;

// visible=true (por defecto): aparece como tarjeta suelta en "Mi lista" — buscar y guardar,
// incluido elegir un resultado al construir un paso de grupo, o al repararlo. visible=false:
// solo repairGroup, para no ensuciar la lista con algo que nadie pidió a propósito. Una vez
// visible, nunca se baja aquí (solo con "Ocultar", acción explícita).
// título/link/imagen SIEMPRE se refrescan con lo que traiga `r` — da igual visible o no, si
// quien llama tiene datos mejores (una búsqueda real) deben quedar guardados. Por eso
// repairGroup() decide con cuidado qué pasar aquí: conserva la imagen si ya había una buena,
// para no pisarla con el placeholder cuando su propia búsqueda no encuentra nada.
export async function add(r, { visible = true } = {}) {
  const l = await get("watchlist", []);
  const now = new Date().toISOString();
  const it = l.find(x => same(x, r.provider, r.slug));
  if (it) {
    it.deleted = false;
    it.updated_at = now;
    it.title = r.title; it.link = r.link; it.image = r.image;
    if (visible) it.visible = true;
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
