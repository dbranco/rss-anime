import { get } from "../../extension/store.js";
import { saveAppProviders } from "../../extension/sync.js";
import { $, explain } from "./dom.js";
import { fillProviders } from "./state.js";

export async function renderConfig() {
  $("#providersJson").value = JSON.stringify(await get("providers", []), null, 2);
  $("#configMsg").textContent = "";
}

$("#saveProvidersBtn").onclick = async () => {
  let arr;
  try {
    arr = JSON.parse($("#providersJson").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  try { await saveAppProviders(arr); }
  catch (e) { $("#configMsg").textContent = "Error al guardar: " + explain(e); return; }
  await fillProviders();
  $("#configMsg").textContent = "Guardado.";
};
