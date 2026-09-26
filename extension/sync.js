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
// se borra "session", los datos de la cuenta anterior (watchlist, grupos, suscripciones,
// feed_token...) se quedan en el dispositivo y, al iniciar sesión con OTRA cuenta, el merge por
// updated_at de syncWatchlist/syncGroups/syncSubscriptions los sube como si fueran suyos — fuga
// real de datos entre cuentas, no solo un glitch visual. `providers`/`interval`/`supabase` no se
// limpian: son config compartida de la app o del dispositivo, no datos de la cuenta.
export const signOut = () => Promise.all([
  set("session", null),
  set("is_admin", false),
  set("watchlist", []),
  set("groups", []),
  set("group_subscriptions", []),
  set("subscribed_groups", []),
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
    id: r.id, name: r.name, steps: r.steps, public: !!r.public, deleted: r.deleted, updated_at: r.updated_at
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
        user_id: uid, id: x.id, name: x.name, steps: x.steps, public: !!x.public,
        deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("groups", [])) === snapshot) await set("groups", [...merged.values()]);
}

async function syncSubscriptions(uid) {
  const remote = (await rest(`group_subscriptions?select=*&user_id=eq.${uid}`)).map(r => ({
    owner_id: r.owner_id, group_id: r.group_id, deleted: r.deleted, updated_at: r.updated_at
  }));
  const local = await get("group_subscriptions", []);
  const snapshot = JSON.stringify(local);
  const key = x => `${x.owner_id}|${x.group_id}`;
  const merged = new Map(remote.map(x => [key(x), x]));
  const toPush = [];
  for (const l of local) {
    if (!l.updated_at) l.updated_at = now();
    const r = merged.get(key(l));
    if (!r || ts(l.updated_at) > ts(r.updated_at)) { merged.set(key(l), l); toPush.push(l); }
  }
  if (toPush.length) {
    await rest("group_subscriptions?on_conflict=user_id,owner_id,group_id", {
      method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
      body: toPush.map(x => ({
        user_id: uid, owner_id: x.owner_id, group_id: x.group_id,
        deleted: !!x.deleted, updated_at: x.updated_at
      }))
    });
  }
  if (JSON.stringify(await get("group_subscriptions", [])) === snapshot) await set("group_subscriptions", [...merged.values()]);
}

// Trae, en modo solo lectura, el grupo original de cada suscripción viva. No se sube nunca
// (la propiedad y edición son siempre del dueño); se sobrescribe entera en cada sync. Si el
// grupo se volvió privado o se borró, simplemente deja de traerlo (la RLS ya no lo permite).
async function refreshSubscribedGroups() {
  const subs = (await get("group_subscriptions", [])).filter(s => !s.deleted);
  const out = [];
  for (const s of subs) {
    const [g] = await rest(`groups?select=*&user_id=eq.${s.owner_id}&id=eq.${s.group_id}`);
    if (g) out.push(g);
  }
  await set("subscribed_groups", out);
}

// Trae TODOS los grupos públicos que matcheen el nombre (sin paginar en SQL — a esta escala
// no hace falta) y les calcula la media de estrellas en el cliente para poder ordenar por
// ella; la paginación de 10 en 10 la hace la UI troceando este array ya ordenado.
export async function searchPublicGroups(query) {
  const q = encodeURIComponent(`*${query}*`);
  const found = await rest(`groups?select=*&public=eq.true&name=ilike.${q}`);
  if (!found.length) return [];
  const owners = [...new Set(found.map(g => g.user_id))].join(",");
  const ids = [...new Set(found.map(g => g.id))].join(",");
  const ratings = await rest(`group_ratings?select=owner_id,group_id,stars&owner_id=in.(${owners})&group_id=in.(${ids})`);
  const avg = new Map();
  for (const r of ratings) {
    const k = `${r.owner_id}|${r.group_id}`;
    const cur = avg.get(k) || { sum: 0, n: 0 };
    cur.sum += r.stars; cur.n += 1;
    avg.set(k, cur);
  }
  return found
    .map(g => {
      const a = avg.get(`${g.user_id}|${g.id}`);
      return { ...g, rating_avg: a ? a.sum / a.n : null, rating_count: a?.n || 0 };
    })
    .sort((a, b) => (b.rating_avg || 0) - (a.rating_avg || 0));
}

export async function rateGroup(ownerId, groupId, stars) {
  const s = await session();
  await rest("group_ratings?on_conflict=user_id,owner_id,group_id", {
    method: "POST", prefer: "resolution=merge-duplicates,return=minimal",
    body: [{ user_id: s.user.id, owner_id: ownerId, group_id: groupId, stars, updated_at: now() }]
  });
}

export async function syncNow() {
  const s = await session();
  await syncFeedToken(s.user.id);
  await syncAppConfig(s.user.id);
  await syncWatchlist(s.user.id);
  await syncGroups(s.user.id);
  await syncSubscriptions(s.user.id);
  await refreshSubscribedGroups();
  await set("last_sync", now());
}
