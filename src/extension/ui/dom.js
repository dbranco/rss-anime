export const $ = s => document.querySelector(s);
export const msg = t => { $("#msg").textContent = t || ""; };
export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.flat().forEach(k => n.append(k));
  return n;
};
export const safe = u => (/^https?:/i.test(u || "") ? u : "#");
export const link = (href, text) => el("a", { href: safe(href), target: "_blank", rel: "noopener", textContent: text });
export const btn = (text, fn) => { const b = el("button", { textContent: text }); b.onclick = fn; return b; };
export const explain = e => e instanceof TypeError
  ? "No se pudo conectar. Puede que falte conceder permiso a ese dominio — vuelve a intentarlo."
  : e.message;
