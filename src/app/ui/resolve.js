// Resolución de reproducción: idioma/pista/proveedor elegidos por ítem (item.player_pref, ver
// player-pref.js), resueltos de forma perezosa y cacheados en item.players["<lang>|<track>"].
// Un ítem sin player_pref se comporta como antes: idioma global, pista "sub", primer proveedor
// configurado. Ver docs/superpowers/specs/2026-09-29-playback-cascade-design.md.
import * as engine from "../engine.js";
import * as tmdb from "../tmdb.js";
import { get } from "../store.js";
import { mutate } from "../list.js";
import { btn, explain } from "./dom.js";
import { ensurePermissions } from "./permissions.js";
import { renderPlayerPicker } from "./player.js";

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

// Busca el slug de `item.title` en el sitio de `entry.rule`, deja elegir el resultado correcto,
// y lo cachea en item.players["<lang>|<track>"]. Si ya había algo cacheado para esa combinación
// y ese proveedor, lo usa directo sin volver a buscar. Si el título traducido de TMDB no da
// resultados, reintenta con el original_title, y si eso tampoco encuentra nada, con el título
// romaji del país de origen (originRomajiTitle).
async function resolveSlug(item, lang, track, entry, box) {
  const cacheKey = `${lang}|${track}`;
  const cached = item.players?.[cacheKey];
  if (cached && cached.providerId === entry.id) return cached.slug;

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

export async function resolveAndPlay(item, episode, playerBox) {
  const lang = await chosenLang(item);
  const track = chosenTrack(item);
  const entry = await chosenRule(item, lang, track);
  if (!entry) { playerBox.textContent = `No hay ningún sitio de reproducción configurado para "${lang}" (${track}).`; return; }

  const slug = await resolveSlug(item, lang, track, entry, playerBox);
  if (!slug) return;

  await ensurePermissions();
  playerBox.textContent = "Buscando servidores…";
  try {
    const players = await engine.episodePlayers(entry.rule, slug, episode);
    renderPlayerPicker(playerBox, players, {
      embedBlocked: !!entry.rule.episode?.embed_blocked,
      episodeUrl: engine.episodeUrl(entry.rule, slug, episode)
    });
  } catch (e) { playerBox.textContent = "Error: " + explain(e); }
}
