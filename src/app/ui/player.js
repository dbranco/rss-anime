import { el, link } from "./dom.js";
import { holdWakeLockWhileConnected, requestWakeLock, releaseWakeLock } from "./wake-lock.js";

// Botones de servidor; al elegir uno, embebe su iframe debajo (o, si el provider declara
// embed_blocked, muestra un enlace a la página del episodio en el sitio original en vez de al
// servidor embebible directo — algunos sitios (ej. meusanimes.blog) bloquean el embed con CSP
// frame-ancestors, y el propio reproductor rechaza incluso el acceso directo a su URL si no
// detecta que viene de una página del dominio permitido; enlazar a la página del episodio, no
// al servidor scrapeado, es lo único que carga sin dar 403).
// No todos los servidores que lista un provider sirven para esto — solo entran aquí los que
// engine.episodePlayers() ya filtró como embebibles (ver ese comentario en engine.js).
//
// `track` (SUB/DUB) ya se eligió arriba en los selectores de player-pref.js — no se vuelve a
// preguntar aquí. Si el provider no tiene servidores para esa pista pero sí para la otra
// (ej. un mirror_select que solo llena SUB), cae a la que tenga contenido en vez de mostrar
// "sin servidores" con la otra pista disponible.
export function renderPlayerPicker(box, players, { track = "SUB", embedBlocked = false, episodeUrl = null } = {}) {
  if (!players || (!players.SUB.length && !players.DUB.length)) {
    box.textContent = "Este provider no tiene servidores para ver aquí.";
    return;
  }
  const chosenTrack = players[track]?.length ? track : (players.SUB.length ? "SUB" : "DUB");
  const serverSel = el("select", {});
  const frame = el("div", {});

  const loadFrame = () => {
    const s = players[chosenTrack][serverSel.selectedIndex];
    if (embedBlocked) { frame.replaceChildren(link(episodeUrl || s.url, "▶ Abrir en pestaña nueva")); return; }
    const iframe = el("iframe", { src: s.url, className: "player-frame", allow: "autoplay; fullscreen" });

    // El wake lock se pide a ciegas (ver comentario de wake-lock.js: no hay forma de leer el
    // play/pause real del iframe cross-origin), así que este botón superpuesto deja al usuario
    // corregirlo a mano — ej. soltarlo si pausa el video adentro, para que la pantalla sí pueda
    // bloquearse mientras no está mirando.
    let awake = true;
    const wakeBtn = el("button", { className: "wake-toggle", type: "button" });
    const syncWakeBtn = () => {
      wakeBtn.textContent = awake ? "🔒" : "🔓";
      wakeBtn.title = awake
        ? "Pantalla fija mientras ves esto — toca para dejar que se bloquee"
        : "Pantalla puede bloquearse — toca para mantenerla encendida";
    };
    wakeBtn.onclick = () => { awake = !awake; (awake ? requestWakeLock : releaseWakeLock)(); syncWakeBtn(); };
    syncWakeBtn();

    frame.replaceChildren(el("div", { className: "player-wrap" }, iframe, wakeBtn));
    // Sin esto, el móvil bloquea la pantalla a los pocos segundos como si no hubiera nada
    // reproduciéndose, y hay que ir tocando la pantalla a mano para que no se apague.
    holdWakeLockWhileConnected(iframe);
  };
  serverSel.replaceChildren(...players[chosenTrack].map(s => el("option", { value: s.server, textContent: s.server })));
  serverSel.onchange = loadFrame;
  loadFrame(); // carga el primer servidor de la pista elegida sin esperar un clic más

  box.replaceChildren(serverSel, frame);
}
