import { el } from "./dom.js";

// Pestañas SUB/DUB + botones de servidor; al elegir uno, embebe su iframe debajo.
// No todos los servidores que lista un provider sirven para esto — solo entran aquí los que
// engine.episodePlayers() ya filtró como embebibles (ver ese comentario en engine.js).
export function renderPlayerPicker(box, players) {
  if (!players || (!players.SUB.length && !players.DUB.length)) {
    box.textContent = "Este provider no tiene servidores para ver aquí.";
    return;
  }
  const tracks = ["SUB", "DUB"].filter(t => players[t].length);
  const trackSel = el("select", {});
  const serverSel = el("select", {});
  const frame = el("div", {});

  const loadFrame = () => {
    const s = players[trackSel.value][serverSel.selectedIndex];
    frame.replaceChildren(el("iframe", { src: s.url, className: "player-frame", allow: "autoplay; fullscreen" }));
  };
  const fillServers = () => {
    serverSel.replaceChildren(...players[trackSel.value].map(s => el("option", { value: s.server, textContent: s.server })));
    loadFrame();
  };
  trackSel.replaceChildren(...tracks.map(t => el("option", { value: t, textContent: t })));
  trackSel.onchange = fillServers;
  serverSel.onchange = loadFrame;
  fillServers(); // carga el primer servidor del primer track sin esperar un clic más

  box.replaceChildren(el("div", { className: "row" }, trackSel, serverSel), frame);
}
