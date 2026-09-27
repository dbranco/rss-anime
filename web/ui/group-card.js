import * as engine from "../../extension/engine.js";
import { get, set } from "../../extension/store.js";
import * as groups from "../../extension/groups.js";
import { el, link, btn, explain } from "./dom.js";
import { prov } from "./state.js";
import { requestSync } from "./sync.js";
import { renderEpisodePanel } from "./episode-panel.js";

const PALETTE = ["#2f6690", "#b8560f", "#2f7a4f", "#7a3b9e", "#a83a2c", "#5c6169"];
const ITIN_PAGE_SIZE = 25;
const itinPage = new Map(); // id de grupo -> página actual del itinerario
const itinSel = new Map(); // id de grupo -> episodio seleccionado ({step, episode, item, seen}) o null
const avatarSel = new Map(); // id de grupo -> índice del título mostrado en el carrusel

function titleColors(steps) {
  const map = new Map();
  for (const s of steps) {
    const key = `${s.provider}|${s.slug}`;
    if (!map.has(key)) map.set(key, PALETTE[map.size % PALETTE.length]);
  }
  return map;
}

function distinctTitles(g) {
  return [...new Map(g.steps.map(s => [`${s.provider}|${s.slug}`, s])).values()];
}

function avatarEl(title, color, isCur, image) {
  const cls = "avatar" + (isCur ? " current" : "");
  const ph = () => el("div", { className: cls + " avatar-ph", title,
    textContent: title[0]?.toUpperCase() || "?", style: `--av:${color}` });
  if (!image) return ph();
  const img = el("img", { src: image, title, className: cls, style: `--av:${color}` });
  img.onerror = () => img.replaceWith(ph()); // portada rota/bloqueada: cae al marcador de color
  return img;
}

// Un carrusel real: una imagen a la vez, con flechas. Si hay un episodio seleccionado
// en el itinerario, muestra el título al que pertenece (se sincroniza desde el
// onclick de los badges, ver renderItinerary); si no, muestra el paso actual.
function renderAvatars(g, cur, watchlist, onChange) {
  const distinct = distinctTitles(g);
  if (!distinct.length) return el("div", {});
  const colors = titleColors(g.steps);
  if (!avatarSel.has(g.id)) {
    const curIdx = cur ? distinct.findIndex(s => s.provider === cur.step.provider && s.slug === cur.step.slug) : 0;
    avatarSel.set(g.id, Math.max(0, curIdx));
  }
  const idx = Math.min(avatarSel.get(g.id), distinct.length - 1);
  const s = distinct[idx];
  const it = watchlist.find(w => w.provider === s.provider && w.slug === s.slug);
  const isCur = !!cur && cur.step.provider === s.provider && cur.step.slug === s.slug;
  const move = d => { avatarSel.set(g.id, (idx + d + distinct.length) % distinct.length); onChange(); };
  return el("div", { className: "avatars" },
    distinct.length > 1 ? btn("◀", () => move(-1)) : "",
    avatarEl(it ? it.title : s.slug, colors.get(`${s.provider}|${s.slug}`), isCur, it?.image),
    distinct.length > 1 ? btn("▶", () => move(1)) : "");
}

function renderItinerary(g, cur, watchlist, onChange) {
  const items = groups.itinerary(g, watchlist);
  if (!items.length) return el("div", {});
  const colors = titleColors(g.steps);
  const curIdx = cur ? items.findIndex(e => e.step === cur.step && e.episode === cur.next) : -1;
  const pages = Math.max(1, Math.ceil(items.length / ITIN_PAGE_SIZE));
  if (!itinPage.has(g.id)) itinPage.set(g.id, curIdx >= 0 ? Math.floor(curIdx / ITIN_PAGE_SIZE) : 0);
  const page = Math.min(itinPage.get(g.id), pages - 1);
  const start = page * ITIN_PAGE_SIZE;
  const sel = itinSel.get(g.id);

  const badges = items.slice(start, start + ITIN_PAGE_SIZE).map((e, i) => {
    const globalIdx = start + i;
    const color = colors.get(`${e.step.provider}|${e.step.slug}`);
    const isSel = sel && sel.step === e.step && sel.episode === e.episode;
    const badge = el("span", {
      className: "ep" + (e.seen ? " seen" : "") + (globalIdx === curIdx ? " now" : "") + (isSel ? " selected" : ""),
      textContent: String(globalIdx + 1),
      title: `Episodio ${e.episode} de ${e.item ? e.item.title : e.step.slug}`,
      style: `border-color:${color}` + (e.seen ? `;background:${color}` : "")
    });
    // Un toque selecciona/abre la tarjeta de acción; toca otra vez para cerrarla.
    // También cambia el carrusel de avatares al título de este episodio.
    badge.onclick = () => {
      itinSel.set(g.id, isSel ? null : { step: e.step, episode: e.episode, item: e.item, seen: e.seen });
      const idx = distinctTitles(g).findIndex(s => s.provider === e.step.provider && s.slug === e.step.slug);
      if (idx >= 0) avatarSel.set(g.id, idx);
      onChange();
    };
    return badge;
  });

  return el("div", {},
    el("div", { className: "itin" }, ...badges),
    pages > 1
      ? el("div", { className: "row hint" },
          btn("◀", () => { itinPage.set(g.id, Math.max(0, page - 1)); onChange(); }),
          el("span", { textContent: `Página ${page + 1} de ${pages}` }),
          btn("▶", () => { itinPage.set(g.id, Math.min(pages - 1, page + 1)); onChange(); }))
      : "",
    sel ? renderEpisodePanel(sel, close => { if (close) itinSel.delete(g.id); onChange(); }) : "");
}

export function groupCard(g, watchlist, owned, onChange) {
  // El grupo original se despublicó o se borró, así que ya no está en subscribed_groups — pero la
  // suscripción sigue viva. Sin este hueco la tarjeta desaparecía y con ella el único botón para
  // darse de baja, dejando la suscripción imposible de quitar desde la UI.
  if (g._unavailable) {
    return el("div", { className: "card" },
      el("div", { className: "body" },
        el("div", { className: "hint", textContent: "Grupo ya no disponible." }),
        el("div", { className: "actions" },
          btn("Darse de baja", async () => { await groups.unsubscribe(g.user_id, g.id); await requestSync(); onChange(); }))));
  }
  const cur = groups.currentStep(g, watchlist);
  const st = el("div", { className: "msg" });
  const onMark = async (step, episode) => {
    const it = await groups.markUpTo(step, episode);
    if (it) {
      const news = await get("news", []);
      await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
    }
    onChange(); requestSync();
  };
  const body = !cur
    ? el("div", { textContent: "✓ Terminado" })
    : el("div", {},
        el("div", { textContent:
          `Paso ${g.steps.indexOf(cur.step) + 1} de ${g.steps.length}: ` +
          `${cur.item ? cur.item.title : cur.step.slug} — episodio ${cur.next}` }),
        cur.item
          ? el("div", { className: "actions" },
              btn("Siguiente", async () => {
                const p = prov(cur.step.provider);
                st.textContent = "Comprobando…";
                try {
                  const r = await engine.checkEpisode(p, cur.step.slug, cur.next);
                  st.replaceChildren(r.exists ? link(r.url, `Ep ${cur.next} disponible ▶`) : `Ep ${cur.next}: aún no`);
                } catch (e) { st.textContent = "Error: " + explain(e); }
              }),
              btn("Visto", () => onMark(cur.step, cur.next)))
          : el("div", { className: "hint",
              textContent: `⚠ ${cur.step.provider}/${cur.step.slug} ya no está en tu lista` }),
        st);
  const missing = groups.missingSteps(g, watchlist);
  return el("div", { className: "card" },
    el("div", { className: "body" },
      el("b", { textContent: g.name }),
      owned ? "" : el("div", { className: "hint", textContent: "de otra cuenta" }),
      missing.length
        ? el("div", { className: "hint" },
            `⚠ ${missing.length} título${missing.length === 1 ? "" : "s"} de este grupo no ${missing.length === 1 ? "está" : "están"} en tu lista. `,
            btn("Reparar", async () => { await groups.repairGroup(g, watchlist); onChange(); requestSync(); }))
        : "",
      renderAvatars(g, cur, watchlist, onChange),
      body,
      renderItinerary(g, cur, watchlist, onChange),
      el("div", { className: "actions" },
        owned
          ? btn("Borrar grupo", async () => { await groups.removeGroup(g.id); onChange(); requestSync(); })
          // Espera a que la sync termine antes de repintar: así la tarjeta desaparece de
          // verdad en cuanto refreshSubscribedGroups() deje de traerla.
          : btn("Darse de baja", async () => { await groups.unsubscribe(g.user_id, g.id); await requestSync(); onChange(); }))));
}
