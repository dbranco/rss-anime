import { get } from "../../extension/store.js";
import { live } from "../../extension/list.js";
import * as groups from "../../extension/groups.js";
import { $, btn, el } from "./dom.js";
import { itemCard } from "./list-item.js";
import { groupCard } from "./group-card.js";

const LIST_PAGE_SIZE = 10;
let listFilter = "both";
let listPage = 0;

export function setListFilter(v) { listFilter = v; listPage = 0; }

export async function renderMain() {
  const watchlist = live(await get("watchlist", []));
  const myGroups = groups.live(await get("groups", []));
  // La fuente de verdad de "estoy suscrito" es group_subscriptions; subscribed_groups es solo la
  // caché de solo lectura del grupo original. Iteramos las suscripciones vivas para que una cuyo
  // grupo ya no esté en la caché (despublicado o borrado) siga teniendo su hueco con el botón de
  // baja. El live() sobre la caché es defensa en profundidad: una copia vieja pudo colarse antes
  // de que el filtro deleted=eq.false existiera.
  const subGroups = groups.live(await get("subscribed_groups", []));
  const subEntries = groups.liveSubscriptions(await get("group_subscriptions", [])).map(s => {
    const g = subGroups.find(x => x.user_id === s.owner_id && x.id === s.group_id);
    return g
      ? { kind: "group", data: g, owned: false, ts: g.updated_at }
      : { kind: "group", owned: false, ts: s.updated_at,
          data: { id: s.group_id, user_id: s.owner_id, name: null, steps: [], _unavailable: true } };
  });
  const entries = [];
  if (listFilter !== "groups") entries.push(...watchlist.filter(item => item.visible !== false).map(item => ({ kind: "item", data: item, ts: item.updated_at })));
  if (listFilter !== "media") {
    entries.push(...myGroups.map(g => ({ kind: "group", data: g, owned: true, ts: g.updated_at })));
    entries.push(...subEntries);
  }
  entries.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE));
  listPage = Math.min(listPage, pages - 1);
  const start = listPage * LIST_PAGE_SIZE;
  const page = entries.slice(start, start + LIST_PAGE_SIZE);

  $("#list").replaceChildren(...(page.length
    ? page.map(e => (e.kind === "item" ? itemCard(e.data, myGroups, subGroups, renderMain) : groupCard(e.data, watchlist, e.owned, renderMain)))
    : ["Nada que mostrar con este filtro."]));
  $("#listPager").replaceChildren(...(pages > 1
    ? [btn("◀", () => { listPage = Math.max(0, listPage - 1); renderMain(); }),
       el("span", { textContent: `Página ${listPage + 1} de ${pages}` }),
       btn("▶", () => { listPage = Math.min(pages - 1, listPage + 1); renderMain(); })]
    : []));
}
