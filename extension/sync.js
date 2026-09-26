// Login (email + contraseña) y sincronización con Supabase usando solo fetch (sin dependencias).
// Estrategia: la fila más reciente (updated_at) gana; los borrados se propagan con deleted=true.
import { get, set } from "./store.js";

const now = () => new Date().toISOString();
const ts = s => (s ? Date.parse(s) || 0 : 0);

async function config() {
  const c = await get("supabase");
  if (!c?.url || !c?.anonKey) throw new Error("Configura la URL y la anon key de Supabase en Opciones");
  return { url: c.url.replace(/\/+$/, ""), anonKey: c.anonKey };
}

async function saveSession(j) {
  const session = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    user: { id: j.user.id, email: j.user.email }
  };
  await set("session", session);
  return session;
}

async function auth(path, body) {
  const { url, anonKey } = await config();
  const r = await fetch(`${url}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.msg || j.error_description || j.message || `HTTP ${r.status}`);
  return j;
}

export async function signIn(email, password) {
  return saveSession(await auth("token?grant_type=password", { email, password }));
}

export async function signUp(email, password) {
  const j = await auth("signup", { email, password });
  if (j.access_token) { await saveSession(j); return { confirmed: true }; }
  return { confirmed: false }; // Supabase pide confirmar el email antes de iniciar sesión
}

// chrome.storage.local / localStorage no están aislados por cuenta: si al cerrar sesión solo
// se borra "session", los datos de la cuenta anterior (watchlist, grupos, feed_token...) se
// quedan en el dispositivo y, al iniciar sesión con OTRA cuenta, el merge por updated_at de
// syncWatchlist/syncGroups los sube como si fueran suyos — fuga real de datos entre cuentas,
// no solo un glitch visual. `providers`/`interval`/`supabase` no se limpian: son config
// compartida de la app o del dispositivo, no datos de la cuenta.
export const signOut = () => Promise.all([
  set("session", null),
  set("is_admin", false),
  set("watchlist", []),
  set("groups", []),
  set("feed_token", null),
  set("news", []),
  set("notified", []),
  set("last_sync", null)
]).then(() => {});
export const getSession = () => get("session", null);

async function session() {
  let s = await get("session");
  if (!s) throw new Error("No has iniciado sesión");
  if (s.expires_at - 60 < Date.now() / 1000) {
    s = await saveSession(await auth("token?grant_type=refresh_token", { refresh_token: s.refresh_token }));
  }
  return s;
}

async function rest(path, { method = "GET", body, prefer } = {}) {
  const { url, anonKey } = await config();
  const s = await session();
  const r = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${s.access_token}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.message || `HTTP ${r.status} en ${path.split("?")[0]}`);
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// Asegura que exista la fila de user_settings del usuario (para su feed_token) y lo lee.
// providers ya no vive aquí: ver syncAppConfig.
async function syncFeedToken(uid) {
  const [row] = await rest(`user_settings?select=feed_token&user_id=eq.${uid}`);
  if (row?.feed_token) { await set("feed_token", row.feed_token); return; }
  await rest("user_settings?on_conflict=user_id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ user_id: uid }]
  });
  const [created] = await rest(`user_settings?select=feed_token&user_id=eq.${uid}`);
  if (created?.feed_token) await set("feed_token", created.feed_token);
}

// providers es config de la app (no por usuario): todos hacen pull de app_config,
// solo el admin (fila en `admins`) puede escribir con saveAppProviders().
async function syncAppConfig(uid) {
  const [row] = await rest("app_config?select=providers,updated_at&id=eq.1");
  // Sin fila remota no pisamos nada: en una instalación nueva lo que hay en local es la
  // semilla de providers.example.json (o el borrador del admin antes de guardar).
  if (row) {
    await set("providers", row.providers || []);
    await set("providers_updated_at", row.updated_at || null);
  }
  const adminRows = await rest(`admins?select=user_id&user_id=eq.${uid}`);
  await set("is_admin", adminRows.length > 0);
}

export async function saveAppProviders(arr) {
  await session();
  const t = now();
  await rest("app_config?on_conflict=id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ id: 1, providers: arr, updated_at: t }]
  });
  await set("providers", arr);
  await set("providers_updated_at", t);
}

async function syncWatchlist(uid) {
  const remote = (await rest(`watchlist?select=*&user_id=eq.${uid}`)).map(r => ({
    provider: r.provider_id, slug: r.slug, title: r.title, link: r.link, image: r.image,
    last: r.last, deleted: r.deleted, updated_at: r.updated_at
  }));
  const local = await get("watchlist", []);
  const snapshot = JSON.stringify(local);
  const key = x => `${x.provider}|${x.slug}`;
  const merged = new Map(remote.map(x => [key(x), x]));
  const toPush = [];
  for (const l of local) {
    if (!l.updated_at) l.updated_at = now();
    const r = merged.get(key(l));
    if (!r || ts(l.updated_at) > ts(r.updated_at)) { merged.set(key(l), l); toPush.push(l); }
  }
  if (toPush.length) {
    await rest("watchlist?on_conflict=user_id,provider_id,slug", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: toPush.map(x => ({
        user_id: uid, provider_id: x.provider, slug: x.slug, title: x.title,
        link: x.link || null, image: x.image || null, last: x.last || 0,
        deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  // Si la lista cambió mientras sincronizábamos, no la pisamos: la próxima sync lo arregla.
  if (JSON.stringify(await get("watchlist", [])) === snapshot) await set("watchlist", [...merged.values()]);
}

async function syncGroups(uid) {
  const remote = (await rest(`groups?select=*&user_id=eq.${uid}`)).map(r => ({
    id: r.id, name: r.name, steps: r.steps, deleted: r.deleted, updated_at: r.updated_at
  }));
  const local = await get("groups", []);
  const snapshot = JSON.stringify(local);
  const key = x => x.id;
  const merged = new Map(remote.map(x => [key(x), x]));
  const toPush = [];
  for (const l of local) {
    if (!l.updated_at) l.updated_at = now();
    const r = merged.get(key(l));
    if (!r || ts(l.updated_at) > ts(r.updated_at)) { merged.set(key(l), l); toPush.push(l); }
  }
  if (toPush.length) {
    await rest("groups?on_conflict=user_id,id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: toPush.map(x => ({
        user_id: uid, id: x.id, name: x.name, steps: x.steps, deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("groups", [])) === snapshot) await set("groups", [...merged.values()]);
}

export async function syncNow() {
  const s = await session();
  await syncFeedToken(s.user.id);
  await syncAppConfig(s.user.id);
  await syncWatchlist(s.user.id);
  await syncGroups(s.user.id);
  await set("last_sync", now());
}
