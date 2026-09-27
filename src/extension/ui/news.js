import { get, set } from "../../app/store.js";
import { $, el, link, btn } from "../../app/ui/dom.js";

export async function renderNews() {
  const news = await get("news", []);
  $("#newsBox").hidden = !news.length;
  // Ya no siempre hay una URL directa al episodio (TMDB solo confirma que "ya emitió"): sin
  // link, el título se muestra sin convertirlo en enlace (Plan A).
  $("#news").replaceChildren(...news.map(n => el("div", { className: "news" },
    n.link ? link(n.link, n.title) : el("span", { textContent: n.title }),
    btn("✕", async () => set("news", (await get("news", [])).filter(x => x.id !== n.id))))));
}

chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.news) renderNews(); });
