import { get, set } from "../store.js";

export async function getLangPref() { return get("lang_pref", "es-ES"); }
export async function setLangPref(lang) { return set("lang_pref", lang); }
