En este directorio hay un proyecto "Series Tracker" ya escrito. Lee README.md primero.

Resumen: extensión Chromium MV3 (extension/) con providers en JSON y un motor genérico (engine.js) que
busca series, lista episodios y comprueba si existe el siguiente; la lista y los providers se sincronizan
con Supabase (supabase/schema.sql, login email+contraseña, gana el updated_at más reciente, borrado lógico);
y un cron (cron/generate-feed.mjs) que reutiliza el mismo engine.js con jsdom, guarda los episodios nuevos
en episodes_found y publica un feed RSS por usuario en Supabase Storage.

Tareas:
1. Ejecuta `npm install && bash tests/run.sh`. Deben pasar motor, sync entre dos máquinas y cron.
   Si algo falla, corrígelo y dime qué cambiaste.
2. Revisa extension/ (background.js, popup.js, options.js, sync.js, manifest.json) buscando errores típicos
   de MV3 (service worker, offscreen document, permisos opcionales, mensajería, sync con condiciones de carrera).
   Corrige lo que encuentres y explícamelo.
3. Guíame para poner Supabase en marcha: dime qué ejecutar en el SQL Editor y qué claves copiar. Nunca
   escribas la service_role en un archivo versionado ni en el historial de git; usa .env (ya está en .gitignore).
4. Ayúdame a crear mi primer provider real. Te daré la URL base y ejemplos de URL de búsqueda, de ficha de
   serie y de episodio. Inspecciona el HTML (curl o Playwright), escribe el JSON del provider y pruébalo con
   engine.js + jsdom hasta que search, episodes y checkEpisode funcionen (regex en JSON: barras dobles).
5. Si la web carga el contenido con JavaScript, propón cómo leerla (pestaña en segundo plano con
   chrome.scripting en la extensión; Playwright en el cron) y confírmalo conmigo antes de implementarlo.
6. Configura el cron en esta máquina (cron/run-local.sh + crontab) y verifica con SHOW_URL=1 que el feed se
   publica en Supabase Storage y que un lector RSS lo acepta. Si Storage sirve mal el content-type,
   propón la alternativa con FEED_OUT_DIR.
7. Al final, dame los pasos para cargar la extensión en Chromium, iniciar sesión y suscribirme al feed.
8. Antes de instalar paquetes globales, tocar el crontab o el sistema, confirma conmigo.
