import { get } from "../store.js";
import { mutate } from "../list.js";
import { el } from "./dom.js";
import { requestSync } from "./sync.js";

// Selectores encadenados idioma → pista → proveedor para elegir, por ítem, qué combinación de
// app_config.players usar en "Ver aquí" (ver resolve.js). Solo lista combinaciones que existen
// de verdad — nunca una opción sin proveedor detrás. La elección persiste en item.player_pref
// (ver docs/superpowers/specs/2026-09-29-playback-cascade-design.md); un ítem sin player_pref
// muestra los valores por defecto (lang_pref global, pista "sub", primer proveedor) sin escribir
// nada hasta que el usuario cambie algo.
//
// Devuelve el <div> contenedor de inmediato (síncrono) y lo rellena tras el await — mismo patrón
// que ya usa list-item.js para "Episodios" (evita que itemCard()/groupCard() tengan que volverse
// async, lo que rompería a sus propios llamadores).
export function renderPlayerPrefSelectors(item, onChange) {
  const box = el("div", { className: "row" });

  (async () => {
    const players = await get("players", {});
    const langs = Object.keys(players);
    if (!langs.length) return;

    const tracksFor = lang => ["sub", "dub"].filter(t => (players[lang]?.[t] || []).length);
    const entriesFor = (lang, track) => (track && players[lang]?.[track]) || [];

    // Nunca listar/elegir un idioma sin ninguna pista con providers de verdad debajo (mismo
    // criterio de "solo combinaciones que existen" que ya aplica tracksFor/entriesFor a pista y
    // proveedor) — si no, un idioma sin tracks tumbaba el componente entero aunque otros idiomas
    // configurados sí tuvieran providers.
    const langsWithTracks = langs.filter(l => tracksFor(l).length);
    if (!langsWithTracks.length) return;

    const defaultLang = await get("lang_pref", "es-ES");
    const pref = item.player_pref || {};
    const initialLang = langsWithTracks.includes(pref.lang) ? pref.lang
      : (langsWithTracks.includes(defaultLang) ? defaultLang : langsWithTracks[0]);
    const initialTracks = tracksFor(initialLang);
    if (!initialTracks.length) return;
    const initialTrack = initialTracks.includes(pref.track) ? pref.track : initialTracks[0];
    const initialEntries = entriesFor(initialLang, initialTrack);
    const initialProviderId = initialEntries.find(en => en.id === pref.providerId)?.id || initialEntries[0]?.id;
    if (!initialProviderId) return;

    const langSel = el("select", {});
    const trackSel = el("select", {});
    const providerSel = el("select", {});

    const persist = async () => {
      const next = { lang: langSel.value, track: trackSel.value, providerId: providerSel.value };
      const updated = await mutate(item.tmdb_id, x => { x.player_pref = next; });
      if (updated) Object.assign(item, updated);
      onChange();
      // Fire-and-forget, igual que list-item.js/group-card.js: no se espera (no cambiar el
      // timing de persist()), pero se atrapa el rechazo para no dejar una promesa rechazada
      // sin manejar cuando no hay sesión iniciada o falla la red.
      requestSync().catch(() => {});
    };

    const renderProviders = () => {
      const entries = entriesFor(langSel.value, trackSel.value);
      providerSel.replaceChildren(...entries.map(en =>
        el("option", { value: en.id, textContent: en.rule?.name || en.id })));
    };
    const renderTracks = () => {
      const tracks = tracksFor(langSel.value);
      trackSel.replaceChildren(...tracks.map(t => el("option", { value: t, textContent: t })));
      renderProviders();
    };

    langSel.replaceChildren(...langsWithTracks.map(l => el("option", { value: l, textContent: l })));
    langSel.value = initialLang;
    renderTracks();
    trackSel.value = initialTrack;
    renderProviders();
    providerSel.value = initialProviderId;

    langSel.onchange = () => { renderTracks(); persist(); };
    trackSel.onchange = () => { renderProviders(); persist(); };
    providerSel.onchange = persist;

    box.replaceChildren(langSel, trackSel, providerSel);
  })();

  return box;
}
