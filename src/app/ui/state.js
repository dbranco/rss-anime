import { get, set } from "../store.js";
import { $, el } from "./dom.js";

// Vinculación viva de ES modules: quien importe `providers` ve el valor actual sin
// necesidad de una función getter — reasignarlo aquí se refleja en todos los importadores.
export let providers = [];
export const prov = id => providers.find(p => p.id === id);

export async function fillProviders() {
  providers = await get("providers", []);
  await renderLangFilter();
}

// Un checkbox por cada idioma distinto que declaren los providers (providers sin "language"
// caen en "?"). La selección se recuerda localmente; sin preferencia guardada, todo marcado.
export async function renderLangFilter() {
  const langs = [...new Set(providers.map(p => p.language || "?"))].sort();
  const saved = await get("search_languages", null);
  $("#langFilter").replaceChildren(...langs.map(l => {
    const cb = el("input", { type: "checkbox", checked: saved ? saved.includes(l) : true });
    cb.dataset.lang = l;
    cb.onchange = () => set("search_languages", selectedLangs());
    return el("label", {}, cb, l.toUpperCase());
  }));
}

export const selectedLangs = () => [...$("#langFilter").querySelectorAll("input:checked")].map(c => c.dataset.lang);

export async function getLangPref() { return get("lang_pref", "es-ES"); }
export async function setLangPref(lang) { return set("lang_pref", lang); }
