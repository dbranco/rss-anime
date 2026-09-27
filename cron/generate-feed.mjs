// Cron: para cada usuario de Supabase revisa su lista comparando `last` contra el calendario de
// emisión de TMDB (Task 1, src/app/tmdb.js) — ya no scrapea sitios de terceros — guarda los
// episodios nuevos en episodes_found y publica su feed RSS.
//
// Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY (¡secreta!, solo aquí),
//   TMDB_LANG (opcional: idioma de los nombres de episodio, por defecto es-ES)
//   FEED_OUT_DIR (opcional: escribe también los .xml en esa carpeta)
//   NO_UPLOAD=1  (no subir a Supabase Storage)   SHOW_URL=1 (imprime la URL secreta del feed)
import fs from "node:fs";
import path from "node:path";

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!BASE || !KEY) { console.error("Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY"); process.exit(1); }
const OUT_DIR = process.env.FEED_OUT_DIR;
const UPLOAD = process.env.NO_UPLOAD !== "1";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(p, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${BASE}/rest/v1/${p}`, {
    method,
    headers: { ...H, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`Supabase ${method} ${p.split("?")[0]}: HTTP ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const esc = s => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

function buildRss(selfUrl, rows) {
  const items = rows.map(r =>
    `<item><title>${esc(r.title)}</title><link>${esc(r.link)}</link>` +
    `<guid isPermaLink="false">${esc(`${r.tmdb_id}-e${r.episode}`)}</guid>` +
    `<pubDate>${new Date(r.found_at).toUTCString()}</pubDate><description>${esc(r.tmdb_id)}</description></item>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Mis series</title>` +
    `<link>${esc(selfUrl)}</link><description>Episodios nuevos de mi lista</description>${items}</channel></rss>`;
}

async function publish(token, xml) {
  const name = `${token}.xml`;
  const url = `${BASE}/storage/v1/object/public/feeds/${name}`;
  if (OUT_DIR) { fs.mkdirSync(OUT_DIR, { recursive: true }); fs.writeFileSync(path.join(OUT_DIR, name), xml); }
  if (UPLOAD) {
    const r = await fetch(`${BASE}/storage/v1/object/feeds/${name}`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/rss+xml", "x-upsert": "true" },
      body: xml
    });
    if (!r.ok) throw new Error(`Subida del feed: HTTP ${r.status} ${await r.text()}`);
  }
  // No imprimimos la URL por defecto: en GitHub Actions los logs de repos públicos son públicos.
  console.log(process.env.SHOW_URL === "1" ? `Feed: ${url}` : `Feed publicado (…${token.slice(-4)})`);
}

// Desviación deliberada de la spec original: la TMDB key se lee de la misma fila de app_config
// que ya gestiona el admin (Task 5), no de un secret de GitHub Actions aparte. A diferencia de
// SUPABASE_SERVICE_KEY (la credencial que da acceso a Supabase, no puede vivir dentro de la
// propia base de datos que desbloquea), la TMDB key no tiene ese problema de arranque: el cron
// ya tiene acceso de servicio a Supabase, y la key ya se decidió segura de exponer también en
// cliente. Una sola fuente de verdad evita que las dos copias se desincronicen.
const [appConfig] = await rest("app_config?select=players,tmdb_key&id=eq.1");
globalThis.__tmdbApiKey = appConfig?.tmdb_key || null;
const players = appConfig?.players || {};
if (!Object.keys(players).length) console.warn("app_config vacío: ningún player configurado todavía");
const lang = process.env.TMDB_LANG || "es-ES";
const tmdb = await import("../src/app/tmdb.js");

const settings = await rest("user_settings?select=user_id,feed_token");
const watch = await rest("watchlist?select=*&deleted=eq.false");
const found = await rest("episodes_found?select=*&order=found_at.desc");

for (const st of settings) {
  try {
    const mine = watch.filter(w => w.user_id === st.user_id);
    const known = found.filter(f => f.user_id === st.user_id);
    const fresh = [];

    // El loop cubre cualquier ítem de la watchlist, sea suelto o solo exista para trackear un
    // paso de grupo (visible:false) — repairGroup (Task 4) ya garantiza que todo paso de grupo
    // tiene su fila de watchlist, así que no hace falta un chequeo de grupos aparte.
    for (const it of mine) {
      if (it.media_type !== "tv") continue; // las películas no tienen calendario de episodios
      let episodes;
      try { episodes = await tmdb.getSeasonEpisodes(it.tmdb_id, 1, lang); }
      catch (e) { console.warn(`Fallo en ${it.title}: ${e.message}`); continue; }
      const have = new Set(known.filter(f => f.tmdb_id === it.tmdb_id).map(f => f.episode));
      const today = new Date().toISOString().slice(0, 10);
      for (const e of episodes) {
        if (e.number <= it.last || have.has(e.number)) continue;
        if (!e.air_date || e.air_date > today) break; // episodios vienen ordenados, el resto es futuro
        fresh.push({ user_id: st.user_id, tmdb_id: it.tmdb_id, episode: e.number,
                     title: `${it.title} — episodio ${e.number}`,
                     link: `https://www.themoviedb.org/tv/${it.tmdb_id}` });
        console.log(`Nuevo: ${it.title} ep ${e.number}`);
      }
    }

    if (fresh.length) {
      await rest("episodes_found?on_conflict=user_id,tmdb_id,episode", {
        method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: fresh
      });
    }

    const inList = new Set(mine.map(w => w.tmdb_id));
    const rows = [...fresh.map(f => ({ ...f, found_at: new Date().toISOString() })), ...known]
      .filter(r => inList.has(r.tmdb_id))
      .slice(0, 100);
    await publish(st.feed_token, buildRss(`${BASE}/storage/v1/object/public/feeds/${st.feed_token}.xml`, rows));
  } catch (e) {
    console.error(`Fallo con el usuario ${String(st.user_id).slice(0, 8)}…: ${e.message}`); // uno roto no tumba al resto
    process.exitCode = 1;
  }
}
