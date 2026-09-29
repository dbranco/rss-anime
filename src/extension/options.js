import { get, set } from "../app/store.js";
import { signIn, signUp, signOut, getSession, saveAppPlayers } from "../app/sync.js";
import { getLangPref, setLangPref } from "../app/ui/state.js";
import { requestSync } from "./syncClient.js";

const $ = s => document.querySelector(s);
const status = (t, bad) => { const s = $("#status"); s.textContent = t; s.style.color = bad ? "#c33" : "#2a7"; };
const sbMsg = (t, bad) => { const s = $("#sbStatus"); s.textContent = t; s.style.color = bad ? "#c33" : ""; };

function validatePlayers(obj) {
  if (typeof obj !== "object" || Array.isArray(obj)) throw new Error("Debe ser un objeto { idioma: { sub: [...], dub: [...] } }");
  for (const [lang, tracks] of Object.entries(obj)) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang)) throw new Error(`La clave de idioma "${lang}" no parece un código de idioma válido (ej. "es-ES")`);
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

async function loadConfig() {
  $("#json").value = JSON.stringify(await get("players", {}), null, 2);
  $("#tmdbKey").value = (await get("tmdb_key")) || "";
  $("#interval").value = await get("interval", 60);
  $("#langPref").value = await getLangPref();
  const admin = await get("is_admin", false);
  $("#providersSection").hidden = !admin;
  $("#providersReadonly").hidden = admin;
}

async function renderSb() {
  const s = await getSession();
  const last = await get("last_sync");
  $("#sbStatus").textContent = s
    ? `Sesión: ${s.user.email}` + (last ? ` · última sync ${new Date(last).toLocaleString()}` : "")
    : "Sin sesión";
  const c = await get("supabase");
  const token = await get("feed_token");
  $("#feedUrl").textContent = token && c?.url
    ? `Feed RSS (lo genera el cron): ${c.url.replace(/\/+$/, "")}/storage/v1/object/public/feeds/${token}.xml`
    : "";
}

async function init() {
  await loadConfig();
  const c = await get("supabase", {});
  $("#sbUrl").value = c.url || "";
  $("#sbKey").value = c.anonKey || "";
  renderSb();
}

$("#save").onclick = () => {
  let players;
  try {
    players = JSON.parse($("#json").value);
    validatePlayers(players); // misma función que config.js — puedes duplicarla aquí, este archivo no comparte módulo con la PWA
  } catch (e) { return status("JSON no válido: " + e.message, true); }

  const origins = [...new Set(
    Object.values(players).flatMap(tracks =>
      ["sub", "dub"].flatMap(t => (tracks[t] || []).map(entry => {
        const u = new URL(entry.rule.base_url);
        return `${u.protocol}//${u.hostname}/*`;
      }))
    )
  )];
  chrome.permissions.request({ origins }).then(async granted => {
    try { await saveAppPlayers(players, $("#tmdbKey").value.trim() || null); }
    catch (e) { return status("Error al guardar: " + e.message, true); }
    status(granted ? "Guardado y permisos concedidos." : "Guardado, pero SIN permiso a los dominios: las búsquedas fallarán.", !granted);
    await loadConfig();
  });
};

$("#saveInterval").onclick = async () => {
  await set("interval", Math.max(10, +$("#interval").value || 60));
  $("#intervalStatus").textContent = "Guardado.";
};

$("#saveLang").onclick = async () => {
  await setLangPref($("#langPref").value);
  $("#langStatus").textContent = "Guardado.";
};

// Pide permiso para el dominio de Supabase; debe ser lo primero que ocurre en el clic.
function askSupabasePermission() {
  const u = new URL($("#sbUrl").value.trim());
  return chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
}

async function saveCfg() {
  await set("supabase", { url: $("#sbUrl").value.trim().replace(/\/+$/, ""), anonKey: $("#sbKey").value.trim() });
}

async function authFlow(fn) {
  let perm;
  try { perm = askSupabasePermission(); } catch { return sbMsg("URL de Supabase no válida", true); }
  if (!(await perm)) return sbMsg("Sin permiso para el dominio de Supabase", true);
  const email = $("#email").value.trim(), password = $("#password").value;
  if (!email || !password) return sbMsg("Escribe email y contraseña", true);
  try {
    await saveCfg();
    var note = await fn(email, password);
  } catch (e) { return sbMsg("Error: " + e.message, true); }
  await loadConfig();
  await renderSb();
  if (note) sbMsg(note);
}

$("#login").onclick = () => authFlow(async (email, password) => { await signIn(email, password); await requestSync(); });
$("#signup").onclick = () => authFlow(async (email, password) => {
  const r = await signUp(email, password);
  if (r.confirmed) { await requestSync(); return; }
  return "Cuenta creada. Confirma el email que te ha enviado Supabase y luego pulsa Iniciar sesión.";
});
$("#logout").onclick = async () => { await signOut(); renderSb(); };
$("#syncnow").onclick = async () => {
  try { await saveCfg(); await requestSync(); await loadConfig(); await renderSb(); sbMsg("Sincronizado"); }
  catch (e) { sbMsg("Error: " + e.message, true); }
};

init();
