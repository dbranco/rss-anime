// Cliente de la API pública de TMDB (v3): búsqueda, detalle de serie/película, episodios de
// temporada. Es la única fuente de metadata — engine.js sigue existiendo para resolver EN QUÉ
// SITIO de reproducción está cada serie (ver src/app/ui/resolve.js, Task 6), no para buscarla.
import { get } from "./store.js";

const BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";

// El cron (Node, sin chrome.storage ni localStorage) no puede pasar por store.js — fija
// globalThis.__tmdbApiKey directamente en vez de sembrar el storage del navegador. Mismo
// patrón que ya usa engine.js con globalThis.__seriesTrackerFetch para el proxy de la PWA.
async function apiKey() {
  const k = globalThis.__tmdbApiKey ?? await get("tmdb_key");
  if (!k) throw new Error("Falta configurar la API key de TMDB");
  return k;
}

async function call(path, params = {}) {
  const k = await apiKey();
  const qs = new URLSearchParams({ api_key: k, ...params });
  const r = await fetch(`${BASE}${path}?${qs}`);
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`);
  return r.json();
}

export const posterUrl = (posterPath, size = "w342") =>
  posterPath ? `${IMG_BASE}/${size}${posterPath}` : null;

// Busca series y películas a la vez; TMDB también devuelve personas en /search/multi, se filtran.
// original_title: TMDB lo expone como original_name (tv) u original_title (movie) según el tipo —
// se normaliza a un solo campo. Sirve como segundo intento de búsqueda en un sitio de reproducción
// cuando el título traducido no da resultados (ver src/app/ui/resolve.js).
export async function search(query, lang) {
  const j = await call("/search/multi", { query, language: lang, include_adult: "false" });
  return (j.results || [])
    .filter(r => r.media_type === "tv" || r.media_type === "movie")
    .map(r => ({
      tmdb_id: r.id,
      media_type: r.media_type,
      title: r.title || r.name,
      original_title: r.original_name || r.original_title || null,
      poster_path: r.poster_path || null,
      year: (r.release_date || r.first_air_date || "").slice(0, 4)
    }));
}

export async function getShow(tmdbId, mediaType, lang) {
  const j = await call(`/${mediaType}/${tmdbId}`, { language: lang });
  return {
    tmdb_id: tmdbId,
    media_type: mediaType,
    title: j.title || j.name,
    original_title: j.original_name || j.original_title || null,
    poster_path: j.poster_path || null,
    // TMDB solo expone origin_country en tv (no en movie). Es el tercer y último intento de
    // búsqueda en un sitio de reproducción (ver resolve.js): con ese país se busca en
    // getAlternativeTitles() un título "romaji"/"romanization" — el que muchos sitios de anime
    // usan en vez del original en kanji o el traducido.
    origin_country: mediaType === "tv" ? (j.origin_country?.[0] || null) : null,
    // Solo temporadas reales (la 0 de TMDB son especiales/OVAs, no cuentan para el flujo normal).
    seasons: mediaType === "tv" ? (j.seasons || []).map(s => s.season_number).filter(n => n > 0) : null
  };
}

// Títulos alternativos por país que TMDB recopila para esta serie/película (ver resolve.js:
// tercer intento de búsqueda, cuando el título traducido y el original no dan resultados).
export async function getAlternativeTitles(tmdbId, mediaType) {
  const j = await call(`/${mediaType}/${tmdbId}/alternative_titles`);
  const list = mediaType === "movie" ? j.titles : j.results;
  return (list || []).map(t => ({ country: t.iso_3166_1, title: t.title, type: t.type || "" }));
}

// Episodios de una temporada, con fecha de emisión (para saber si "ya salió"). Solo aplica a
// media_type "tv" — una película no tiene temporadas/episodios.
export async function getSeasonEpisodes(tmdbId, season, lang) {
  const j = await call(`/tv/${tmdbId}/season/${season}`, { language: lang });
  return (j.episodes || []).map(e => ({
    number: e.episode_number,
    name: e.name,
    air_date: e.air_date || null
  }));
}
