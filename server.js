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

app.listen(PORT, () => {
  console.log(`🥗 Maya, your AI nutritionist, is ready at http://localhost:${PORT}`);
  if (!OPENAI_KEY) console.warn("⚠️  No OPENAI_API_KEY set — add it to .env before talking to Maya.");
});
