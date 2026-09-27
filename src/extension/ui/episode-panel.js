import * as engine from "../engine.js";
import { mutate } from "../list.js";
import * as groups from "../groups.js";
import { el, link, btn, explain } from "./dom.js";
import { prov } from "./state.js";
import { ensurePermissions } from "./permissions.js";
import { renderPlayerPicker } from "./player.js";

// Panel de acción de un episodio de una media suelta (no de grupo): marcar/desmarcar visto,
// abrir su página o verlo aquí mismo con un servidor embebible.
export function renderItemEpisodePanel(item, episode, seen, onChange) {
  const p = prov(item.provider);
  const url = p ? engine.episodeUrl(p, item.slug, episode) : null;
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${item.title} — episodio ${episode}` }),
      el("div", { className: "actions" },
        seen
          ? btn("Desmarcar", async () => { await mutate(item.provider, item.slug, x => { x.last = Math.min(x.last || 0, episode - 1); }); onChange(); })
          : btn("Marcar visto", async () => { await mutate(item.provider, item.slug, x => { x.last = Math.max(x.last || 0, episode); }); onChange(); }),
        url ? link(url, "Abrir") : "",
        p ? btn("▶ Ver aquí", async () => {
              await ensurePermissions(item.provider);
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, item.slug, episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
        btn("Cerrar", () => onChange(true))),
      playerBox));
}

// Igual que arriba, pero para el episodio seleccionado del itinerario de un grupo: marcar
// visto usa groups.markUpTo/unmarkFrom en vez de mutate directo (mismo `last` compartido).
export function renderEpisodePanel(sel, onChange) {
  const title = sel.item ? sel.item.title : sel.step.slug;
  const p = prov(sel.step.provider);
  const url = p ? engine.episodeUrl(p, sel.step.slug, sel.episode) : null;
  const playerBox = el("div", {});
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: `${title} — episodio ${sel.episode}` }),
      el("div", { className: "actions" },
        sel.seen
          ? btn("Desmarcar", async () => { await groups.unmarkFrom(sel.step, sel.episode); onChange(true); })
          : btn("Marcar visto", async () => { await groups.markUpTo(sel.step, sel.episode); onChange(true); }),
        url ? link(url, "Abrir") : "",
        p ? btn("▶ Ver aquí", async () => {
              await ensurePermissions(sel.step.provider);
              playerBox.textContent = "Buscando servidores…";
              try { renderPlayerPicker(playerBox, await engine.episodePlayers(p, sel.step.slug, sel.episode)); }
              catch (e) { playerBox.textContent = "Error: " + explain(e); }
            }) : "",
        btn("Cerrar", () => onChange(true))),
      playerBox));
}
