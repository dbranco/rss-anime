// Registra el gancho que engine.js usa cuando no puede hacer fetch directo a un provider
// (CORS, ver README de web/). Pasa por la Edge Function "proxy", protegida por el JWT de la sesión.
import { get } from "../extension/store.js";

globalThis.__seriesTrackerFetch = async url => {
  const cfg = await get("supabase");
  const session = await get("session");
  if (!cfg?.url || !cfg?.anonKey) throw new Error("Configura la URL y la clave de Supabase primero");
  if (!session?.access_token) throw new Error("Inicia sesión para poder consultar providers");

  const base = cfg.url.replace(/\/+$/, "");
  const r = await fetch(`${base}/functions/v1/proxy?url=${encodeURIComponent(url)}`, {
    headers: { Authorization: `Bearer ${session.access_token}`, apikey: cfg.anonKey }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return { status: data.status, html: data.html, finalUrl: data.url || url };
};
