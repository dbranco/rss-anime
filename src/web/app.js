import "./proxy.js"; // registra globalThis.__seriesTrackerFetch antes de usar engine.js
import { get, set } from "../app/store.js";
import { signIn, signUp, signOut, getSession } from "../app/sync.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { $, explain } from "./ui/dom.js";
import { fillProviders } from "./ui/state.js";
import { requestSync } from "./ui/sync.js";
import { renderMain, setListFilter } from "./ui/main-list.js";
import { renderConfig } from "./ui/config.js";
import "./ui/search.js";
import "./ui/group-builder.js";
import "./ui/explore.js";

$("#tabAll").onclick = () => setView("all");
$("#tabExplore").onclick = () => setView("explore");
$("#tabConfig").onclick = () => setView("config");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#exploreView").hidden = v !== "explore";
  $("#configView").hidden = v !== "config";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabExplore").classList.toggle("active", v === "explore");
  $("#tabConfig").classList.toggle("active", v === "config");
  if (v === "all") renderMain();
  if (v === "config") renderConfig();
}

$("#listFilter").addEventListener("change", () => {
  setListFilter(document.querySelector('input[name="listf"]:checked').value);
  renderMain();
});

async function renderFeed() {
  const cfg = await get("supabase");
  const token = await get("feed_token");
  $("#feedUrl").value = token && cfg?.url ? `${cfg.url.replace(/\/+$/, "")}/storage/v1/object/public/feeds/${token}.xml` : "(aún no generado por el cron)";
}

async function applyAdminVisibility() {
  const admin = await get("is_admin", false);
  $("#tabConfig").hidden = !admin;
  if (!admin && !$("#configView").hidden) setView("all"); // no lo dejamos varado si deja de ser admin
}

async function sync(quiet = true) {
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders(); await renderMain(); await renderFeed();
    await applyAdminVisibility();
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) $("#authMsg").textContent = "Error de sync: " + explain(e);
  }
}

async function showMain() {
  const s = await getSession();
  $("#authView").hidden = true;
  $("#mainView").hidden = false;
  $("#who").textContent = s.user.email;
  await fillProviders(); await renderMain(); await renderFeed();
  sync();
}

async function showAuth() {
  $("#mainView").hidden = true;
  $("#authView").hidden = false;
}

async function authFlow(fn) {
  const email = $("#email").value.trim(), password = $("#password").value;
  if (!email || !password) { $("#authMsg").textContent = "Escribe email y contraseña"; return; }
  $("#authMsg").textContent = "";
  try {
    const note = await fn(email, password);
    if (note) { $("#authMsg").textContent = note; return; }
    await showMain();
  } catch (e) { $("#authMsg").textContent = "Error: " + e.message; }
}

$("#login").onclick = () => authFlow(async (email, password) => { await signIn(email, password); });
$("#signup").onclick = () => authFlow(async (email, password) => {
  const r = await signUp(email, password);
  if (!r.confirmed) return "Cuenta creada. Confirma el email y vuelve a iniciar sesión.";
});
$("#logout").onclick = async () => { await signOut(); await showAuth(); };

$("#all").onclick = async () => { $("#searchMsg").textContent = "Comprobando…"; await sync(false); $("#searchMsg").textContent = "Listo"; };
$("#copyFeed").onclick = async () => {
  try { await navigator.clipboard.writeText($("#feedUrl").value); $("#copyFeed").textContent = "✓"; setTimeout(() => { $("#copyFeed").textContent = "Copiar"; }, 1500); }
  catch { $("#feedUrl").select(); }
};

(async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  await set("supabase", { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  const s = await getSession();
  if (s) await showMain(); else await showAuth();
})();
