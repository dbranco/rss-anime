// Cron: para cada usuario de Supabase revisa su lista con el mismo motor que la extensión
// (extension/engine.js), guarda los episodios nuevos en episodes_found y publica su feed RSS.
//
// Variables: SUPABASE_URL, SUPABASE_SERVICE_KEY (¡secreta!, solo aquí),
//   FEED_OUT_DIR (opcional: escribe también los .xml en esa carpeta)
//   NO_UPLOAD=1  (no subir a Supabase Storage)   SHOW_URL=1 (imprime la URL secreta del feed)
//   MAX_AHEAD (episodios a mirar por delante del último visto, por defecto 5)
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

globalThis.DOMParser = new JSDOM("").window.DOMParser; // el motor necesita DOMParser
const engine = await import("../extension/engine.js");
const { currentStep } = await import("../extension/groups.js");

const BASE = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY;
if (!BASE || !KEY) { console.error("Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY"); process.exit(1); }
const OUT_DIR = process.env.FEED_OUT_DIR;
const UPLOAD = process.env.NO_UPLOAD !== "1";
const MAX_AHEAD = +(process.env.MAX_AHEAD || 5);
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
    `<guid isPermaLink="false">${esc(`${r.provider_id}-${r.slug}-e${r.episode}`)}</guid>` +
    `<pubDate>${new Date(r.found_at).toUTCString()}</pubDate><description>${esc(r.provider_id)}</description></item>`
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

const [appConfig] = await rest("app_config?select=providers&id=eq.1");
const providers = appConfig?.providers || [];
const settings = await rest("user_settings?select=user_id,feed_token");
const watch = await rest("watchlist?select=*&deleted=eq.false");
const found = await rest("episodes_found?select=*&order=found_at.desc");
const groups = await rest("groups?select=*&deleted=eq.false");

for (const st of settings) {
  try {
    const mine = watch.filter(w => w.user_id === st.user_id);
    const known = found.filter(f => f.user_id === st.user_id);
    const fresh = [];

    for (const it of mine) {
      const p = providers.find(x => x.id === it.provider_id);
      if (!p) { console.warn(`Provider desconocido: ${it.provider_id}`); continue; }
      const have = new Set(known.filter(f => f.provider_id === it.provider_id && f.slug === it.slug).map(f => f.episode));
      for (let n = it.last + 1; n <= it.last + MAX_AHEAD; n++) {
        if (have.has(n)) continue;
        let r;
        try { r = await engine.checkEpisode(p, it.slug, n); }
        catch (e) { console.warn(`Fallo en ${it.title} ep ${n}: ${e.message}`); break; }
        if (!r.exists) break;
        fresh.push({ user_id: st.user_id, provider_id: it.provider_id, slug: it.slug, episode: n,
                     title: `${it.title} — episodio ${n}`, link: r.url });
        console.log(`Nuevo: ${it.title} ep ${n}`);
      }
    }

    const mineForGroups = mine.map(w => ({ provider: w.provider_id, slug: w.slug, last: w.last, title: w.title }));
    const myGroups = groups.filter(g => g.user_id === st.user_id);
    for (const g of myGroups) {
      const cur = currentStep(g, mineForGroups);
      if (!cur?.next) continue;
      if (!cur.item) continue; // paso colgando: el ítem ya no está en la lista
      const p = providers.find(x => x.id === cur.step.provider);
      if (!p) continue;
      // Dedupe contra pasadas anteriores (`known`) y contra lo que el bucle por ítem ya ha
      // encolado en esta misma pasada (`fresh`): comparten clave primaria y guid del RSS.
      const already = known.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next)
        || fresh.some(f => f.provider_id === cur.step.provider && f.slug === cur.step.slug && f.episode === cur.next);
      if (already) continue;
      let r;
      try { r = await engine.checkEpisode(p, cur.step.slug, cur.next); }
      catch (e) { console.warn(`Fallo en grupo ${g.name}: ${e.message}`); continue; }
      if (!r.exists) continue;
      const title = cur.item?.title || cur.step.slug;
      fresh.push({ user_id: st.user_id, provider_id: cur.step.provider, slug: cur.step.slug, episode: cur.next,
                   title: `${g.name}: ${title} — episodio ${cur.next}`, link: r.url });
      console.log(`Nuevo (grupo ${g.name}): ${title} ep ${cur.next}`);
    }

    if (fresh.length) {
      await rest("episodes_found?on_conflict=user_id,provider_id,slug,episode", {
        method: "POST", prefer: "resolution=ignore-duplicates,return=minimal", body: fresh
      });
    }

    const inList = new Set(mine.map(w => `${w.provider_id}|${w.slug}`));
    const rows = [...fresh.map(f => ({ ...f, found_at: new Date().toISOString() })), ...known]
      .filter(r => inList.has(`${r.provider_id}|${r.slug}`))
      .slice(0, 100);
    await publish(st.feed_token, buildRss(`${BASE}/storage/v1/object/public/feeds/${st.feed_token}.xml`, rows));
  } catch (e) {
    console.error(`Fallo con el usuario ${String(st.user_id).slice(0, 8)}…: ${e.message}`); // uno roto no tumba al resto
    process.exitCode = 1;
  }
}
