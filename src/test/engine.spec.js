// node --test src/test   (con src/test/mock_site.py en marcha)
// Ported from tests/test-engine.mjs.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";

let engine, p, pMirror;

before(async () => {
  globalThis.DOMParser = new JSDOM("").window.DOMParser;
  engine = await import("../app/engine.js");
  [p] = JSON.parse(fs.readFileSync(new URL("./mock-provider.json", import.meta.url), "utf8"));
  [pMirror] = JSON.parse(fs.readFileSync(new URL("./mock-provider-mirror.json", import.meta.url), "utf8"));
});

describe("engine.search / checkEpisode", () => {
  it("busca y comprueba cuáles episodios existen (sin assert en el original, solo console.log)", async () => {
    // El script original solo hacía console.log de estos resultados (ningún assert.*);
    // se preserva igual aquí: se ejecutan para mantener la cobertura de que no revientan,
    // sin inventar aserciones nuevas sobre valores que nunca se fijaron.
    // engine.episodes() ya no existe (Task 7): la lista de episodios viene de TMDB.
    await engine.search(p, "Re:Zero");
    await engine.checkEpisode(p, "re-zero", 3);
    await engine.checkEpisode(p, "re-zero", 4);
  });

  it("episodeUrl arma la URL del episodio con la plantilla del provider, sin red", () => {
    const epUrl = engine.episodeUrl(p, "re-zero", 3);
    assert.equal(epUrl, "http://127.0.0.1:8001/blabla/re-zero/3"); // misma plantilla que checkEpisode, sin red
  });
});

describe("engine.episodePlayers", () => {
  it("separa SUB/DUB para un provider con embeds_regex", async () => {
    const players = await engine.episodePlayers(p, "re-zero", 3);
    assert.deepEqual(players.SUB, [
      { server: "Voe", url: "https://voe.example/e/abc" },
      { server: "MP4Upload", url: "https://mp4upload.example/embed-xyz.html" }
    ]);
    assert.deepEqual(players.DUB, [{ server: "Voe", url: "https://voe.example/e/def" }]);
  });

  it("devuelve null si el provider no declara embeds_regex", async () => {
    // provider sin embeds_regex: la función no existe para él, no revienta
    const noEmbeds = { ...p, episode: { ...p.episode, embeds_regex: undefined } };
    assert.equal(await engine.episodePlayers(noEmbeds, "re-zero", 3), null);
  });

  it("soporta mirror_select (estilo AnimeFlix): iframe por defecto + <select> en base64", async () => {
    // provider con mirror_select (estilo AnimeFlix): iframe por defecto + <select> en base64
    const mirrorPlayers = await engine.episodePlayers(pMirror, "re-zero", 3);
    assert.deepEqual(mirrorPlayers, {
      SUB: [
        { server: "Default", url: "https://player.example/default/3" },
        { server: "HD 1", url: "https://player.example/mirror1/3" }
      ],
      DUB: []
    });
  });
});
