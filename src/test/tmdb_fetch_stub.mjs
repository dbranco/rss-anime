// Stub de fetch para TMDB: intercepta solo peticiones a api.themoviedb.org y responde con datos
// fijos por tmdb_id/temporada, dejando pasar cualquier otra petición (Supabase, sitios de
// providers, etc.) al fetch real. Necesario porque src/test/integration/sync-cron.spec.js no
// puede pegarle a la TMDB real ni levantar un tercer servidor mock (ver comentario de Task 9 en
// ese archivo): reutiliza esta misma pieza en dos sitios que NO comparten globalThis entre sí —
//   1. En el propio proceso de test, llamando a installTmdbFetchStub(shows) directamente (cubre
//      repairGroup()/tmdb.getShow disparado en proceso por subscribe()).
//   2. En el subproceso del cron (cron/generate-feed.mjs, lanzado con execFileSync): este mismo
//      archivo se pasa como `node --import` vía NODE_OPTIONS, y se autoinstala leyendo el JSON de
//      TMDB_SHIM_DATA (un subproceso nuevo no ve el globalThis.fetch que se pisó en el padre).
import fs from "node:fs";

export function installTmdbFetchStub(shows) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.startsWith("https://api.themoviedb.org/3")) return real(url, opts);
    let m = /\/(?:tv|movie)\/(\d+)\/season\/\d+/.exec(u);
    if (m) {
      const show = shows[m[1]];
      return { ok: true, json: async () => ({ episodes: (show && show.episodes) || [] }) };
    }
    m = /\/(?:tv|movie)\/(\d+)/.exec(u);
    if (m) {
      const show = shows[m[1]];
      if (!show) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ name: show.name, poster_path: show.poster_path ?? null, seasons: show.seasons || [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return () => { globalThis.fetch = real; };
}

if (process.env.TMDB_SHIM_DATA) {
  installTmdbFetchStub(JSON.parse(fs.readFileSync(process.env.TMDB_SHIM_DATA, "utf8")));
}
