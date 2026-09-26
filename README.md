# Series Tracker

Tres piezas que comparten el mismo motor de scraping (`extension/engine.js`):

| Pieza | Para qué |
|---|---|
| `extension/` | Extensión Chromium (MV3): buscas, guardas series, ves episodios y recibes notificaciones |
| `supabase/schema.sql` | Tablas + RLS: lista y grupos por usuario, providers compartidos por toda la app |
| `cron/generate-feed.mjs` | Revisa la lista de cada usuario en Supabase y publica su feed RSS |

RSS = canal de avisos (funciona con el PC apagado, se lee desde cualquier lector). Extensión = interfaz
y motor en tu navegador (busca, guarda, navega). Se complementan.

## 1. Supabase
1. Crea un proyecto (plan gratuito; los proyectos inactivos se pausan, compruébalo en su web).
2. SQL Editor → pega y ejecuta `supabase/schema.sql`. Alternativa con la CLI de Supabase: las mismas
   tablas están en `supabase/migrations/`, así que `supabase db push` las aplica (y aplica también las
   nuevas al actualizar, sin volver a pegar SQL a mano).
3. Authentication → Providers → Email activo. Si "Confirm email" está activado, tendrás que confirmar el
   correo tras crear la cuenta; para uso personal puedes desactivarlo.
4. Settings → API: copia la URL, la clave `anon` (va en la extensión) y la `service_role` (SOLO para el cron).

## 2. Extensión
1. `chrome://extensions` → modo de desarrollador → "Cargar descomprimida" → carpeta `extension/`.
2. Solo la cuenta admin edita providers (⚙ Opciones en la extensión, o Config en la PWA): pega
   el JSON y guarda (acepta el permiso del dominio). El resto de cuentas los reciben ya listos
   al sincronizar — ver "Providers como config de la app" más abajo.
3. En "Sincronización": URL + anon key de Supabase, email y contraseña → Crear cuenta / Iniciar sesión.
   En cada máquina nueva: instala la extensión y solo inicia sesión; providers y lista llegan solos.
4. Opciones muestra la URL de tu feed RSS cuando el cron ya lo ha generado.

Conflictos: gana el cambio más reciente (`updated_at`). Los borrados se propagan (`deleted`).

### Providers como config de la app

`providers` (qué sitios sabe scrapear la app) no es por usuario: es una configuración
compartida que mantiene una cuenta admin. El resto de cuentas la reciben en solo lectura al
sincronizar — ni siquiera ven la sección en Opciones/Config.

Para marcarte admin (una vez, por SQL Editor, después de ejecutar `supabase/schema.sql`):

```sql
insert into admins (user_id) select id from auth.users where email = 'tu@email.com';
```

Luego, en Opciones (extensión) o Config (PWA), pega el JSON de tus providers y Guardar. Ver
`docs/superpowers/specs/2026-09-26-app-wide-providers-design.md` para el detalle completo.

Nota: sin Supabase configurado (o antes de que el admin guarde algo), la app no tiene
ningún provider disponible — ya no hay edición local de respaldo. Al abrir la extensión por
primera vez, si aparece un aviso de "Conceder permisos", haz clic para que las comprobaciones
en segundo plano funcionen con los providers del admin.

### Grupos
La pestaña "Grupos" (popup y PWA) son playlists de orden de visionado: reordenan y filtran ítems que ya
tienes en tu lista, cada paso con su rango `desde`/`hasta` y episodios a excluir (fillers). El progreso
sale del mismo "visto hasta" de cada ítem, no hay contador aparte. Se sincronizan igual que la lista, y
tanto las notificaciones como el feed RSS avisan del episodio que el grupo necesita a continuación. En
esta versión los grupos se crean y se borran; para cambiar uno, bórralo y créalo de nuevo.

## 3. Cron / RSS
Necesita Node 20+ (`npm install`).
- **Local (recomendado si la web bloquea IPs de datacenter):** copia `.env.example` a `.env`, rellénalo y
  añade a crontab: `0 * * * * /ruta/cron/run-local.sh >> /tmp/series-feed.log 2>&1`
- **GitHub Actions:** sube el repo, añade los secrets `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`; el workflow
  `.github/workflows/feed.yml` corre cada 2 h. No imprime la URL del feed (los logs de repos públicos son públicos).
- Para ver tu URL al probar en local: `SHOW_URL=1 node cron/generate-feed.mjs`.
- `FEED_OUT_DIR=./feeds` escribe además los .xml en disco (por si prefieres servirlos tú, p. ej. GitHub Pages).

## Seguridad
- La `anon key` puede ir en la extensión: RLS limita cada usuario a sus filas.
- La `service_role` salta RLS: nunca en la extensión ni en un repo.
- El feed es una URL "no listada" con token de 32 caracteres, no autenticada: quien tenga la URL lo lee.
- Comprueba que tu lector RSS acepta el feed servido por Supabase Storage. Si no lo hace, usa `FEED_OUT_DIR`
  y publícalo en otro hosting.

## Pruebas
`npm install && bash tests/run.sh` levanta una web falsa y un Supabase falso y prueba: motor, sincronización
entre dos "máquinas" (subida, bajada, progreso, borrado y restauración), grupos (`tests/test-groups.mjs`:
paso actual, exclusiones, CRUD) y cron (feed sin duplicados).
No cubre el popup ni las notificaciones en un Chromium real.

## Límites
- Sin `render: js` (webs que cargan con JavaScript).
- `fetch` no puede fijar Referer ni User-Agent.
- El uso de cada web debe respetar sus términos y robots.txt; deja `delay` >= 1 en los providers.
