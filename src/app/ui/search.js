import * as tmdb from "../tmdb.js";
import { add } from "../list.js";
import { $, el, btn, safe, explain } from "./dom.js";
import { get } from "../store.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  $("#searchMsg").textContent = "";
  if (!q) { $("#searchMsg").textContent = "Escribe algo para buscar."; return; }
  $("#searchMsg").textContent = "Buscando…";
  await ensurePermissions(); // incluye api.themoviedb.org — ver permissions.js (Task 5)
  const lang = await get("lang_pref", "es-ES");
  let results;
  try { results = await tmdb.search(q, lang); }
  catch (e) { $("#searchMsg").textContent = "Error: " + explain(e); return; }
  $("#searchMsg").textContent = results.length ? "" : "Sin resultados";
  $("#results").replaceChildren(...results.map(r => el("div", { className: "card" },
    r.poster_path ? el("img", { src: safe(tmdb.posterUrl(r.poster_path)) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: r.title + (r.year ? ` (${r.year})` : "") }),
      el("div", { className: "st", textContent: r.media_type === "movie" ? "Película" : "Serie" }),
      el("div", { className: "actions" },
        btn("＋ Guardar", async () => {
          await add(r);
          await renderMain();
          requestSync();
          $("#searchMsg").textContent = "Guardada";
        }))))));
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });
