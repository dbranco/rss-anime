# Reestructuración a src/ con UI compartida — Plan de implementación

> **Para agentes:** REQUIRED SUB-SKILL: usa superpowers:subagent-driven-development
> (recomendado) o superpowers:executing-plans para implementar este plan
> tarea por tarea. Los pasos usan sintaxis de checkbox (`- [ ]`) para seguimiento.

**Goal:** Fusionar `extension/ui/` y `web/ui/` en un único árbol
`src/app/ui/` compartido, reorganizar todo el repo bajo `src/{app,web,extension}`,
migrar los tests a `src/test/` con `node:test`, y añadir deploy automático
a GitHub Pages.

**Architecture:** `src/app/` concentra lógica de negocio (`engine.js`,
`store.js`, `list.js`, `groups.js`, `sync.js`) y UI compartida (`ui/`),
agnóstica de plataforma vía detección de entorno en runtime (mismo idioma
que ya usa `store.js`: `typeof chrome !== "undefined" && chrome.X`).
`src/web/` y `src/extension/` contienen solo el glue específico de cada
plataforma (entry point, HTML, manifest, páginas exclusivas).

**Tech Stack:** ES modules nativos, cero build step, cero dependencias
nuevas (`node:test` viene incluido en Node ≥18).

**Spec:** `docs/superpowers/specs/2026-09-27-src-restructure-design.md`

## Global Constraints

- Cero build step: solo `import`/`export` nativos, ningún bundler/transpiler.
- Cero dependencias npm nuevas (el test runner es `node:test`, incluido en Node).
- Detección de entorno para código compartido: `typeof chrome === "undefined" || !chrome.X`
  — el mismo idioma que ya usa `store.js` (`hasChromeStorage()`), no un
  mecanismo de inyección/configuración distinto.
- Convención de clase CSS unificada: `.st` / `.itin` (no `.hint`/`.msg` de tarjeta).
- Todo `git mv` (nunca borrar+recrear) para preservar historial.
- Trabajo directo en `master`, sin worktree (preferencia explícita de toda la sesión).
- Cada tarea debe dejar `bash tests/run.sh` (Tareas 1-4) o `npm test` (Tarea 5+) en verde.

---

### Task 1: Establecer el layout src/app + src/web + src/extension

**Files:**
- Move: `extension/*` → `src/extension/*`, luego `src/extension/{engine,store,list,groups,sync}.js` → `src/app/`
- Move: `web/*` → `src/web/*`
- Modify: `src/extension/background.js`, `src/extension/options.js`, `src/extension/popup.js`, `src/extension/offscreen.js`
- Modify: `src/web/app.js`, `src/web/proxy.js`, `src/web/sw.js`
- Modify: `cron/generate-feed.mjs`, `tests/test-engine.mjs`, `tests/test-groups.mjs`, `tests/test-sync-cron.mjs`
- Modify: `README.md`

**Interfaces:**
- Produces: `src/app/{engine,store,list,groups,sync}.js` en su ubicación final — todas las tareas siguientes importan desde aquí.
- Produces: `src/extension/` y `src/web/` en su ubicación final (el contenido de `ui/` en ambos sigue siendo el duplicado viejo hasta la Tarea 4 — no lo toques aquí).

- [ ] **Step 1: Mover extension/ y web/ a src/**

```bash
mkdir -p src
git mv extension src/extension
git mv web src/web
mkdir -p src/app
git mv src/extension/engine.js src/app/engine.js
git mv src/extension/store.js src/app/store.js
git mv src/extension/list.js src/app/list.js
git mv src/extension/groups.js src/app/groups.js
git mv src/extension/sync.js src/app/sync.js
```

- [ ] **Step 2: Actualizar imports en src/extension/**

En `src/extension/background.js`, cambiar las 4 líneas de import de
`./store.js`/`./list.js`/`./groups.js`/`./sync.js` a
`../app/store.js`/`../app/list.js`/`../app/groups.js`/`../app/sync.js`.

En `src/extension/options.js`, cambiar `./store.js`→`../app/store.js` y
`./sync.js`→`../app/sync.js` (su import de `./syncClient.js` no cambia,
`syncClient.js` se queda en `src/extension/`).

En `src/extension/offscreen.js`, cambiar `./engine.js`→`../app/engine.js`.

En `src/extension/popup.js`, cambiar únicamente la línea
`import { getSession } from "./sync.js";` a
`import { getSession } from "../app/sync.js";` (sus imports de `./ui/*.js`
no se tocan todavía — eso es la Tarea 4).

- [ ] **Step 3: Actualizar imports en src/web/**

En `src/web/app.js`, cambiar:
```js
import { get, set } from "../extension/store.js";
import { signIn, signUp, signOut, getSession } from "../extension/sync.js";
```
a:
```js
import { get, set } from "../app/store.js";
import { signIn, signUp, signOut, getSession } from "../app/sync.js";
```
(sus imports de `./ui/*.js` no se tocan todavía — Tarea 4.)

En `src/web/proxy.js`, cambiar `import { get } from "../extension/store.js";`
a `import { get } from "../app/store.js";`.

En `src/web/sw.js`, cambiar la lista de rutas cacheadas de
`"../extension/engine.js", "../extension/list.js", "../extension/sync.js", "../extension/store.js"`
a `"../app/engine.js", "../app/list.js", "../app/sync.js", "../app/store.js"`.

- [ ] **Step 4: Actualizar cron/ y tests/**

En `cron/generate-feed.mjs`, cambiar las 2 líneas de `await import("../extension/engine.js")`
y `await import("../extension/groups.js")` a `await import("../src/app/engine.js")`
y `await import("../src/app/groups.js")`.

En `tests/test-engine.mjs`, `tests/test-groups.mjs`, `tests/test-sync-cron.mjs`,
cambiar cada `await import("../extension/X.js")` a `await import("../src/app/X.js")`
(estos 3 archivos se retiran en la Tarea 5 al migrar a `src/test/` — este
cambio es solo para mantener `bash tests/run.sh` verde hasta entonces).

- [ ] **Step 5: Actualizar README.md**

Buscar y reemplazar referencias a `extension/` (carga como extensión sin
empaquetar) y `web/` (servir con GitHub Pages) por `src/extension/` y
`src/web/` respectivamente.

- [ ] **Step 6: Verificar**

```bash
bash tests/run.sh
```
Debe terminar en verde, igual que antes de mover nada.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: mover extension/ y web/ bajo src/, extraer lógica compartida a src/app/"
```

---

### Task 2: Fusionar los módulos de UI sin diferencias de comportamiento

**Files:**
- Create: `src/app/ui/state.js`, `src/app/ui/player.js`, `src/app/ui/episode-panel.js`, `src/app/ui/list-item.js`, `src/app/ui/group-card.js`, `src/app/ui/main-list.js`, `src/app/ui/explore.js`, `src/app/ui/group-builder.js`, `src/app/ui/search.js`

**Interfaces:**
- Consumes: `src/app/{engine,store,list,groups}.js` (Task 1). `ensurePermissions`, `requestSync`, `$`/`el`/`link`/`btn`/`explain` de `src/app/ui/{permissions,sync,dom}.js` (creados en Task 3 — estos imports quedarán apuntando a archivos que aún no existen hasta que termine Task 3; eso es correcto, ninguna de estas dos tareas se ejecuta sola en producción, la Tarea 4 es la que conecta todo).
- Produces: `itemCard`, `groupCard`, `renderMain`/`setListFilter`, `renderExplore`, `renderPlayerPicker`, `renderItemEpisodePanel`/`renderEpisodePanel`, `providers`/`prov`/`fillProviders`/`selectedLangs` — usados por Task 4 al conectar los entry points.

No es una copia 100% mecánica: 3 de estos 9 archivos tienen una decisión de
fusión real (documentada abajo), porque el `dom.js` compartido (Task 3) deja
de exportar un helper `msg()` global — la PWA no tiene ningún elemento
`#msg` en su HTML, así que cualquier módulo compartido que asuma que existe
rompe con un `TypeError` en la PWA. `state.js` y `list-item.js` usaban ese
`msg()` en la versión de la extensión; `search.js` y `group-builder.js` ya
usaban en la PWA IDs de mensaje por vista (`#searchMsg`, `#groupMsg`), así
que para esos dos la base es la versión de la PWA, con las llamadas a
`ensurePermissions()` de la extensión añadidas de vuelta.

- [ ] **Step 1: src/app/ui/state.js**

Copia de `src/extension/ui/state.js`, quitando la línea
`if (!providers.length) msg("El admin de la app aún no ha configurado ningún provider.");`
de dentro de `fillProviders()` (era el único uso de `msg()` en este archivo;
la PWA nunca tuvo este aviso y no hay dónde mostrarlo de forma compartida —
se deja caer como simplificación menor, sin impacto funcional).

```js
import { get, set } from "../store.js";
import { $, el } from "./dom.js";

// Vinculación viva de ES modules: quien importe `providers` ve el valor actual sin
// necesidad de una función getter — reasignarlo aquí se refleja en todos los importadores.
export let providers = [];
export const prov = id => providers.find(p => p.id === id);

export async function fillProviders() {
  providers = await get("providers", []);
  await renderLangFilter();
}

// Un checkbox por cada idioma distinto que declaren los providers (providers sin "language"
// caen en "?"). La selección se recuerda localmente; sin preferencia guardada, todo marcado.
export async function renderLangFilter() {
  const langs = [...new Set(providers.map(p => p.language || "?"))].sort();
  const saved = await get("search_languages", null);
  $("#langFilter").replaceChildren(...langs.map(l => {
    const cb = el("input", { type: "checkbox", checked: saved ? saved.includes(l) : true });
    cb.dataset.lang = l;
    cb.onchange = () => set("search_languages", selectedLangs());
    return el("label", {}, cb, l.toUpperCase());
  }));
}

export const selectedLangs = () => [...$("#langFilter").querySelectorAll("input:checked")].map(c => c.dataset.lang);
```

- [ ] **Step 2: src/app/ui/player.js**

Copia exacta de `src/extension/ui/player.js`, sin cambios de contenido
(las dos versiones ya eran idénticas).

- [ ] **Step 3: src/app/ui/episode-panel.js**

Copia exacta de `src/extension/ui/episode-panel.js`, sin cambios de
contenido (ya incluye las llamadas a `ensurePermissions` antes de "▶ Ver
aquí", que son seguras como no-op en la PWA una vez fusionado `permissions.js`
en la Tarea 3).

- [ ] **Step 4: src/app/ui/list-item.js**

Base: `src/extension/ui/list-item.js`, con un cambio — el mensaje de
"Quitar bloqueado" pasa de escribir al `msg()` global a escribir al
elemento `st` local de la propia tarjeta (como ya hacía la versión de la
PWA):

```js
import * as engine from "../engine.js";
import { get, set } from "../store.js";
import { mutate } from "../list.js";
import { el, link, btn, safe, explain } from "./dom.js";
import { prov } from "./state.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderItemEpisodePanel } from "./episode-panel.js";

const epsSel = new Map(); // "provider|slug" -> episodio seleccionado, o null

// Nombres de los grupos (propios o suscritos) cuyo itinerario todavía usa este título.
// Quitarlo de la lista rompería su seguimiento ahí (el paso deja de encontrar el ítem:
// pierde avatar real y el botón "Visto" desaparece), así que "Quitar" lo bloquea si hay alguno.
function groupsReferencing(item, myGroups, subGroups) {
  return [...myGroups, ...subGroups]
    .filter(g => (g.steps || []).some(s => s.provider === item.provider && s.slug === item.slug))
    .map(g => g.name);
}

export function itemCard(item, myGroups, subGroups, onChange) {
  const st = el("div", { className: "st" });
  const eps = el("div", { className: "itin" });
  const key = `${item.provider}|${item.slug}`;
  return el("div", { className: "card" },
    item.image ? el("img", { src: safe(item.image) }) : "",
    el("div", { className: "body" },
      el("b", { textContent: item.title }),
      el("div", { textContent: "Visto hasta el episodio " + (item.last || 0) }),
      el("div", { className: "actions" },
        btn("Siguiente", async () => {
          const p = prov(item.provider);
          await ensurePermissions();
          const n = (item.last || 0) + 1;
          st.textContent = "Comprobando…";
          try {
            const r = await engine.checkEpisode(p, item.slug, n);
            st.replaceChildren(r.exists ? link(r.url, `Ep ${n} disponible ▶`) : `Ep ${n}: aún no`);
          } catch (e) { st.textContent = "Error: " + explain(e); }
        }),
        btn("Episodios", async () => {
          await ensurePermissions();
          eps.textContent = "Cargando…";
          try {
            const l = await engine.episodes(prov(item.provider), item.slug);
            const renderEps = () => {
              const sel = epsSel.get(key);
              eps.replaceChildren(
                ...(l.length ? l.map(e => {
                  const seen = e.number <= (item.last || 0);
                  const badge = el("span", {
                    className: "ep" + (seen ? " seen" : "") + (sel === e.number ? " selected" : ""),
                    textContent: String(e.number)
                  });
                  badge.onclick = () => { epsSel.set(key, sel === e.number ? null : e.number); renderEps(); };
                  return badge;
                }) : ["Sin episodios"]),
                sel != null ? renderItemEpisodePanel(item, sel, sel <= (item.last || 0), close => {
                  if (close) epsSel.delete(key);
                  renderEps();
                }) : "");
            };
            renderEps();
          } catch (e) { eps.textContent = "Error: " + explain(e); }
        }),
        btn("Visto +1", async () => {
          const it = await mutate(item.provider, item.slug, x => { x.last = (x.last || 0) + 1; });
          if (it) {
            const news = await get("news", []);
            await set("news", news.filter(n => !(n.provider === it.provider && n.slug === it.slug && n.episode <= it.last)));
          }
          onChange(); requestSync();
        }),
        btn("Ocultar", async () => {
          // A diferencia de Quitar, esconder no borra nada ni rompe el seguimiento de ningún
          // grupo: el ítem sigue en watchlist, solo deja de mostrarse como tarjeta suelta.
          await mutate(item.provider, item.slug, x => { x.visible = false; });
          onChange(); requestSync();
        }),
        btn("Quitar", async () => {
          const refs = groupsReferencing(item, myGroups, subGroups);
          if (refs.length) {
            st.textContent = `No se puede quitar: lo usa el grupo "${refs[0]}"${refs.length > 1 ? ` y ${refs.length - 1} más` : ""}. Quita ese paso del grupo (o date de baja) primero.`;
            return;
          }
          await mutate(item.provider, item.slug, x => { x.deleted = true; }); onChange(); requestSync();
        })),
      st, eps));
}
```

- [ ] **Step 5: src/app/ui/group-card.js**

Copia exacta de `src/extension/ui/group-card.js`, sin cambios de contenido
(no tiene ningún acoplamiento a `msg()`/`#msg` global — usa siempre su
propio elemento `st` local o `explain()`).

- [ ] **Step 6: src/app/ui/main-list.js**

Copia exacta de `src/extension/ui/main-list.js`, sin cambios de contenido.

- [ ] **Step 7: src/app/ui/explore.js**

Copia exacta de `src/extension/ui/explore.js`, sin cambios de contenido.

- [ ] **Step 8: src/app/ui/group-builder.js**

Base: `src/web/ui/group-builder.js` (ya usa `$("#groupMsg")` en vez de un
`msg()` global), con una llamada añadida de vuelta — `await ensurePermissions(p.id);`
antes del fetch de `$("#stepSearchBtn").onclick`, que en la versión de la
PWA nunca existió:

```js
import * as engine from "../engine.js";
import { get } from "../store.js";
import { live, add } from "../list.js";
import * as groups from "../groups.js";
import { $, el, btn, explain } from "./dom.js";
import { providers, prov } from "./state.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

let draftSteps = [];
let importDraft = [];

function renderDraftSteps() {
  $("#groupSteps").replaceChildren(...draftSteps.map((s, i) => el("div", { className: "row" },
    el("span", { textContent:
      `${i + 1}. ${s.slug} (${s.from}-${s.to}${s.exclude.length ? ", excl " + s.exclude.join(",") : ""})` }),
    btn("↑", () => { if (i > 0) { [draftSteps[i - 1], draftSteps[i]] = [draftSteps[i], draftSteps[i - 1]]; renderDraftSteps(); } }),
    btn("↓", () => { if (i < draftSteps.length - 1) { [draftSteps[i + 1], draftSteps[i]] = [draftSteps[i], draftSteps[i + 1]]; renderDraftSteps(); } }),
    btn("✕", () => { draftSteps.splice(i, 1); renderDraftSteps(); }))));
}

const readRange = () => ({
  from: +$("#stepFrom").value || 1,
  to: +$("#stepTo").value || 1,
  exclude: $("#stepExclude").value.split(",").map(s => +s.trim()).filter(Boolean)
});
const clearRange = () => { $("#stepFrom").value = "1"; $("#stepTo").value = "1"; $("#stepExclude").value = ""; };

$("#addStepBtn").onclick = () => {
  const [provider, slug] = ($("#stepItem").value || "").split("|");
  if (!provider) return;
  draftSteps.push({ provider, slug, ...readRange() });
  clearRange();
  renderDraftSteps();
};

// Alternativa a "elige de tu lista": buscar directamente en un provider concreto y añadir el
// paso con ESE provider+slug, sin tocar la entrada de esa serie que ya tuvieras (si la tenías
// con otro provider). Igual que hace el asistente de import, guarda en la lista antes de
// añadir el paso — si no, el paso apuntaría a un ítem que no existe.
$("#stepSearchBtn").onclick = async () => {
  const p = prov($("#stepSearchProv").value);
  const q = $("#stepSearchQ").value.trim();
  if (!p || !q) return;
  await ensurePermissions(p.id);
  $("#stepSearchResults").replaceChildren("Buscando…");
  try {
    const res = await engine.search(p, q);
    $("#stepSearchResults").replaceChildren(...(res.length
      ? res.map(r => btn(r.title, async () => {
          await add(r, { visible: false }); // solo para el paso, no es media añadida a propósito
          draftSteps.push({ provider: r.provider, slug: r.slug, ...readRange() });
          clearRange();
          renderDraftSteps();
          $("#stepSearchResults").replaceChildren();
          $("#stepSearchQ").value = "";
        }))
      : ["Sin resultados"]));
  } catch (e) { $("#stepSearchResults").replaceChildren("Error: " + explain(e)); }
};

// Paso 1: pegar el JSON de una IA (título + rango) y leerlo.
$("#importParseBtn").onclick = () => {
  let data;
  try { data = JSON.parse($("#importJson").value); }
  catch (e) { $("#groupMsg").textContent = "JSON inválido: " + e.message; return; }
  if (data.name) $("#groupName").value = data.name;
  importDraft = (data.steps || []).map(s => ({
    title: s.title || "", from: s.from ?? 1, to: s.to ?? 1, exclude: s.exclude || [], provider: null
  }));
  renderImportRows();
  $("#importAssign").hidden = false;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
};

function renderImportRows() {
  $("#importRows").replaceChildren(...importDraft.map((row, i) => el("div", { className: "row" },
    el("input", { type: "checkbox", id: `imp${i}` }),
    el("span", { textContent: `${row.title}${row.provider ? " → " + (prov(row.provider)?.name || row.provider) : ""}` }))));
}

// Paso 2: marcar uno o varios títulos y aplicarles el provider elegido a la vez.
$("#importApplyBtn").onclick = () => {
  const p = $("#importProviderPick").value;
  if (!p) return;
  let n = 0;
  importDraft.forEach((row, i) => { if ($("#imp" + i).checked) { row.provider = p; n++; } });
  renderImportRows();
  $("#groupMsg").textContent = n ? `Provider aplicado a ${n} título${n === 1 ? "" : "s"}.` : "Marca al menos un título primero.";
};

// Paso 3: buscar cada título en su provider y dejar elegir el resultado correcto.
$("#importSearchBtn").onclick = async () => {
  if (!importDraft.length) return;
  if (importDraft.some(r => !r.provider)) { $("#groupMsg").textContent = "Asigna un provider a todos los títulos antes de buscar"; return; }
  $("#importResults").hidden = false;
  $("#importResults").replaceChildren();
  for (const row of importDraft) {
    const list = el("div", {});
    const box = el("div", { className: "card" }, el("div", { className: "body" }, el("b", { textContent: row.title }), list));
    $("#importResults").append(box);
    try {
      const res = await engine.search(prov(row.provider), row.title);
      list.replaceChildren(...(res.length
        ? res.map(r => btn(r.title, async () => {
            // solo para el paso, no es media añadida a propósito (sin esto el paso apuntaría a un ítem que no existe)
            await add(r, { visible: false });
            draftSteps.push({ provider: row.provider, slug: r.slug, from: row.from, to: row.to, exclude: row.exclude });
            renderDraftSteps();
            box.remove();
          }))
        : [el("span", { className: "st", textContent: "Sin resultados" })]));
    } catch (e) { list.textContent = "Error: " + explain(e); }
  }
};

$("#newGroup").onclick = async () => {
  draftSteps = [];
  $("#groupName").value = "";
  $("#groupPublic").checked = false;
  $("#stepFrom").value = "1";
  $("#stepTo").value = "1";
  $("#stepExclude").value = "";
  $("#groupMsg").textContent = "";
  renderDraftSteps();
  const items = live(await get("watchlist", []));
  $("#stepItem").replaceChildren(...items.map(it =>
    el("option", { value: `${it.provider}|${it.slug}`, textContent: it.title })));
  $("#stepSearchProv").replaceChildren(...providers.map(p =>
    el("option", { value: p.id, textContent: `${p.name || p.id} (${(p.language || "?").toUpperCase()})` })));
  $("#stepSearchQ").value = "";
  $("#stepSearchResults").replaceChildren();
  importDraft = [];
  $("#importJson").value = "";
  $("#importAssign").hidden = true;
  $("#importResults").hidden = true;
  $("#importResults").replaceChildren();
  $("#importProviderPick").replaceChildren(...providers.map(p => el("option", { value: p.id, textContent: p.name || p.id })));
  $("#groupForm").hidden = false;
};

$("#cancelGroupBtn").onclick = () => { $("#groupForm").hidden = true; };

$("#saveGroupBtn").onclick = async () => {
  const name = $("#groupName").value.trim();
  if (!name) { $("#groupMsg").textContent = "Ponle un nombre al grupo"; return; }
  if (!draftSteps.length) { $("#groupMsg").textContent = "Añade al menos un paso: usa ＋ Añadir paso, o Buscar + elegir resultado si vienes del JSON"; return; }
  const g = await groups.addGroup(name);
  for (const s of draftSteps) await groups.addStep(g.id, s);
  if ($("#groupPublic").checked) await groups.setPublic(g.id, true);
  $("#groupForm").hidden = true;
  renderMain();
  requestSync();
};
```

- [ ] **Step 9: src/app/ui/search.js**

Base: `src/web/ui/search.js`, con `await ensurePermissions(targets.map(p => p.id));`
añadido de vuelta antes del `Promise.allSettled`:

```js
import * as engine from "../engine.js";
import { add } from "../list.js";
import { $, el, link, btn, safe, explain } from "./dom.js";
import { providers, selectedLangs } from "./state.js";
import { ensurePermissions } from "./permissions.js";
import { requestSync } from "./sync.js";
import { renderMain } from "./main-list.js";

$("#go").onclick = async () => {
  const q = $("#q").value.trim();
  const langs = new Set(selectedLangs());
  const targets = providers.filter(p => langs.has(p.language || "?"));
  $("#searchMsg").textContent = "";
  if (!q) { $("#searchMsg").textContent = "Escribe algo para buscar."; return; }
  if (!targets.length) { $("#searchMsg").textContent = "Selecciona al menos un idioma."; return; }
  await ensurePermissions(targets.map(p => p.id));
  $("#searchMsg").textContent = "Buscando…";
  const settled = await Promise.allSettled(targets.map(p =>
    engine.search(p, q).then(res => res.map(r => ({ ...r, _providerName: p.name || p.id })))));
  const merged = settled.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  const rejected = settled.filter(r => r.status === "rejected");
  // Si TODOS los providers fallaron, "Sin resultados" mentiría (parece "no hay nada" cuando en
  // realidad la búsqueda ni se pudo hacer) — se muestra el error real del primero.
  $("#searchMsg").textContent = merged.length
    ? (rejected.length ? `${rejected.length} provider(s) fallaron al buscar` : "")
    : (rejected.length ? "Error: " + explain(rejected[0].reason) : "Sin resultados");
  $("#results").replaceChildren(...merged.map(r => el("div", { className: "card" },
    r.image ? el("img", { src: safe(r.image) }) : "",
    el("div", { className: "body" }, el("b", { textContent: r.title }),
      el("div", { className: "st", textContent: r._providerName }),
      el("div", { className: "actions" },
        btn("＋ Guardar", async () => { await add(r); await renderMain(); requestSync(); $("#searchMsg").textContent = "Guardada"; }),
        link(r.link, "Abrir"))))));
};
$("#q").addEventListener("keydown", e => { if (e.key === "Enter") $("#go").click(); });
```

- [ ] **Step 10: Verificar sintaxis**

```bash
for f in src/app/ui/{state,player,episode-panel,list-item,group-card,main-list,explore,group-builder,search}.js; do node --check "$f"; done
```
Todos deben pasar (los imports a `./dom.js`, `./permissions.js`, `./sync.js`
apuntan a archivos que Task 3 todavía no ha creado — `node --check` solo
valida sintaxis, no resuelve imports, así que esto es seguro en este punto).

- [ ] **Step 11: Commit**

```bash
git add src/app/ui/
git commit -m "feat: fusionar 9 módulos de UI sin diferencias de comportamiento en src/app/ui/"
```

---

### Task 3: Fusionar dom.js, permissions.js, sync.js con detección de entorno

**Files:**
- Create: `src/app/ui/dom.js`, `src/app/ui/permissions.js`, `src/app/ui/sync.js`

**Interfaces:**
- Consumes: `src/app/sync.js` (`syncNow`, Task 1), `src/app/ui/state.js` (`prov`, Task 2).
- Produces: `$`, `el`, `safe`, `link`, `btn`, `explain` (dom.js — **sin** `msg`, ver nota abajo);
  `ensurePermissions`, `setWatchlistCache`, `updatePermBanner` (permissions.js);
  `requestSync` (sync.js). Usados por todos los módulos de Task 2 y por
  ambos entry points en Task 4.

**Nota importante:** la versión de la extensión de `dom.js` exportaba un
`msg()` que escribe a `$("#msg")` — la PWA no tiene ningún elemento `#msg`
en su HTML, así que si el `dom.js` compartido siguiera exportando `msg()`
y algún módulo de `src/app/ui/` lo llamara, reventaría con
`Cannot set properties of null` en la PWA. Por eso `msg()` se elimina del
`dom.js` compartido — el mensaje global de la extensión (errores de
"Comprobar todos", fallo al pedir permiso) se define localmente dentro de
`src/extension/popup.js` en la Tarea 4, que es el único sitio que lo usa.

- [ ] **Step 1: src/app/ui/dom.js**

```js
export const $ = s => document.querySelector(s);
export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  kids.flat().forEach(k => n.append(k));
  return n;
};
export const safe = u => (/^https?:/i.test(u || "") ? u : "#");
export const link = (href, text) => el("a", { href: safe(href), target: "_blank", rel: "noopener", textContent: text });
export const btn = (text, fn, cls) => { const b = el("button", { textContent: text, className: cls || "small" }); b.onclick = fn; return b; };
// El texto de "falta permiso" solo tiene sentido donde existe el modelo de permisos de Chrome;
// en la PWA (sin chrome.permissions, usa un proxy CORS) un TypeError de red es simplemente eso.
export const explain = e => e instanceof TypeError
  ? (typeof chrome !== "undefined" && chrome.permissions
      ? "No se pudo conectar. Puede que falte conceder permiso a ese dominio — vuelve a intentarlo."
      : "No se pudo conectar.")
  : e.message;
```

- [ ] **Step 2: src/app/ui/permissions.js**

```js
import { $ } from "./dom.js";
import { prov } from "./state.js";

// Copia de la lista tal y como la acaba de pintar renderMain(). Existe para que
// ensurePermissions() pueda leerla SIN await: chrome.permissions.request() solo funciona si se
// llama dentro de la pila de llamadas del clic, y cualquier await previo rompe ese gesto.
export let watchlistCache = [];
export function setWatchlistCache(w) { watchlistCache = w; }

function domainOrigin(p) { const u = new URL(p.base_url); return `${u.protocol}//${u.hostname}/*`; }

function watchlistOrigins(extraIds) {
  const ids = new Set(watchlistCache.map(w => w.provider));
  (Array.isArray(extraIds) ? extraIds : extraIds ? [extraIds] : []).forEach(id => ids.add(id));
  return [...new Set([...ids].map(id => prov(id)).filter(Boolean).map(domainOrigin))];
}

// Pide permiso de Chrome para los dominios de los providers en uso, en el mismo gesto de clic
// que ya está en curso. OJO: nada de await antes de chrome.permissions.request() — por eso la
// función no es async y usa watchlistCache. La PWA no tiene chrome.permissions (usa un proxy
// CORS): ahí es un no-op inmediato.
export function ensurePermissions(extraIds) {
  if (typeof chrome === "undefined" || !chrome.permissions) return Promise.resolve();
  const origins = watchlistOrigins(extraIds);
  if (!origins.length) return Promise.resolve();
  return chrome.permissions.request({ origins }).catch(e => {
    $("#msg").textContent = "No se pudo pedir el permiso: " + e.message;
  });
}

// El aviso de permisos es el único sitio donde un usuario normal puede concederlos de golpe.
// La PWA no tiene banner de permisos (#permBanner no existe en su HTML) — no-op ahí.
export async function updatePermBanner() {
  const banner = $("#permBanner");
  if (!banner || typeof chrome === "undefined" || !chrome.permissions) return;
  const origins = watchlistOrigins();
  const ok = !origins.length || await chrome.permissions.contains({ origins });
  banner.hidden = ok;
}

const grantBtn = $("#grantPerms"); // no existe en la PWA
if (grantBtn) grantBtn.onclick = async () => { await ensurePermissions(); updatePermBanner(); };
```

- [ ] **Step 3: src/app/ui/sync.js**

```js
import { syncNow } from "../sync.js";

let syncing = null;

// La extensión delega al service worker: el popup es un contexto efímero que se destruye al
// perder el foco, cancelando cualquier fetch en curso, así que centraliza y deduplica ahí. La
// PWA no tiene ese contexto persistente — sincroniza aquí mismo con dedup en memoria.
export function requestSync() {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    return chrome.runtime.sendMessage({ type: "sync" }).then(r => {
      if (!r?.ok) throw new Error(r?.error || "Sync fallida");
    });
  }
  if (!syncing) syncing = syncNow().finally(() => { syncing = null; });
  return syncing;
}
```

- [ ] **Step 4: Verificar sintaxis**

```bash
for f in src/app/ui/{dom,permissions,sync}.js; do node --check "$f"; done
```

- [ ] **Step 5: Commit**

```bash
git add src/app/ui/dom.js src/app/ui/permissions.js src/app/ui/sync.js
git commit -m "feat: fusionar dom/permissions/sync con detección de entorno en src/app/ui/"
```

---

### Task 4: Cutover — conectar entry points, unificar CSS, borrar duplicados

**Files:**
- Modify: `src/extension/popup.js`, `src/extension/popup.html`, `src/extension/ui/news.js`
- Modify: `src/web/app.js`, `src/web/style.css`, `src/web/ui/config.js`
- Delete: `src/extension/ui/{dom,state,permissions,sync,player,episode-panel,list-item,group-card,main-list,explore,group-builder,search}.js` (12 archivos)
- Delete: `src/web/ui/{dom,state,sync,player,episode-panel,list-item,group-card,main-list,explore,group-builder,search}.js` (11 archivos)

**Interfaces:**
- Consumes: los 12 módulos de `src/app/ui/` (Tasks 2 y 3).

- [ ] **Step 1: Añadir #searchMsg y #groupMsg a src/extension/popup.html**

Buscar:
```html
  <div class="row" style="margin-top:6px"><input id="q" placeholder="Re:Zero"><button id="go">Buscar</button></div>
  <div id="results"></div>
```
Reemplazar por:
```html
  <div class="row" style="margin-top:6px"><input id="q" placeholder="Re:Zero"><button id="go">Buscar</button></div>
  <p id="searchMsg" class="st"></p>
  <div id="results"></div>
```

Buscar:
```html
    <div class="row" style="margin-top:6px">
      <button id="addStepBtn">＋ Añadir paso</button>
      <button id="saveGroupBtn">Guardar</button>
      <button id="cancelGroupBtn">Cancelar</button>
    </div>
  </div>
</div>
```
Reemplazar por:
```html
    <div class="row" style="margin-top:6px">
      <button id="addStepBtn">＋ Añadir paso</button>
      <button id="saveGroupBtn">Guardar</button>
      <button id="cancelGroupBtn">Cancelar</button>
    </div>
    <p id="groupMsg" class="st"></p>
  </div>
</div>
```

- [ ] **Step 2: Unificar clases CSS en src/web/style.css**

Buscar la línea:
```css
.hint { font-size: .85rem; opacity: .75; margin: 2px 0 8px; }
```
Reemplazar por:
```css
.hint, .st { font-size: .85rem; opacity: .75; margin: 2px 0 8px; }
```
(`.itin` y el resto de clases usadas por los módulos compartidos —
`.card`, `.actions`, `.avatars`, `.avatar`, `.ep`, `.player-frame` — ya
coinciden de nombre entre ambas hojas de estilo, solo difieren en tamaños,
que es cosmético por app y no necesita cambiar.)

- [ ] **Step 3: Reescribir src/extension/popup.js**

```js
import { getSession } from "../app/sync.js";
import { $, explain } from "../app/ui/dom.js";
import { fillProviders } from "../app/ui/state.js";
import { ensurePermissions } from "../app/ui/permissions.js";
import { requestSync } from "../app/ui/sync.js";
import { renderMain, setListFilter } from "../app/ui/main-list.js";
import { renderNews } from "./ui/news.js";
import "../app/ui/search.js";
import "../app/ui/group-builder.js";
import "../app/ui/explore.js";

const msg = t => { $("#msg").textContent = t || ""; };

$("#tabAll").onclick = () => setView("all");
$("#tabExplore").onclick = () => setView("explore");

function setView(v) {
  $("#allView").hidden = v !== "all";
  $("#exploreView").hidden = v !== "explore";
  $("#tabAll").classList.toggle("active", v === "all");
  $("#tabExplore").classList.toggle("active", v === "explore");
  if (v === "all") renderMain();
}

$("#listFilter").addEventListener("change", () => {
  setListFilter(document.querySelector('input[name="listf"]:checked').value);
  renderMain();
});

// Sincroniza si hay sesión; en modo silencioso no molesta con errores.
async function sync(quiet = true) {
  if (!(await getSession())) { $("#cloud").textContent = ""; if (!quiet) msg("Inicia sesión en Opciones para sincronizar."); return; }
  $("#cloud").textContent = "sync…";
  try {
    await requestSync();
    $("#cloud").textContent = "✓";
    await fillProviders();
    if (!$("#allView").hidden) renderMain();
    if (!quiet) msg("Sincronizado");
  } catch (e) {
    $("#cloud").textContent = "⚠";
    if (!quiet) msg("Error de sync: " + explain(e));
  }
}

$("#opts").onclick = () => chrome.runtime.openOptionsPage();
$("#sync").onclick = () => sync(false);

$("#all").onclick = async () => {
  await ensurePermissions();
  msg("Sincronizando y comprobando en segundo plano…");
  try { await chrome.runtime.sendMessage({ type: "checkNow" }); await fillProviders(); renderMain(); msg("Listo"); }
  catch (e) { msg("Error: " + e.message); }
};

async function init() {
  await fillProviders();
  renderNews();
  renderMain();
  sync();
}

init();
```

- [ ] **Step 4: Actualizar src/extension/ui/news.js**

```js
import { get, set } from "../../app/store.js";
import { $, el, link, btn } from "../../app/ui/dom.js";

export async function renderNews() {
  const news = await get("news", []);
  $("#newsBox").hidden = !news.length;
  $("#news").replaceChildren(...news.map(n => el("div", { className: "news" },
    link(n.link, n.title),
    btn("✕", async () => set("news", (await get("news", [])).filter(x => x.id !== n.id))))));
}

chrome.storage.onChanged.addListener((c, a) => { if (a === "local" && c.news) renderNews(); });
```

- [ ] **Step 5: Reescribir la sección de imports de src/web/app.js**

Buscar:
```js
import "./proxy.js";
import { get, set } from "../app/store.js";
import { signIn, signUp, signOut, getSession } from "../app/sync.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { $, explain } from "./ui/dom.js";
import { fillProviders } from "./ui/state.js";
import { requestSync } from "./ui/sync.js";
import { renderMain, setListFilter } from "./ui/main-list.js";
import { renderConfig } from "./ui/config.js";
import "./ui/search.js";
import "./ui/group-builder.js";
import "./ui/explore.js";
```
Reemplazar por:
```js
import "./proxy.js";
import { get, set } from "../app/store.js";
import { signIn, signUp, signOut, getSession } from "../app/sync.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import { $, explain } from "../app/ui/dom.js";
import { fillProviders } from "../app/ui/state.js";
import { requestSync } from "../app/ui/sync.js";
import { renderMain, setListFilter } from "../app/ui/main-list.js";
import { renderConfig } from "./ui/config.js";
import "../app/ui/search.js";
import "../app/ui/group-builder.js";
import "../app/ui/explore.js";
```
(el resto del archivo, desde `$("#tabAll").onclick` en adelante, no cambia.)

- [ ] **Step 6: Actualizar src/web/ui/config.js**

```js
import { get } from "../../app/store.js";
import { saveAppProviders } from "../../app/sync.js";
import { $, explain } from "../../app/ui/dom.js";
import { fillProviders } from "../../app/ui/state.js";

export async function renderConfig() {
  $("#providersJson").value = JSON.stringify(await get("providers", []), null, 2);
  $("#configMsg").textContent = "";
}

$("#saveProvidersBtn").onclick = async () => {
  let arr;
  try {
    arr = JSON.parse($("#providersJson").value);
    if (!Array.isArray(arr)) throw new Error("Debe ser una lista [ ... ]");
    for (const p of arr) {
      for (const k of ["id", "base_url", "search", "episode"]) if (!p[k]) throw new Error(`Falta "${k}" en un provider`);
      if (!p.search.slug_regex) throw new Error(`Falta search.slug_regex en "${p.id}"`);
      new URL(p.base_url);
    }
  } catch (e) { $("#configMsg").textContent = "JSON no válido: " + e.message; return; }

  try { await saveAppProviders(arr); }
  catch (e) { $("#configMsg").textContent = "Error al guardar: " + explain(e); return; }
  await fillProviders();
  $("#configMsg").textContent = "Guardado.";
};
```

- [ ] **Step 7: Borrar los 23 archivos duplicados**

```bash
git rm src/extension/ui/dom.js src/extension/ui/state.js src/extension/ui/permissions.js \
       src/extension/ui/sync.js src/extension/ui/player.js src/extension/ui/episode-panel.js \
       src/extension/ui/list-item.js src/extension/ui/group-card.js src/extension/ui/main-list.js \
       src/extension/ui/explore.js src/extension/ui/group-builder.js src/extension/ui/search.js
git rm src/web/ui/dom.js src/web/ui/state.js src/web/ui/sync.js src/web/ui/player.js \
       src/web/ui/episode-panel.js src/web/ui/list-item.js src/web/ui/group-card.js \
       src/web/ui/main-list.js src/web/ui/explore.js src/web/ui/group-builder.js src/web/ui/search.js
```

- [ ] **Step 8: Verificar**

```bash
node --check src/extension/popup.js
node --check src/web/app.js
node --check src/extension/ui/news.js
node --check src/web/ui/config.js
bash tests/run.sh
```

Además, la misma comprobación cruzada usada en la sesión anterior (imports
resuelven a archivos reales, cada `$("#id")` referenciado existe en su HTML):

```bash
for f in src/extension/popup.js src/extension/ui/*.js src/app/ui/*.js; do
  dir=$(dirname "$f")
  grep -oE 'from "\.[^"]+"' "$f" | sed 's/from "//;s/"$//' | while read -r p; do
    resolved=$(node -e "console.log(require('path').resolve('$dir', '$p'))")
    [ -f "$resolved" ] || echo "MISSING: $f -> $p"
  done
done
grep -hoE '\$\("#[A-Za-z0-9_]+"\)' src/extension/popup.js src/extension/ui/*.js src/app/ui/*.js | sed -E 's/\$\("#|"\)//g' | sort -u > /tmp/js_ids.txt
grep -oE 'id="[A-Za-z0-9_]+"' src/extension/popup.html | sed -E 's/id="|"//g' | sort -u > /tmp/html_ids.txt
comm -23 /tmp/js_ids.txt /tmp/html_ids.txt   # debe salir vacío
```

Repetir el mismo par de comprobaciones para `src/web/app.js`, `src/web/ui/*.js`,
`src/app/ui/*.js` contra `src/web/index.html`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: conectar ambos entry points a src/app/ui/, unificar CSS, borrar UI duplicada"
```

---

### Task 5: Migrar tests/ a src/test/ con node:test

**Files:**
- Create: `src/test/engine.spec.js`, `src/test/store.spec.js`, `src/test/list.spec.js`, `src/test/groups.spec.js`, `src/test/sync.spec.js`, `src/test/ui/permissions.spec.js`, `src/test/ui/sync.spec.js`, `src/test/integration/sync-cron.spec.js`, `src/test/run.sh`
- Move: `tests/mock_site.py` → `src/test/mock_site.py`, `tests/mock_supabase.py` → `src/test/mock_supabase.py`, `tests/mock-provider.json` → `src/test/mock-provider.json`, `tests/mock-provider-mirror.json` → `src/test/mock-provider-mirror.json`
- Modify: `package.json`
- Delete: `tests/` (retirado tras la migración)

**Interfaces:**
- Consumes: `src/app/{engine,store,list,groups,sync}.js`, `src/app/ui/{permissions,sync}.js`, `cron/generate-feed.mjs`.

- [ ] **Step 1: Mover fixtures y mocks**

```bash
mkdir -p src/test/ui src/test/integration
git mv tests/mock_site.py src/test/mock_site.py
git mv tests/mock_supabase.py src/test/mock_supabase.py
git mv tests/mock-provider.json src/test/mock-provider.json
git mv tests/mock-provider-mirror.json src/test/mock-provider-mirror.json
```

- [ ] **Step 2: src/test/engine.spec.js**

Leer `tests/test-engine.mjs` completo primero. Portar cada bloque de
aserciones a `describe`/`it`, preservando cada `assert.*` byte por byte
(mismos valores esperados) — solo cambian: el import de `../extension/engine.js`
a `../app/engine.js`, y las líneas `console.log(...)` narrativas se
convierten en la descripción del `it()` correspondiente en vez de
imprimirse. Estructura esperada (rellenar cada `it` con las aserciones
exactas del archivo original):

```js
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

describe("engine.search", () => {
  it("devuelve resultados con título/link/imagen para un provider basado en regex", async () => {
    // portar aquí la aserción de `res` de tests/test-engine.mjs
  });
});

describe("engine.episodes / checkEpisode", () => {
  it("lista episodios y detecta cuáles existen", async () => {
    // portar episodes/checkEpisode/ep3/ep4
  });
});

describe("engine.episodeUrl", () => {
  it("arma la URL del episodio con la plantilla del provider", () => {
    // portar assert.equal(epUrl, ...)
  });
});

describe("engine.episodePlayers", () => {
  it("separa SUB/DUB para un provider con embeds_regex", async () => {
    // portar assert.deepEqual(players.SUB, ...) y players.DUB
  });
  it("devuelve null si el provider no declara embeds_regex", async () => {
    // portar noEmbeds
  });
  it("soporta mirror_select (estilo AnimeFlix): iframe por defecto + <select> en base64", async () => {
    // portar mirrorPlayers
  });
});
```

- [ ] **Step 3: src/test/list.spec.js y src/test/groups.spec.js**

Leer `tests/test-groups.mjs` completo. Es una mezcla: las partes de CRUD
sobre watchlist (`add`, `live` de `list.js`) van a `list.spec.js`; el
resto (`nextNeeded`, `currentStep`, `itinerary`, `markUpTo`, `unmarkFrom`,
`missingSteps`/`repairGroup`, `setPublic`, `subscribe`/`unsubscribe`) va a
`groups.spec.js`. Mismo criterio que Step 2: `describe` por función/
comportamiento, `it` por caso, aserciones idénticas, imports actualizados
a `../app/list.js` / `../app/groups.js` / `../app/store.js` / `../app/engine.js`.

- [ ] **Step 4: src/test/sync.spec.js**

Leer la parte de `tests/test-sync-cron.mjs` que ejercita `sync.js`
directamente (no los escenarios multiusuario contra el mock de Supabase,
esos van a `integration/sync-cron.spec.js` en el Step 6). Mismo criterio.

- [ ] **Step 5: src/test/store.spec.js (cobertura nueva)**

No existe hoy ningún test que ejercite explícitamente el fallback de
`store.js` entre `chrome.storage.local` y `localStorage`. Este es exactamente
el mecanismo del que depende toda la fusión de las Tareas 2-4, así que se
fija aquí:

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

describe("store: fallback chrome.storage.local / localStorage", () => {
  let dom;
  beforeEach(() => {
    dom = new JSDOM("", { url: "http://localhost" });
    globalThis.localStorage = dom.window.localStorage;
    delete globalThis.chrome;
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.localStorage; });

  it("sin chrome.storage, get/set usan localStorage", async () => {
    const { get, set } = await import("../app/store.js?nochrome");
    await set("k", { a: 1 });
    assert.deepEqual(await get("k", null), { a: 1 });
  });

  it("con chrome.storage.local presente, get/set lo usan en vez de localStorage", async () => {
    const backing = {};
    globalThis.chrome = { storage: { local: {
      get: async key => ({ [key]: backing[key] }),
      set: async obj => { Object.assign(backing, obj); }
    } } };
    const { get, set } = await import("../app/store.js?withchrome");
    await set("k2", { b: 2 });
    assert.deepEqual(await get("k2", null), { b: 2 });
    assert.equal(localStorage.getItem("k2"), null); // no tocó localStorage
  });
});
```

(Los query strings `?nochrome`/`?withchrome` fuerzan una nueva instancia
del módulo por test, ya que `store.js` no tiene estado propio a nivel de
módulo pero el import cacheado por Node reutilizaría el mismo si se
importara con la misma URL exacta en ambos tests.)

- [ ] **Step 6: src/test/ui/permissions.spec.js (cobertura nueva)**

Fija el comportamiento central de la Tarea 3: `ensurePermissions` es un
no-op sin `chrome.permissions`, y hace la petición real cuando existe.

```js
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

describe("ui/permissions: detección de entorno", () => {
  let dom;
  beforeEach(() => {
    dom = new JSDOM('<div id="permBanner" hidden></div><button id="grantPerms"></button>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    delete globalThis.chrome;
  });
  afterEach(() => { delete globalThis.chrome; delete globalThis.document; });

  it("sin chrome.permissions, ensurePermissions no hace nada", async () => {
    const { ensurePermissions } = await import("../../app/ui/permissions.js?nochrome");
    await assert.doesNotReject(() => ensurePermissions());
  });

  it("sin chrome.permissions, updatePermBanner no toca el banner", async () => {
    const { updatePermBanner } = await import("../../app/ui/permissions.js?nochrome2");
    await updatePermBanner();
    assert.equal(dom.window.document.querySelector("#permBanner").hidden, true);
  });

  it("con chrome.permissions, ensurePermissions pide los orígenes de la watchlist", async () => {
    let requested = null;
    globalThis.chrome = { permissions: { request: async o => { requested = o; return true; }, contains: async () => true } };
    const mod = await import("../../app/ui/permissions.js?withchrome");
    const state = await import("../../app/ui/state.js?withchrome");
    state.providers.push({ id: "mock", base_url: "http://127.0.0.1:8001" });
    mod.setWatchlistCache([{ provider: "mock" }]);
    await mod.ensurePermissions();
    assert.deepEqual(requested, { origins: ["http://127.0.0.1/*"] });
  });
});
```

- [ ] **Step 7: src/test/ui/sync.spec.js (cobertura nueva)**

Fija que `requestSync` delega a `chrome.runtime.sendMessage` cuando existe,
y usa `syncNow()` con dedup en memoria cuando no.

```js
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

describe("ui/sync: detección de entorno", () => {
  afterEach(() => { delete globalThis.chrome; });

  it("con chrome.runtime, delega al service worker", async () => {
    let sent = null;
    globalThis.chrome = { runtime: { sendMessage: async msg => { sent = msg; return { ok: true }; } } };
    const { requestSync } = await import("../../app/ui/sync.js?withchrome");
    await requestSync();
    assert.deepEqual(sent, { type: "sync" });
  });

  it("con chrome.runtime, propaga el error si la sync falla", async () => {
    globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: "boom" }) } };
    const { requestSync } = await import("../../app/ui/sync.js?withchrome-fail");
    await assert.rejects(() => requestSync(), /boom/);
  });
});
```

(No se agrega aquí un test del camino sin `chrome.runtime` porque llamaría
a `syncNow()` real contra Supabase — ese camino ya está cubierto end-to-end
por `integration/sync-cron.spec.js`.)

- [ ] **Step 8: src/test/integration/sync-cron.spec.js**

Leer `tests/test-sync-cron.mjs` completo. Portar los escenarios
multiusuario/cron/grupos públicos tal cual (A admin sube providers, B
recibe el grupo, cron encuentra episodios, grupo público descubrir/
suscribirse/valorar, visibilidad al despublicar, signOut limpia
ACCOUNT_KEYS) a `describe`/`it`, agrupando por escenario. Actualizar los
imports de `../extension/X.js` a `../../app/X.js` (dos niveles, por estar
en `src/test/integration/`) y de `../../cron/generate-feed.mjs` según
corresponda.

- [ ] **Step 9: src/test/run.sh**

```bash
#!/usr/bin/env bash
# Desde la raíz: npm install && bash src/test/run.sh
set -e
python3 src/test/mock_site.py & P1=$!
python3 src/test/mock_supabase.py & P2=$!
trap 'kill $P1 $P2 2>/dev/null' EXIT
sleep 1
node --test src/test
```

- [ ] **Step 10: Actualizar package.json**

Añadir sección `scripts`:
```json
"scripts": {
  "test": "bash src/test/run.sh"
}
```

- [ ] **Step 11: Retirar tests/**

```bash
git rm -r tests/
```

- [ ] **Step 12: Verificar**

```bash
chmod +x src/test/run.sh
npm test
```
Debe pasar en verde con el mismo conjunto de comportamientos que antes
verificaba `tests/run.sh`, más los 5 tests nuevos de `store.spec.js`,
`ui/permissions.spec.js` y `ui/sync.spec.js`.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "test: migrar tests/ a src/test/ con node:test, añadir cobertura de detección de entorno"
```

---

### Task 6: Deploy automático a GitHub Pages

**Files:**
- Create: `.github/workflows/deploy-pages.yml`

- [ ] **Step 1: Crear el workflow**

```yaml
name: Deploy PWA a GitHub Pages

on:
  push:
    branches: [master]
    paths:
      - "src/web/**"
  workflow_dispatch: {}

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: src/web
      - id: deployment
        uses: actions/deploy-pages@v4
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy-pages.yml
git commit -m "ci: deploy automático de src/web a GitHub Pages vía Actions"
```

- [ ] **Step 3: Avisar al usuario**

Este workflow no hace nada hasta que Settings → Pages del repo esté en
modo "GitHub Actions" en vez de "Deploy from a branch" — cambio manual de
una sola vez que requiere confirmación explícita antes de tocarlo (o que
el usuario lo haga directamente).
