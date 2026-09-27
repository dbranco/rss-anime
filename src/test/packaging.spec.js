// La extensión y la PWA importan código compartido de src/app/ con rutas relativas ("../app/...").
// Esas rutas solo resuelven si el mecanismo de carga/despliegue trata src/ (no src/extension/ ni
// src/web/ cada una por su lado) como raíz. Fix 1 movió src/extension/manifest.json a
// src/manifest.json (con sus rutas internas reescritas con el prefijo "extension/"); Fix 2 cambió
// el workflow de Pages para subir "src" en vez de "src/web". Ver
// .superpowers/sdd/2026-09-27-src-restructure-plan/final-fix-report.md para el detalle.
//
// Esta prueba NO da por buena a mano cuál es la raíz real: la DERIVA de las mismas fuentes que
// determinan la raíz real (la ubicación de manifest.json; el "path:" del step
// actions/upload-pages-artifact del workflow). Así, si alguien vuelve a estrechar cualquiera de las
// dos raíces (por ejemplo moviendo manifest.json de vuelta a src/extension/, o el workflow de vuelta
// a "path: src/web"), la raíz derivada aquí se estrecha con ella y esta prueba vuelve a fallar tal y
// como habría fallado con el bug original — en vez de solo confirmar el estado ya corregido.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", ".."); // src/test -> raíz del repo
const srcDir = path.join(repoRoot, "src");

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// Captura tanto "import ... from 'X'" (con o sin nombres/llaves entremedias) como el import de
// efecto lateral "import 'X'".
const IMPORT_RE = /import\s+(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g;

function relativeSpecifiersIn(absFile) {
  const text = readFileSync(absFile, "utf8");
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(text))) {
    if (m[1].startsWith(".")) specs.push(m[1]);
  }
  return specs;
}

// Raíz real de la extensión: la carpeta que contiene manifest.json (tal y como "Cargar
// descomprimida" la buscaría). No se asume src/: se comprueba primero el layout correcto (src/) y,
// si no está, se cae al layout anterior (src/extension/) para que la prueba señale ESA raíz — la
// que de verdad cargaría Chrome — y falle al resolver imports contra ella.
function findExtensionRoot() {
  if (existsSync(path.join(srcDir, "manifest.json"))) return srcDir;
  if (existsSync(path.join(srcDir, "extension", "manifest.json"))) return path.join(srcDir, "extension");
  throw new Error("No se encuentra manifest.json ni en src/ ni en src/extension/");
}

// Raíz real que sube a Pages: se lee del "path:" del step actions/upload-pages-artifact en el
// workflow, no se asume "src". Si el workflow vuelve a subir solo "src/web", esta función devuelve
// esa raíz más estrecha y la prueba vuelve a fallar como con el bug original.
function findPagesRoot() {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "deploy-pages.yml");
  const text = readFileSync(workflowPath, "utf8");
  const stepIdx = text.indexOf("upload-pages-artifact");
  assert.ok(stepIdx !== -1, "No se encuentra el step actions/upload-pages-artifact en " + workflowPath);
  const after = text.slice(stepIdx);
  const m = after.match(/path:\s*(\S+)/);
  assert.ok(m, "No se encuentra 'path:' tras actions/upload-pages-artifact en " + workflowPath);
  return path.resolve(repoRoot, m[1]);
}

function checkPackaging(label, filesRootDir, packagingRoot) {
  const relRoot = path.relative(repoRoot, packagingRoot) || ".";
  describe(`empaquetado: ${label} (raíz real derivada = "${relRoot}")`, () => {
    for (const absFile of walkJs(filesRootDir)) {
      const relFile = path.relative(packagingRoot, absFile);
      it(`${path.relative(repoRoot, absFile)}: sus imports relativos no escapan de la raíz cargada`, () => {
        // Si el propio archivo ya queda fuera de la raíz derivada, el mecanismo real ni siquiera lo
        // serviría/cargaría — lo señalamos explícito en vez de dejar que falle de forma confusa más
        // abajo.
        assert.ok(
          !relFile.startsWith(".."),
          `${path.relative(repoRoot, absFile)} queda fuera de la raíz derivada "${relRoot}"`
        );
        const relDir = path.dirname(relFile);
        const base = "http://pkg/" + (relDir === "." ? "" : relDir.split(path.sep).join("/") + "/");
        for (const spec of relativeSpecifiersIn(absFile)) {
          const resolvedUrl = new URL(spec, base);
          const resolvedPath = decodeURIComponent(resolvedUrl.pathname).replace(/^\/+/, "");
          assert.ok(
            !resolvedPath.startsWith("..") && !resolvedPath.split("/").includes(".."),
            `import "${spec}" en ${relFile} se sale de la raíz cargada ("${relRoot}"): resolvería a "${resolvedPath}"`
          );
          const onDisk = path.join(packagingRoot, resolvedPath);
          assert.ok(
            existsSync(onDisk),
            `import "${spec}" en ${relFile} resuelve a "${resolvedPath}" dentro de "${relRoot}", ` +
              `pero no existe ningún archivo ahí (${path.relative(repoRoot, onDisk)})`
          );
        }
      });
    }
  });
}

checkPackaging("extensión Chromium (MV3)", path.join(srcDir, "extension"), findExtensionRoot());
checkPackaging("PWA / GitHub Pages", path.join(srcDir, "web"), findPagesRoot());
