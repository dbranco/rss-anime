import { search, episodes, checkEpisode } from "../app/engine.js";
import * as tmdb from "../app/tmdb.js";
const ops = { search, episodes, checkEpisode, getSeasonEpisodes: tmdb.getSeasonEpisodes };

chrome.runtime.onMessage.addListener((m, _sender, send) => {
  if (m.target !== "offscreen" || !ops[m.op]) return;
  ops[m.op](...m.args)
    .then(data => send({ ok: true, data }))
    .catch(e => send({ ok: false, error: String(e.message || e) }));
  return true; // respuesta asíncrona
});
