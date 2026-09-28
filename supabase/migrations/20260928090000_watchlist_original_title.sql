-- Guarda el original_title de TMDB junto al título traducido — segundo intento de búsqueda en
-- un sitio de reproducción cuando el título traducido no da resultados (ver src/app/ui/resolve.js).
alter table public.watchlist add column if not exists original_title text;

notify pgrst, 'reload schema';
