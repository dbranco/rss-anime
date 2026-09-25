// Proxy para la PWA: hace el fetch al sitio del provider desde el servidor, donde CORS no aplica
// (un fetch() desde el navegador de la PWA a un sitio de terceros sin cabeceras CORS se bloquea;
// uno servidor-a-servidor no). Protegido por la verificación de JWT que Supabase aplica por defecto
// a las Edge Functions: solo una sesión válida de este proyecto puede invocarla.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const ip = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ip) {
    const a = Number(ip[1]), b = Number(ip[2]);
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      return true;
    }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "método no soportado" }, 405);

  const target = new URL(req.url).searchParams.get("url");
  if (!target) return json({ error: "falta ?url=" }, 400);

  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return json({ error: "url inválida" }, 400);
  }
  if (!["http:", "https:"].includes(u.protocol) || isBlockedHost(u.hostname)) {
    return json({ error: "destino no permitido" }, 400);
  }

  try {
    const r = await fetch(u.toString());
    const html = await r.text();
    return json({ status: r.status, url: r.url, html });
  } catch (e) {
    return json({ error: `fetch falló: ${String(e)}` }, 502);
  }
});
