// Motor genérico: lee un provider (JSON) y sabe buscar, listar episodios y comprobar uno.
// Necesita DOMParser, por eso se usa desde el popup y desde el documento offscreen.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fill = (p, tpl, vars = {}) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => (k === "base_url" ? p.base_url.replace(/\/+$/, "") : String(vars[k] ?? "")));
const doc = html => new DOMParser().parseFromString(html, "text/html");
const node = (el, sel) => (!sel || sel === "self" ? el : el.querySelector(sel));
const abs = (href, base) => new URL(href, base).href;
const clean = t => (t || "").replace(/\s+/g, " ").trim();

// Gancho opcional: la PWA lo define (proxy vía Edge Function) porque, a diferencia de la extensión
// (host_permissions exime de CORS) o el cron (fetch servidor-a-servidor), un fetch() de un sitio web
// normal a un provider de terceros sin cabeceras CORS se bloquea en el navegador. Extensión y cron
// nunca lo definen, así que su comportamiento no cambia.
async function fetchHtml(p, url) {
  if (typeof globalThis.__seriesTrackerFetch === "function") {
    const r = await globalThis.__seriesTrackerFetch(url);
    if (p.delay) await sleep(p.delay * 1000);
    return r;
  }
  const r = await fetch(url, { credentials: "include" });
  const html = await r.text();
  if (p.delay) await sleep(p.delay * 1000); // cortesía con el servidor
  return { status: r.status, html, finalUrl: r.url || url };
}

export async function search(p, query) {
  const s = p.search;
  const { status, html, finalUrl } = await fetchHtml(p, fill(p, s.url, { query: encodeURIComponent(query) }));
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const rx = new RegExp(s.slug_regex);
  const out = [], seen = new Set();
  for (const it of doc(html).querySelectorAll(s.item)) {
    const a = node(it, s.link || "a");
    const href = a && a.getAttribute("href");
    if (!href) continue;
    const link = abs(href, finalUrl);
    const m = rx.exec(link);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const t = node(it, s.title);
    const title = clean(t && s.title_attr ? t.getAttribute(s.title_attr) : (t || a).textContent);
    const img = s.image ? node(it, s.image) : null;
    const src = img && (img.getAttribute("src") || img.getAttribute("data-src"));
    out.push({ provider: p.id, slug: m[1], title, link, image: src ? abs(src, finalUrl) : null });
  }
  return out;
}

export async function episodes(p, slug) {
  const s = p.series;
  if (!s) throw new Error("Este provider no define 'series'");
  const { status, html, finalUrl } = await fetchHtml(p, fill(p, s.url, { slug }));
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const rx = new RegExp(s.number_regex || "(\\d+)/?$");
  const out = [], seen = new Set();
  for (const it of doc(html).querySelectorAll(s.item)) {
    const a = node(it, s.link || "self");
    const href = a && a.getAttribute("href");
    if (!href) continue;
    const link = abs(href, finalUrl);
    const text = clean(it.textContent);
    const m = rx.exec(s.number_from === "text" ? text : link);
    if (!m || seen.has(+m[1])) continue;
    seen.add(+m[1]);
    out.push({ number: +m[1], title: text, link });
  }
  return out.sort((a, b) => a.number - b.number);
}

// URL de un episodio sin comprobar si existe (para "abrir" sin gastar una petición de red).
export const episodeUrl = (p, slug, episode) => fill(p, p.episode.url, { slug, episode });

export async function checkEpisode(p, slug, episode) {
  const e = p.episode;
  const url = fill(p, e.url, { slug, episode });
  const { status, html } = await fetchHtml(p, url);
  let exists = status < 400;
  if (exists && e.not_found_text?.length) {
    const low = html.toLowerCase();
    exists = !e.not_found_text.some(t => low.includes(t.toLowerCase()));
  }
  if (exists && e.exists_selector) exists = !!doc(html).querySelector(e.exists_selector);
  return { exists, status, url };
}

// Servidores de streaming embebibles del episodio (SUB/DUB), si el provider los expone.
// No todos los servidores que lista un sitio sirven para esto: muchos (ej. Mega) son solo de
// descarga y bloquean que su página se cargue en un iframe de otro sitio. El provider declara
// `episode.embeds_regex` para capturar el bloque JS con los que SÍ son embebibles; sin ese
// campo, la función devuelve null (el provider simplemente no soporta esto).
// El bloque capturado no es JSON válido (claves sin comillas: embeds:{SUB:[{server:"..."}]}),
// así que en vez de intentar convertirlo a JSON se extrae cada par server/url con su propio
// regex, más simple y robusto que un parser de objetos JS.
export async function episodePlayers(p, slug, episode) {
  const e = p.episode;
  if (!e.embeds_regex) return null;
  const url = fill(p, e.url, { slug, episode });
  const { html } = await fetchHtml(p, url);
  const m = new RegExp(e.embeds_regex).exec(html);
  if (!m) return null;
  const blob = m[1];
  const track = t => {
    const tm = new RegExp(`${t}:\\[(.*?)\\]`).exec(blob);
    if (!tm) return [];
    return [...tm[1].matchAll(/\{server:"([^"]+)",url:"([^"]+)"\}/g)].map(x => ({ server: x[1], url: x[2] }));
  };
  const SUB = track("SUB"), DUB = track("DUB");
  return (SUB.length || DUB.length) ? { SUB, DUB } : null;
}
