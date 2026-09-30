import * as tmdb from "../tmdb.js";
import { get, set } from "../store.js";
import { mutate } from "../list.js";
import { el, btn, safe, explain } from "./dom.js";
import { requestSync } from "./sync.js";
import { renderItemEpisodePanel } from "./episode-panel.js";
import { renderPlayerPrefSelectors } from "./player-pref.js";

const epsSel = new Map(); // tmdb_id -> episodio seleccionado, o null

// Nombres de los grupos (propios o suscritos) cuyo itinerario todavía usa este título.
// Quitarlo de la lista rompería su seguimiento ahí (el paso deja de encontrar el ítem:
// pierde avatar real y el botón "Visto" desaparece), así que "Quitar" lo bloquea si hay alguno.
function groupsReferencing(item, myGroups, subGroups) {
  return [...myGroups, ...subGroups]
    .filter(g => (g.steps || []).some(s => s.tmdb_id === item.tmdb_id))
    .map(g => g.name);
}

export function itemCard(item, myGroups, subGroups, onChange) {
  const st = el("div", { className: "st" });
  const eps = el("div", { className: "itin" });
  return el("div", { className: "card" },
    item.poster_path ? el("img", { src: safe(tmdb.posterUrl(item.poster_path)) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      renderPlayerPrefSelectors(item),
      el("div", { className: "st", textContent: "Visto hasta el episodio " + (item.last || 0) }),
      el("div", { className: "actions" },
        btn("Episodios", async () => {
          if (item.media_type === "movie") {
            eps.replaceChildren(item.last
              ? btn("✓ Vista (marcar no vista)", async () => { await mutate(item.tmdb_id, x => { x.last = 0; }); eps.textContent = ""; onChange(); requestSync(); })
              : btn("Marcar vista", async () => { await mutate(item.tmdb_id, x => { x.last = 1; }); eps.textContent = ""; onChange(); requestSync(); }));
            return;
          }
          eps.textContent = "Cargando…";
          try {
            const lang = await get("lang_pref", "es-ES");
            // Temporada 1 fija: soporte multi-temporada queda fuera de alcance de Plan A.
            const l = await tmdb.getSeasonEpisodes(item.tmdb_id, 1, lang);
            const renderEps = () => {
              const sel = epsSel.get(item.tmdb_id);
              eps.replaceChildren(
                ...(l.length ? l.map(e => {
                  const seen = e.number <= (item.last || 0);
                  const badge = el("span", {
                    className: "ep" + (seen ? " seen" : "") + (sel === e.number ? " selected" : ""),
                    textContent: String(e.number)
                  });
                  badge.onclick = () => { epsSel.set(item.tmdb_id, sel === e.number ? null : e.number); renderEps(); };
                  return badge;
                }) : ["Sin episodios"]),
                sel != null ? renderItemEpisodePanel(item, sel, sel <= (item.last || 0), renderEps) : "");
            };
            renderEps();
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
        btn("Visto +1", async () => {
          const it = await mutate(item.tmdb_id, x => { x.last = (x.last || 0) + 1; });
          if (it) {
            const news = await get("news", []);
            await set("news", news.filter(n => !(n.tmdb_id === it.tmdb_id && n.episode <= it.last)));
          }
          onChange(); requestSync();
        }),
        btn("Ocultar", async () => {
          // A diferencia de Quitar, esconder no borra nada ni rompe el seguimiento de ningún
          // grupo: el ítem sigue en watchlist, solo deja de mostrarse como tarjeta suelta.
          await mutate(item.tmdb_id, x => { x.visible = false; });
          onChange(); requestSync();
        }),
        btn("Quitar", async () => {
          const refs = groupsReferencing(item, myGroups, subGroups);
          if (refs.length) {
            st.textContent = `No se puede quitar: lo usa el grupo "${refs[0]}"${refs.length > 1 ? ` y ${refs.length - 1} más` : ""}. Quita ese paso del grupo (o date de baja) primero.`;
            return;
          }
          await mutate(item.tmdb_id, x => { x.deleted = true; }); onChange(); requestSync();
        })),
      st, eps));
}
