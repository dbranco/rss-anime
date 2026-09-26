// node tests/test-engine.mjs   (con tests/mock_site.py en marcha)
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
globalThis.DOMParser = new JSDOM("").window.DOMParser;
const engine = await import("../extension/engine.js");
const [p] = JSON.parse(fs.readFileSync(new URL("./mock-provider.json", import.meta.url), "utf8"));

const res = await engine.search(p, "Re:Zero");
console.log("search:", JSON.stringify(res));
console.log("episodes:", (await engine.episodes(p, res[0].slug)).map(e => e.number).join(","));
console.log("ep3:", (await engine.checkEpisode(p, "re-zero", 3)).exists);
console.log("ep4:", (await engine.checkEpisode(p, "re-zero", 4)).exists);
const epUrl = engine.episodeUrl(p, "re-zero", 3);
assert.equal(epUrl, "http://127.0.0.1:8001/blabla/re-zero/3"); // misma plantilla que checkEpisode, sin red
console.log("episodeUrl:", epUrl);
