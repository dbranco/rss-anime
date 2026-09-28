// Resolución básica de reproducción: un solo sitio (el primero configurado para el idioma del
// usuario en pista SUB), resuelto de forma perezosa y cacheado en item.players. Plan A no
// implementa la cascada completa de idioma/pista/sitio con memoria — eso es Plan B.
import * as engine from "../engine.js";
import { get } from "../store.js";
import { mutate } from "../list.js";
import { btn, explain } from "./dom.js";
import { ensurePermissions } from "./permissions.js";
import { renderPlayerPicker } from "./player.js";

async function firstRule(lang) {
  const players = await get("players", {});
  const entry = players[lang]?.sub?.[0];
  return entry || null;
}

// Busca el slug de `item.title` en el sitio de `entry.rule`, deja elegir el resultado correcto,
// y lo cachea en item.players["lang|sub"]. Si ya había algo cacheado para ese sitio, lo usa
// directo sin volver a buscar. Si el título traducido de TMDB no da resultados, reintenta con
// el original_title (el sitio puede indexar por el título japonés/original en vez del traducido).
async function resolveSlug(item, lang, entry, box) {
  const cacheKey = `${lang}|sub`;
  const cached = item.players?.[cacheKey];
  if (cached && cached.providerId === entry.id) return cached.slug;

  await ensurePermissions();
  box.textContent = "Buscando en " + entry.id + "…";
  let results;
  try { results = await engine.search(entry.rule, item.title); }
  catch (e) { box.textContent = "Error: " + explain(e); return null; }
  if (!results.length && item.original_title && item.original_title !== item.title) {
    box.textContent = "Sin resultados con \"" + item.title + "\", reintentando con \"" + item.original_title + "\"…";
    try { results = await engine.search(entry.rule, item.original_title); }
    catch (e) { box.textContent = "Error: " + explain(e); return null; }
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
  const lang = await get("lang_pref", "es-ES");
  const entry = await firstRule(lang);
  if (!entry) { playerBox.textContent = `No hay ningún sitio de reproducción configurado para "${lang}".`; return; }

  const slug = await resolveSlug(item, lang, entry, playerBox);
  if (!slug) return;

  await ensurePermissions();
  playerBox.textContent = "Buscando servidores…";
  try { renderPlayerPicker(playerBox, await engine.episodePlayers(entry.rule, slug, episode)); }
  catch (e) { playerBox.textContent = "Error: " + explain(e); }
}
