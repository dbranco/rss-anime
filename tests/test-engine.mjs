// node tests/test-engine.mjs   (con tests/mock_site.py en marcha)
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const engine = await import("../extension/engine.js");
const [p] = JSON.parse(fs.readFileSync(new URL("./mock-provider.json", import.meta.url), "utf8"));
const [pMirror] = JSON.parse(fs.readFileSync(new URL("./mock-provider-mirror.json", import.meta.url), "utf8"));

const res = await engine.search(p, "Re:Zero");
console.log("search:", JSON.stringify(res));
console.log("episodes:", (await engine.episodes(p, res[0].slug)).map(e => e.number).join(","));
console.log("ep3:", (await engine.checkEpisode(p, "re-zero", 3)).exists);
console.log("ep4:", (await engine.checkEpisode(p, "re-zero", 4)).exists);
const epUrl = engine.episodeUrl(p, "re-zero", 3);
assert.equal(epUrl, "http://127.0.0.1:8001/blabla/re-zero/3"); // misma plantilla que checkEpisode, sin red
console.log("episodeUrl:", epUrl);

const players = await engine.episodePlayers(p, "re-zero", 3);
assert.deepEqual(players.SUB, [
  { server: "Voe", url: "https://voe.example/e/abc" },
  { server: "MP4Upload", url: "https://mp4upload.example/embed-xyz.html" }
]);
assert.deepEqual(players.DUB, [{ server: "Voe", url: "https://voe.example/e/def" }]);
console.log("episodePlayers:", JSON.stringify(players));

// provider sin embeds_regex: la función no existe para él, no revienta
const noEmbeds = { ...p, episode: { ...p.episode, embeds_regex: undefined } };
assert.equal(await engine.episodePlayers(noEmbeds, "re-zero", 3), null);
console.log("episodePlayers sin soporte: null");

// provider con mirror_select (estilo AnimeFlix): iframe por defecto + <select> en base64
const mirrorPlayers = await engine.episodePlayers(pMirror, "re-zero", 3);
assert.deepEqual(mirrorPlayers, {
  SUB: [
    { server: "Default", url: "https://player.example/default/3" },
    { server: "HD 1", url: "https://player.example/mirror1/3" }
  ],
  DUB: []
});
console.log("episodePlayers mirror_select:", JSON.stringify(mirrorPlayers));
