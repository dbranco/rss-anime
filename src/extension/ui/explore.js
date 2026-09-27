import { get } from "../store.js";
import { live } from "../list.js";
import * as groups from "../groups.js";
import { searchPublicGroups, rateGroup } from "../sync.js";
import { $, el, btn, explain } from "./dom.js";
import { requestSync } from "./sync.js";

const EXPLORE_PAGE_SIZE = 10;
let exploreResults = [];
let explorePage = 0;

function exploreCard(g) {
  const st = el("div", { className: "st" });
  const stars = el("select", {});
  stars.replaceChildren(...[1, 2, 3, 4, 5].map(n => el("option", { value: n, textContent: `${n} ★` })));
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      el("div", { className: "st", textContent:
        g.rating_count ? `${g.rating_avg.toFixed(1)} ★ (${g.rating_count})` : "Sin valoraciones" }),
      el("div", { className: "actions" },
        btn("Suscribirme", async () => {
          await groups.subscribe(g, live(await get("watchlist", [])));
          st.textContent = "Suscrito.";
          requestSync();
        }),
        stars,
        btn("Valorar", async () => {
          try { await rateGroup(g.user_id, g.id, +stars.value); st.textContent = "Gracias por valorar."; }
          catch (e) { st.textContent = "Error: " + explain(e); }
        })),
      st));
}

export function renderExplore() {
  const pages = Math.max(1, Math.ceil(exploreResults.length / EXPLORE_PAGE_SIZE));
  explorePage = Math.min(explorePage, pages - 1);
  const start = explorePage * EXPLORE_PAGE_SIZE;
  const page = exploreResults.slice(start, start + EXPLORE_PAGE_SIZE);
  $("#exploreResults").replaceChildren(...(page.length ? page.map(exploreCard) : ["Sin resultados"]));
  $("#explorePager").replaceChildren(...(pages > 1
    ? [btn("◀", () => { explorePage = Math.max(0, explorePage - 1); renderExplore(); }),
       el("span", { textContent: `Página ${explorePage + 1} de ${pages}` }),
       btn("▶", () => { explorePage = Math.min(pages - 1, explorePage + 1); renderExplore(); })]
    : []));
}

$("#exploreBtn").onclick = async () => {
  const q = $("#exploreQ").value.trim();
  $("#exploreResults").replaceChildren("Buscando…");
  try {
    exploreResults = await searchPublicGroups(q);
    explorePage = 0;
    renderExplore();
  } catch (e) { $("#exploreResults").replaceChildren("Error: " + explain(e)); }
};
