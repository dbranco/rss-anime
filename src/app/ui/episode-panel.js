import { mutate } from "../list.js";
import * as groups from "../groups.js";
import { el, btn } from "./dom.js";
import { resolveAndPlay } from "./resolve.js";

// Panel de acción de un episodio de una media suelta (no de grupo): marcar/desmarcar visto,
// o verlo aquí con un servidor embebible (resolución perezosa, ver resolve.js).
export function renderItemEpisodePanel(item, episode, seen, onChange) {
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${item.title} — episodio ${episode}` }),
      el("div", { className: "actions" },
        // mutate() opera sobre una copia recién leída de storage, no sobre este `item` — sin
        // sincronizarlo de vuelta, el panel se queda mostrando el estado viejo hasta un refresh
        // completo de la página (item nunca se refresca solo por re-renderizar localmente).
        seen
          ? btn("Desmarcar", async () => { const u = await mutate(item.tmdb_id, x => { x.last = Math.min(x.last || 0, episode - 1); }); if (u) Object.assign(item, u); onChange(); })
          : btn("Marcar visto", async () => { const u = await mutate(item.tmdb_id, x => { x.last = Math.max(x.last || 0, episode); }); if (u) Object.assign(item, u); onChange(); }),
        btn("▶ Ver aquí", () => resolveAndPlay(item, episode, playerBox)),
        btn("Cerrar", () => onChange(true))),
      playerBox));
}

// Igual que arriba, pero para el episodio seleccionado del itinerario de un grupo.
export function renderEpisodePanel(sel, onChange) {
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${sel.item ? sel.item.title : sel.step.title} — episodio ${sel.episode}` }),
      el("div", { className: "actions" },
        sel.seen
          ? btn("Desmarcar", async () => { await groups.unmarkFrom(sel.step, sel.episode); onChange(true); })
          : btn("Marcar visto", async () => { await groups.markUpTo(sel.step, sel.episode); onChange(true); }),
        // Sin item (el paso apunta a algo que ya no está en watchlist) no hay nada que resolver.
        sel.item ? btn("▶ Ver aquí", () => resolveAndPlay(sel.item, sel.episode, playerBox)) : "",
        btn("Cerrar", () => onChange(true))),
      playerBox));
}
