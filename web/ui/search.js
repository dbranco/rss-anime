import * as engine from "../../extension/engine.js";
import { add } from "../../extension/list.js";
import { $, el, link, btn, safe, explain } from "./dom.js";
import { providers, selectedLangs } from "./state.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  const langs = new Set(selectedLangs());
  const targets = providers.filter(p => langs.has(p.language || "?"));
  $("#searchMsg").textContent = "";
  if (!q) { $("#searchMsg").textContent = "Escribe algo para buscar."; return; }
  if (!targets.length) { $("#searchMsg").textContent = "Selecciona al menos un idioma."; return; }
  $("#searchMsg").textContent = "Buscando…";
  const settled = await Promise.allSettled(targets.map(p =>
    engine.search(p, q).then(res => res.map(r => ({ ...r, _providerName: p.name || p.id })))));
  const merged = settled.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  const rejected = settled.filter(r => r.status === "rejected");
  // Si TODOS los providers fallaron, "Sin resultados" mentiría (parece "no hay nada" cuando en
  // realidad la búsqueda ni se pudo hacer) — se muestra el error real del primero.
  $("#searchMsg").textContent = merged.length
    ? (rejected.length ? `${rejected.length} provider(s) fallaron al buscar` : "")
    : (rejected.length ? "Error: " + explain(rejected[0].reason) : "Sin resultados");
  $("#results").replaceChildren(...merged.map(r => el("div", { className: "card" },
    r.image ? el("img", { src: safe(r.image) }) : "",
    el("div", { className: "body" }, el("b", { textContent: r.title }),
      el("div", { className: "hint", textContent: r._providerName }),
      el("div", { className: "actions" },
        btn("＋ Guardar", async () => { await add(r); await renderMain(); requestSync(); $("#searchMsg").textContent = "Guardada"; }),
        link(r.link, "Abrir"))))));
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });
