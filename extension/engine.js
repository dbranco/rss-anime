// Motor genérico: lee un provider (JSON) y sabe buscar, listar episodios y comprobar uno.
// Necesita DOMParser, por eso se usa desde el popup y desde el documento offscreen.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fill = (p, tpl, vars = {}) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => (k === "base_url" ? p.base_url.replace(/\/+$/, "") : String(vars[k] ?? "")));
const doc = html => new DOMParser().parseFromString(html, "text/html");
const node = (el, sel) => (!sel || sel === "self" ? el : el.querySelector(sel));
const abs = (href, base) => new URL(href, base).href;
const clean = t => (t || "").replace(/\s+/g, " ").trim();

async function fetchHtml(p, url) {
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
