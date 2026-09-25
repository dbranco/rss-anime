import { get, set } from "./store.js";
import { signIn, signUp, signOut, getSession } from "./sync.js";
import { requestSync } from "./syncClient.js";

const $ = s => document.querySelector(s);
const status = (t, bad) => { const s = $("#status"); s.textContent = t; s.style.color = bad ? "#c33" : "#2a7"; };
const sbMsg = (t, bad) => { const s = $("#sbStatus"); s.textContent = t; s.style.color = bad ? "#c33" : ""; };

async function loadProviders() {
  $("#json").value = JSON.stringify(await get("providers", []), null, 2);
  $("#interval").value = await get("interval", 60);
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
  await loadProviders();
  const c = await get("supabase", {});
  $("#sbUrl").value = c.url || "";
  $("#sbKey").value = c.anonKey || "";
  renderSb();
}

$("#save").onclick = () => {
  let arr;
  try {
    arr = JSON.parse($("#json").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { return status("JSON no válido: " + e.message, true); }

  // Debe llamarse directamente desde el clic (gesto del usuario)
  const origins = [...new Set(arr.map(p => { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }))];
  chrome.permissions.request({ origins }).then(async granted => {
    await set("providers", arr);
    await set("providers_updated_at", new Date().toISOString());
    await set("interval", Math.max(10, +$("#interval").value || 60));
    status(granted ? "Guardado y permisos concedidos." : "Guardado, pero SIN permiso a los dominios: las búsquedas fallarán.", !granted);
    try { if (await getSession()) { await requestSync(); renderSb(); } } catch (e) { status("Guardado, pero la sync falló: " + e.message, true); }
  });
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
  await loadProviders();
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
  try { await saveCfg(); await requestSync(); await loadProviders(); await renderSb(); sbMsg("Sincronizado"); }
  catch (e) { sbMsg("Error: " + e.message, true); }
};

init();
