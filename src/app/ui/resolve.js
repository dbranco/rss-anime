// Resolución de reproducción: idioma/pista/proveedor elegidos por ítem (item.player_pref, ver
// player-pref.js), resueltos de forma perezosa y cacheados en item.players["<lang>|<track>"].
// Un ítem sin player_pref se comporta como antes: idioma global, pista "sub", primer proveedor
// configurado. Ver docs/superpowers/specs/2026-09-29-playback-cascade-design.md.
import * as engine from "../engine.js";
import * as tmdb from "../tmdb.js";
import { get } from "../store.js";
import { mutate } from "../list.js";
import { el, btn, explain } from "./dom.js";
import { ensurePermissions } from "./permissions.js";
import { renderPlayerPicker } from "./player.js";

// tmdb_id -> { episode, box } del último "Ver aquí" abierto para ese ítem, para poder refrescarlo
// (refreshOpenPlayer) cuando player-pref.js persiste un cambio de idioma/pista/proveedor sin
// tener que rastrear la identidad del objeto `item` (ver comentario sobre eso en group-card.js).
const openPlayers = new Map();

const chosenTrack = item => item.player_pref?.track || "sub";
const chosenLang = async item => item.player_pref?.lang || await get("lang_pref", "es-ES");

async function chosenRule(item, lang, track) {
  const players = await get("players", {});
  const entries = players[lang]?.[track] || [];
  const id = item.player_pref?.providerId;
  return (id && entries.find(e => e.id === id)) || entries[0] || null;
}

// Tercer y último intento: el título "romaji"/"romanization" que TMDB recoge para el país de
// origen de la serie (ej. Japón para anime) — muchos sitios de streaming titulan sus posts así
// en vez de con el original en kanji o el traducido. Solo aplica a tv (origin_country no existe
// en movie). Devuelve null si no hay país de origen o no hay ningún título de ese tipo.
async function originRomajiTitle(item, lang) {
  try {
    const show = await tmdb.getShow(item.tmdb_id, item.media_type, lang);
    if (!show.origin_country) return null;
    const alts = await tmdb.getAlternativeTitles(item.tmdb_id, item.media_type);
    const forCountry = alts.filter(a => a.country === show.origin_country);
    const romaji = forCountry.find(a => /romaji|romanization/i.test(a.type));
    return (romaji || forCountry[0])?.title || null;
  } catch { return null; } // sin conexión/HTTP error: no bloquea el flujo, simplemente no hay 3er intento
}

// Busca `item.title` en el sitio de `entry.rule` y deja elegir el resultado correcto (cacheándolo
// en item.players["<lang>|<track>"] al elegir). Si el título traducido de TMDB no da resultados,
// reintenta con el original_title, y si eso tampoco encuentra nada, con el título romaji del país
// de origen (originRomajiTitle). Siempre busca de cero — para la variante que primero mira la
// caché, ver resolveSlug más abajo (la usa resolveAndPlay en el primer intento; esta la usa el
// botón "Probar con otro resultado" cuando el slug cacheado resultó ser el título equivocado).
async function searchAndPick(item, lang, track, entry, box) {
  const cacheKey = `${lang}|${track}`;
  await ensurePermissions();
  box.textContent = "Buscando en " + entry.id + "…";
  let results;
  try { results = await engine.search(entry.rule, item.title); }
  catch (e) { box.textContent = "Error: " + explain(e); return null; }
  const tried = new Set([item.title]);
  if (!results.length && item.original_title && !tried.has(item.original_title)) {
    tried.add(item.original_title);
    box.textContent = "Sin resultados con \"" + item.title + "\", reintentando con \"" + item.original_title + "\"…";
    try { results = await engine.search(entry.rule, item.original_title); }
    catch (e) { box.textContent = "Error: " + explain(e); return null; }
  }
  if (!results.length) {
    const romaji = await originRomajiTitle(item, lang);
    if (romaji && !tried.has(romaji)) {
      box.textContent = "Sin resultados, reintentando con \"" + romaji + "\"…";
      try { results = await engine.search(entry.rule, romaji); }
      catch (e) { box.textContent = "Error: " + explain(e); return null; }
    }
  }
  if (!results.length) { box.textContent = "Sin resultados en " + entry.id; return null; }

  return new Promise(resolve => {
    box.replaceChildren(...results.map(r => btn(r.title, async () => {
      item.players = item.players || {};
      item.players[cacheKey] = { providerId: entry.id, slug: r.slug };
      await mutate(item.tmdb_id, x => { x.players = item.players; });
      resolve(r.slug);
    })));
  });
}

// Si ya había un slug cacheado para esta combinación lang|track con este mismo proveedor, lo usa
// directo sin volver a buscar; si no, delega en searchAndPick.
async function resolveSlug(item, lang, track, entry, box) {
  const cacheKey = `${lang}|${track}`;
  const cached = item.players?.[cacheKey];
  if (cached && cached.providerId === entry.id) return cached.slug;
  return searchAndPick(item, lang, track, entry, box);
}

export async function resolveAndPlay(item, episode, playerBox) {
  openPlayers.set(item.tmdb_id, { episode, box: playerBox });
  const lang = await chosenLang(item);
  const track = chosenTrack(item);
  const entry = await chosenRule(item, lang, track);
  if (!entry) { playerBox.textContent = `No hay ningún sitio de reproducción configurado para "${lang}" (${track}).`; return; }

  await playEpisode(item, episode, lang, track, entry, playerBox, false);
}

// `forceSearch`: true cuando viene del botón "Probar con otro resultado" — el slug cacheado
// resultó apuntar a un título equivocado (ej. buscaste "Black Clover", el provider portugués
// devolvió varios resultados, elegiste uno pero resultó no tener el episodio), así que hay que
// ignorar la caché y dejar elegir otra vez entre los resultados de la búsqueda, en vez de quedarse
// repitiendo para siempre el mismo slug que no tiene servidores.
async function playEpisode(item, episode, lang, track, entry, box, forceSearch) {
  const slug = forceSearch
    ? await searchAndPick(item, lang, track, entry, box)
    : await resolveSlug(item, lang, track, entry, box);
  if (!slug) return;

  await ensurePermissions();
  box.textContent = "Buscando servidores…";
  const retry = () => playEpisode(item, episode, lang, track, entry, box, true);
  let players;
  try {
    players = await engine.episodePlayers(entry.rule, slug, episode);
  } catch (e) {
    box.replaceChildren(el("div", { textContent: "Error: " + explain(e) }), btn("🔁 Probar con otro resultado", retry));
    return;
  }
  if (!players || (!players.SUB.length && !players.DUB.length)) {
    box.replaceChildren(
      el("div", { textContent: `"${item.title}" no tiene servidores en ${entry.id} para este resultado — puede que el título elegido no fuera el correcto.` }),
      btn("🔁 Probar con otro resultado", retry));
    return;
  }
  renderPlayerPicker(box, players, {
    track: track.toUpperCase(),
    embedBlocked: !!entry.rule.episode?.embed_blocked,
    episodeUrl: engine.episodeUrl(entry.rule, slug, episode)
  });
}

// Vuelve a resolver un "Ver aquí" ya abierto para este ítem (mismo episodio, playerBox todavía en
// el DOM) tras un cambio de idioma/pista/proveedor en player-pref.js — si no, el panel se quedaba
// mostrando servidores de la combinación vieja hasta cerrarlo y volver a abrirlo a mano.
// No-op si nunca se abrió "Ver aquí" para este ítem, o si el panel ya se cerró mientras tanto.
export function refreshOpenPlayer(item) {
  const entry = openPlayers.get(item.tmdb_id);
  if (!entry) return;
  if (!entry.box.isConnected) { openPlayers.delete(item.tmdb_id); return; }
  resolveAndPlay(item, entry.episode, entry.box);
}
