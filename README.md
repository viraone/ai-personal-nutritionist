# Maya 🌺 — AI Personal Nutritionist

Talk to Maya, a warm and encouraging AI nutritionist, using your voice.

## Live version (GitHub Pages)

Open the site, paste your own Gemini API key (free at https://aistudio.google.com/apikey — stored only in your browser), click 🎙️ and talk.
Maya listens, auto-detects when you stop speaking, and replies out loud in a sweet natural voice.

## Run locally (key stays in .env)

```bash
npm install
echo "OPENAI_API_KEY=sk-your-key" > .env
node server.js
```

Then open http://localhost:3000.

## Features

- 🎙️ One-click voice chat with auto silence detection
- 🗣️ Live site: Gemini 2.5 Flash hears your audio directly and replies, spoken with Gemini TTS ("Aoede")
- 🗣️ Local server: Whisper transcription + GPT-4o-mini + natural TTS voice ("nova")
- 🎛️ Microphone picker with live input level meter
- 💚 Warm, non-judgmental nutrition coaching persona
