import { get } from "../../app/store.js";
import { saveAppPlayers } from "../../app/sync.js";
import { $, explain } from "../../app/ui/dom.js";

export async function renderConfig() {
  $("#playersJson").value = JSON.stringify(await get("players", {}), null, 2);
  $("#tmdbKey").value = (await get("tmdb_key")) || "";
  $("#configMsg").textContent = "";
}

function validatePlayers(obj) {
  if (typeof obj !== "object" || Array.isArray(obj)) throw new Error("Debe ser un objeto { idioma: { sub: [...], dub: [...] } }");
  for (const [lang, tracks] of Object.entries(obj)) {
    for (const track of ["sub", "dub"]) {
      for (const entry of (tracks[track] || [])) {
        if (!entry.id || !entry.rule) throw new Error(`Falta id/rule en ${lang}.${track}`);
        for (const k of ["base_url", "search", "episode"]) if (!entry.rule[k]) throw new Error(`Falta rule.${k} en ${lang}.${track}.${entry.id}`);
        if (!entry.rule.search.slug_regex) throw new Error(`Falta rule.search.slug_regex en ${lang}.${track}.${entry.id}`);
        new URL(entry.rule.base_url);
      }
    }
  }
}

$("#saveConfigBtn").onclick = async () => {
  let players;
  try {
    players = JSON.parse($("#playersJson").value);
    validatePlayers(players);
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  try { await saveAppPlayers(players, $("#tmdbKey").value.trim() || null); }
  catch (e) { $("#configMsg").textContent = "Error al guardar: " + explain(e); return; }
  $("#configMsg").textContent = "Guardado.";
};
