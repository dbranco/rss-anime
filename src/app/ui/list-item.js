import * as engine from "../engine.js";
import { get, set } from "../store.js";
import { mutate } from "../list.js";
import { el, link, btn, safe, explain } from "./dom.js";
import { prov } from "./state.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderItemEpisodePanel } from "./episode-panel.js";

const epsSel = new Map(); // "provider|slug" -> episodio seleccionado, o null

// Nombres de los grupos (propios o suscritos) cuyo itinerario todavía usa este título.
// Quitarlo de la lista rompería su seguimiento ahí (el paso deja de encontrar el ítem:
// pierde avatar real y el botón "Visto" desaparece), así que "Quitar" lo bloquea si hay alguno.
function groupsReferencing(item, myGroups, subGroups) {
  return [...myGroups, ...subGroups]
    .filter(g => (g.steps || []).some(s => s.provider === item.provider && s.slug === item.slug))
    .map(g => g.name);
}

export function itemCard(item, myGroups, subGroups, onChange) {
  const st = el("div", { className: "st" });
  const eps = el("div", { className: "itin" });
  const key = `${item.provider}|${item.slug}`;
  return el("div", { className: "card" },
    item.image ? el("img", { src: safe(item.image) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      el("div", { textContent: "Visto hasta el episodio " + (item.last || 0) }),
      el("div", { className: "actions" },
        btn("Siguiente", async () => {
          const p = prov(item.provider);
          await ensurePermissions();
          const n = (item.last || 0) + 1;
          st.textContent = "Comprobando…";
          try {
            const r = await engine.checkEpisode(p, item.slug, n);
            st.replaceChildren(r.exists ? link(r.url, `Ep ${n} disponible ▶`) : `Ep ${n}: aún no`);
          } catch (e) { st.textContent = "Error: " + explain(e); }
        }),
        btn("Episodios", async () => {
          await ensurePermissions();
          eps.textContent = "Cargando…";
          try {
            const l = await engine.episodes(prov(item.provider), item.slug);
            const renderEps = () => {
              const sel = epsSel.get(key);
              eps.replaceChildren(
                ...(l.length ? l.map(e => {
                  const seen = e.number <= (item.last || 0);
                  const badge = el("span", {
                    className: "ep" + (seen ? " seen" : "") + (sel === e.number ? " selected" : ""),
                    textContent: String(e.number)
                  });
                  badge.onclick = () => { epsSel.set(key, sel === e.number ? null : e.number); renderEps(); };
                  return badge;
                }) : ["Sin episodios"]),
                sel != null ? renderItemEpisodePanel(item, sel, sel <= (item.last || 0), close => {
                  if (close) epsSel.delete(key);
                  renderEps();
                }) : "");
            };
            renderEps();
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
        btn("Visto +1", async () => {
          const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
          if (it) {
            const news = await get("news", []);
            await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
          }
          onChange(); requestSync();
        }),
        btn("Ocultar", async () => {
          // A diferencia de Quitar, esconder no borra nada ni rompe el seguimiento de ningún
          // grupo: el ítem sigue en watchlist, solo deja de mostrarse como tarjeta suelta.
          await mutate(item.provider, item.slug, x => { x.visible = false; });
          onChange(); requestSync();
        }),
        btn("Quitar", async () => {
          const refs = groupsReferencing(item, myGroups, subGroups);
          if (refs.length) {
            st.textContent = `No se puede quitar: lo usa el grupo "${refs[0]}"${refs.length > 1 ? ` y ${refs.length - 1} más` : ""}. Quita ese paso del grupo (o date de baja) primero.`;
            return;
          }
          await mutate(item.provider, item.slug, x => { x.deleted = true; }); onChange(); requestSync();
        })),
      st, eps));
}
