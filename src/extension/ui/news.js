import { get, set } from "../../app/store.js";
import { $, el, link, btn } from "../../app/ui/dom.js";

export async function renderNews() {
  const news = await get("news", []);
  $("#newsBox").hidden = !news.length;
  $("#news").replaceChildren(...news.map(n => el("div", { className: "news" },
    link(n.link, n.title),
    btn("✕", async () => set("news", (await get("news", [])).filter(x => x.id !== n.id))))));
}

chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.news) renderNews(); });
