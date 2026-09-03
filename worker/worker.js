// Proxies Gemini API calls so the key never leaves Cloudflare.
// Only requests from ALLOWED_ORIGINS are served.
const UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/";

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return new Response("Forbidden", { status: 403 });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
    if (!env.GEMINI_API_KEY) return new Response(JSON.stringify({ error: { message: "GEMINI_API_KEY secret not set on the Worker" } }), { status: 500, headers: { ...cors(origin), "Content-Type": "application/json" } });

    // Only allow the model endpoints the app uses
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (!/^models(\/[\w.-]+:generateContent)?$/.test(path)) return new Response("Not found", { status: 404, headers: cors(origin) });

    const upstream = await fetch(UPSTREAM + path + url.search, {
      method: request.method,
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
      body: request.method === "POST" ? await request.text() : undefined,
    });
    const headers = new Headers(cors(origin));
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
