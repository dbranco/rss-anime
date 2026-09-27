import { describe, it, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert/strict";

describe("tmdb", () => {
  const realFetch = globalThis.fetch;
  const data = {};

  before(async () => {
    // Mock chrome.storage.local (Node.js no tiene localStorage ni chrome.storage)
    globalThis.chrome = { storage: { local: {
      get: async k => (k in data ? { [k]: structuredClone(data[k]) } : {}),
      set: async o => { Object.assign(data, structuredClone(o)); }
    } } };
  });

  beforeEach(async () => {
    const { set } = await import("../app/store.js");
    await set("tmdb_key", "test-key");
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("search filtra personas y normaliza tv/movie", async () => {
    globalThis.fetch = async url => {
      assert.match(url, /\/search\/multi\?/);
      assert.match(url, /api_key=test-key/);
      return { ok: true, json: async () => ({ results: [
        { media_type: "tv", id: 1, name: "Re:Zero", poster_path: "/a.jpg", first_air_date: "2016-04-04" },
        { media_type: "person", id: 2, name: "Alguien" },
        { media_type: "movie", id: 3, title: "Una peli", poster_path: null, release_date: "2020-01-01" }
      ] }) };
    };
    const tmdb = await import("../app/tmdb.js?search1");
    const res = await tmdb.search("Re:Zero", "es-ES");
    assert.deepEqual(res, [
      { tmdb_id: 1, media_type: "tv", title: "Re:Zero", poster_path: "/a.jpg", year: "2016" },
      { tmdb_id: 3, media_type: "movie", title: "Una peli", poster_path: null, year: "2020" }
    ]);
  });

  it("getSeasonEpisodes devuelve número/nombre/fecha de emisión", async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ episodes: [
      { episode_number: 1, name: "Ep 1", air_date: "2016-04-04" },
      { episode_number: 2, name: "Ep 2", air_date: null }
    ] }) });
    const tmdb = await import("../app/tmdb.js?season1");
    assert.deepEqual(await tmdb.getSeasonEpisodes(1, 1, "es-ES"), [
      { number: 1, name: "Ep 1", air_date: "2016-04-04" },
      { number: 2, name: "Ep 2", air_date: null }
    ]);
  });

  it("posterUrl arma la URL, o null sin poster_path", async () => {
    const { posterUrl } = await import("../app/tmdb.js?posterurl");
    assert.equal(posterUrl("/abc.jpg", "w342"), "https://image.tmdb.org/t/p/w342/abc.jpg");
    assert.equal(posterUrl(null), null);
  });

  it("sin tmdb_key, cualquier llamada rechaza con mensaje claro", async () => {
    const { set } = await import("../app/store.js");
    await set("tmdb_key", null);
    globalThis.fetch = async () => { throw new Error("no debería llamarse"); };
    const tmdb = await import("../app/tmdb.js?nokey");
    await assert.rejects(() => tmdb.search("x", "es"), /Falta configurar la API key/);
  });
});
