require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const SYSTEM_PROMPT = `You are Maya, a warm, sweet, and deeply encouraging personal nutritionist.
You speak like a caring real human woman — gentle, upbeat, and motivating, never clinical or robotic.
You ALWAYS respond in English, no matter what.
Your philosophy: vibrant whole foods, lots of fruits and vegetables, colorful plates, hydration, and joy in eating.
You help the user eat better every day. You:
- Celebrate every small win warmly ("I'm so proud of you!")
- Give simple, practical meal ideas and swaps, not lectures
- Ask gentle follow-up questions about how they're feeling and what they ate
- Keep responses SHORT and conversational (2-4 sentences) since this is a spoken voice conversation
- Never shame the user for what they ate — always redirect with kindness
Remember details the user shares within the conversation (goals, foods they like/dislike).`;

// conversation memory (in-process, per server run)
let history = [];
const MAX_TURNS = 20;

app.post("/api/voice", upload.single("audio"), async (req, res) => {
  try {
    if (!OPENAI_KEY) return res.status(500).json({ error: "Missing OPENAI_API_KEY. Add it to the .env file and restart." });
    if (!req.file) return res.status(400).json({ error: "No audio received." });

    // 1) Transcribe with Whisper
    const form = new FormData();
    form.append("file", new Blob([req.file.buffer], { type: req.file.mimetype || "audio/webm" }), "speech.webm");
    form.append("model", "whisper-1");
    form.append("language", "en");
    const sttResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    });
    if (!sttResp.ok) throw new Error(`Transcription failed: ${await sttResp.text()}`);
    const { text: userText } = await sttResp.json();
    if (!userText || !userText.trim()) return res.json({ userText: "", reply: "", audio: null });

    // 🛒 Voice command: "sounds good, put that in my cart" → auto QFC order
    const cartPhrase = /(put|add|throw|stick)\s+(that|those|them|these|it|everything|all of (that|it))\s+(in|into|to)\s+(my|the)\s+cart|sounds good.*cart/i;
    if (cartPhrase.test(userText)) {
      history.push({ role: "user", content: userText });
      let reply, order = null;
      try {
        order = await buildQfcOrder();
        const names = order.added.map(f => f.description).slice(0, 5);
        reply = `Done, sweetie! I added ${order.added.length} items to your QFC cart — ${names.join(", ")}${order.added.length > 5 ? ", and more" : ""}. ` +
          (order.missing.length ? `I couldn't find ${order.missing.join(" or ")} at this store. ` : "") +
          `It's all set for pickup at ${order.store.name}. Just open your cart to choose a time and pay!`;
      } catch (err) {
        reply = err.needLogin
          ? "I'd love to, but your Kroger account isn't connected yet — click the blue Connect QFC button first!"
          : `Hmm, I hit a snag adding that to your cart: ${err.message}`;
      }
      history.push({ role: "assistant", content: reply });
      const ttsResp2 = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "tts-1", voice: "nova", input: reply, speed: 1.0 }),
      });
      const audioBuf2 = ttsResp2.ok ? Buffer.from(await ttsResp2.arrayBuffer()) : null;
      return res.json({ userText, reply, audio: audioBuf2 ? audioBuf2.toString("base64") : null, order });
    }

    // 2) Chat completion
    history.push({ role: "user", content: userText });
    if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
    const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        max_tokens: 220,
      }),
    });
    if (!chatResp.ok) throw new Error(`Chat failed: ${await chatResp.text()}`);
    const chatData = await chatResp.json();
    const reply = chatData.choices[0].message.content.trim();
    history.push({ role: "assistant", content: reply });

    // 3) Text-to-speech — warm female voice
    const ttsResp = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "tts-1", voice: "nova", input: reply, speed: 1.0 }),
    });
    if (!ttsResp.ok) throw new Error(`TTS failed: ${await ttsResp.text()}`);
    const audioBuf = Buffer.from(await ttsResp.arrayBuffer());

    res.json({ userText, reply, audio: audioBuf.toString("base64") });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/reset", (_req, res) => {
  history = [];
  res.json({ ok: true });
});

// ── Kroger / QFC integration ─────────────────────────────────────────────
const KROGER_ID = process.env.KROGER_CLIENT_ID;
const KROGER_SECRET = process.env.KROGER_CLIENT_SECRET;
const KROGER_REDIRECT = `http://localhost:${PORT}/kroger/callback`;
const KROGER_API = "https://api.kroger.com/v1";

let krogerUserToken = null;   // { access_token, refresh_token, expires_at }
let krogerAppToken = null;    // client_credentials token for product search
let qfcLocation = null;       // cached nearest QFC

// persist the user token so restarts don't require reconnecting
const TOKEN_FILE = path.join(__dirname, ".kroger_token.json");
try { krogerUserToken = JSON.parse(require("fs").readFileSync(TOKEN_FILE, "utf8")); } catch {}
function saveUserToken() {
  try { require("fs").writeFileSync(TOKEN_FILE, JSON.stringify(krogerUserToken)); } catch {}
}

const krogerBasic = () => "Basic " + Buffer.from(`${KROGER_ID}:${KROGER_SECRET}`).toString("base64");

async function krogerToken(params) {
  const resp = await fetch(`${KROGER_API}/connect/oauth2/token`, {
    method: "POST",
    headers: { Authorization: krogerBasic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!resp.ok) throw new Error(`Kroger token error: ${await resp.text()}`);
  const data = await resp.json();
  data.expires_at = Date.now() + (data.expires_in - 60) * 1000;
  return data;
}

async function appToken() {
  if (!krogerAppToken || Date.now() > krogerAppToken.expires_at) {
    krogerAppToken = await krogerToken({ grant_type: "client_credentials", scope: "product.compact" });
  }
  return krogerAppToken.access_token;
}

async function userToken() {
  if (!krogerUserToken) return null;
  if (Date.now() > krogerUserToken.expires_at) {
    krogerUserToken = await krogerToken({ grant_type: "refresh_token", refresh_token: krogerUserToken.refresh_token });
    saveUserToken();
  }
  return krogerUserToken.access_token;
}

app.get("/kroger/login", (_req, res) => {
  if (!KROGER_ID) return res.status(500).send("Add KROGER_CLIENT_ID and KROGER_CLIENT_SECRET to .env first.");
  const url = `${KROGER_API}/connect/oauth2/authorize?` + new URLSearchParams({
    response_type: "code",
    client_id: KROGER_ID,
    redirect_uri: KROGER_REDIRECT,
    scope: "cart.basic:write product.compact",
  });
  res.redirect(url);
});

app.get("/kroger/callback", async (req, res) => {
  try {
    krogerUserToken = await krogerToken({
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: KROGER_REDIRECT,
    });
    saveUserToken();
    res.send("<h2>✅ Kroger connected!</h2><p>You can close this tab and go back to Maya.</p>");
  } catch (err) {
    res.status(500).send("Kroger login failed: " + err.message);
  }
});

app.get("/api/kroger/status", async (_req, res) => {
  res.json({ configured: !!KROGER_ID, connected: !!krogerUserToken });
});

async function nearestQFC() {
  if (qfcLocation) return qfcLocation;
  const token = await appToken();
  const resp = await fetch(`${KROGER_API}/locations?` + new URLSearchParams({
    "filter.zipCode.near": "98121",
    "filter.chain": "QFC",
    "filter.limit": "1",
  }), { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Location lookup failed: ${await resp.text()}`);
  const data = await resp.json();
  if (!data.data?.length) throw new Error("No QFC found near 98121.");
  qfcLocation = data.data[0];
  return qfcLocation;
}

// Build shopping list from Maya's conversation, find products at QFC, add to cart
async function buildQfcOrder() {
  const token = await userToken();
  if (!token) { const e = new Error("Not connected to Kroger yet."); e.needLogin = true; throw e; }
  if (!history.length) throw new Error("Talk to Maya first so she can suggest foods!");

  // 1) Extract grocery items from conversation
  const chatResp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: 'Extract a grocery shopping list from this nutrition conversation. Return ONLY JSON: {"items":["simple product search term", ...]}. 4-10 concrete items the nutritionist recommended. Use short searchable terms like "organic blueberries" or "baby spinach".' },
        { role: "user", content: history.map(m => `${m.role}: ${m.content}`).join("\n") },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    }),
  });
  if (!chatResp.ok) throw new Error("Couldn't extract shopping list.");
  const terms = JSON.parse((await chatResp.json()).choices[0].message.content).items || [];
  if (!terms.length) throw new Error("No food suggestions found yet — chat with Maya more!");

  // 2) Find each product at the nearest QFC
  const loc = await nearestQFC();
  const appTok = await appToken();
  const found = [], missing = [];
  for (const term of terms) {
    const pResp = await fetch(`${KROGER_API}/products?` + new URLSearchParams({
      "filter.term": term,
      "filter.locationId": loc.locationId,
      "filter.limit": "1",
    }), { headers: { Authorization: `Bearer ${appTok}` } });
    const pData = pResp.ok ? await pResp.json() : { data: [] };
    const product = pData.data?.[0];
    if (product) {
      found.push({ term, upc: product.upc, description: product.description });
    } else {
      missing.push(term);
    }
  }
  if (!found.length) throw new Error("No products found at QFC for the list.");

  // 3) Add to the user's Kroger cart for pickup
  const cartResp = await fetch(`${KROGER_API}/cart/add`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items: found.map(f => ({ upc: f.upc, quantity: 1, modality: "PICKUP" })) }),
  });
  if (!cartResp.ok && cartResp.status !== 204) throw new Error(`Cart add failed: ${await cartResp.text()}`);

  return {
    ok: true,
    store: { name: loc.name, address: `${loc.address.addressLine1}, ${loc.address.city} ${loc.address.zipCode}` },
    added: found,
    missing,
    checkoutUrl: "https://www.qfc.com/cart",
  };
}

app.post("/api/kroger/order", async (_req, res) => {
  try {
    const order = await buildQfcOrder();
    res.json(order);
  } catch (err) {
    console.error(err);
    if (err.needLogin) return res.status(401).json({ error: err.message, needLogin: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🥗 Maya, your AI nutritionist, is ready at http://localhost:${PORT}`);
  if (!OPENAI_KEY) console.warn("⚠️  No OPENAI_API_KEY set — add it to .env before talking to Maya.");
});
