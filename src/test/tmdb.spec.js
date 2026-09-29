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
        { media_type: "tv", id: 1, name: "Re:Zero", original_name: "Re:ゼロから始める異世界生活", poster_path: "/a.jpg", first_air_date: "2016-04-04" },
        { media_type: "person", id: 2, name: "Alguien" },
        { media_type: "movie", id: 3, title: "Una peli", original_title: null, poster_path: null, release_date: "2020-01-01" }
      ] }) };
    };
    const tmdb = await import("../app/tmdb.js?search1");
    const res = await tmdb.search("Re:Zero", "es-ES");
    assert.deepEqual(res, [
      { tmdb_id: 1, media_type: "tv", title: "Re:Zero", original_title: "Re:ゼロから始める異世界生活", poster_path: "/a.jpg", year: "2016" },
      { tmdb_id: 3, media_type: "movie", title: "Una peli", original_title: null, poster_path: null, year: "2020" }
    ]);
  });

  it("getShow normaliza tv/movie e incluye origin_country solo en tv", async () => {
    globalThis.fetch = async url => {
      if (/\/tv\/1\?/.test(url)) {
        return { ok: true, json: async () => ({
          name: "Re:Zero", original_name: "Re:ゼロから始める異世界生活", poster_path: "/a.jpg",
          origin_country: ["JP"], seasons: [{ season_number: 0 }, { season_number: 1 }]
        }) };
      }
      if (/\/movie\/2\?/.test(url)) {
        return { ok: true, json: async () => ({
          title: "Una peli", original_title: "Un pelicula", poster_path: null
        }) };
      }
      throw new Error("URL inesperada: " + url);
    };
    const tmdb = await import("../app/tmdb.js?getshow1");
    assert.deepEqual(await tmdb.getShow(1, "tv", "es-ES"), {
      tmdb_id: 1, media_type: "tv", title: "Re:Zero", original_title: "Re:ゼロから始める異世界生活",
      poster_path: "/a.jpg", origin_country: "JP", seasons: [1]
    });
    assert.deepEqual(await tmdb.getShow(2, "movie", "es-ES"), {
      tmdb_id: 2, media_type: "movie", title: "Una peli", original_title: "Un pelicula",
      poster_path: null, origin_country: null, seasons: null
    });
  });

  it("getAlternativeTitles normaliza results (tv) y titles (movie) al mismo shape", async () => {
    globalThis.fetch = async url => {
      if (/\/tv\/1\/alternative_titles/.test(url)) {
        return { ok: true, json: async () => ({ results: [
          { iso_3166_1: "JP", title: "ReZero kara Hajimeru Isekai Seikatsu", type: "romanization" },
          { iso_3166_1: "JP", title: "Re:Zero kara Hajimeru Isekai Seikatsu", type: "romaji" },
          { iso_3166_1: "MX", title: "Re:Zero", type: "" }
        ] }) };
      }
      if (/\/movie\/2\/alternative_titles/.test(url)) {
        return { ok: true, json: async () => ({ titles: [
          { iso_3166_1: "US", title: "A Movie", type: "" }
        ] }) };
      }
      throw new Error("URL inesperada: " + url);
    };
    const tmdb = await import("../app/tmdb.js?alttitles1");
    assert.deepEqual(await tmdb.getAlternativeTitles(1, "tv"), [
      { country: "JP", title: "ReZero kara Hajimeru Isekai Seikatsu", type: "romanization" },
      { country: "JP", title: "Re:Zero kara Hajimeru Isekai Seikatsu", type: "romaji" },
      { country: "MX", title: "Re:Zero", type: "" }
    ]);
    assert.deepEqual(await tmdb.getAlternativeTitles(2, "movie"), [
      { country: "US", title: "A Movie", type: "" }
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
