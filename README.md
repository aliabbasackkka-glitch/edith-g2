# EDITH

A voice assistant for [Even Realities G2](https://www.evenrealities.com/) smart glasses.
Hold the temple or ring, ask anything, and the answer appears in front of you as it is
written. EDITH talks to the AI you choose, with your own key.

No glasses? EDITH also runs **in your browser** and **on your PC**, with the same AIs, memories
and saved chats:

- **Website:** [edith.starktech.workers.dev/web](https://edith.starktech.workers.dev/web) - pick an
  AI, paste your own key (it stays in your browser), then type or hold to talk.
- **PC app:** [`desktop/edith.py`](desktop/) - a desktop window with a live HUD that speaks its
  answers. Double-click `desktop/Run EDITH.bat` on Windows, or run `python desktop/edith.py`.

| | |
| --- | --- |
| ![Home screen](store/screenshots/2.0/1-home.png) | ![An answer](store/screenshots/2.0/2-answer.png) |
| ![Second opinion](store/screenshots/2.0/3-second-opinion.png) | ![Live translation](store/screenshots/2.0/4-live-translation.png) |
| ![Glasses menu](store/screenshots/2.0/5-menu.png) | ![Setup](store/screenshots/2.0/6-setup.png) |

## Features

- **Talk, read the answer.** Hold to talk like a walkie-talkie, or tap and speak. Answers
  stream onto the display, and EDITH keeps listening for a moment afterwards so you can
  carry on without touching anything.
- **Any AI, your key.** Groq (free and fast), Google Gemini (free), OpenAI, Anthropic Claude,
  xAI Grok, OpenRouter, DeepSeek, Mistral, or your own OpenAI-compatible server. Pick the
  model you want. **Connect OpenRouter** works without copying a key at all.
- **Voice for every AI.** If your AI can't hear (Claude, DeepSeek), add a second key just
  for speech-to-text.
- **Useful out of the box.** Web search, Wikipedia, weather, news headlines, a daily
  briefing, reading a link, and memories of what you tell it.
- **Saved chats.** Conversations are kept, named for you and searchable, and EDITH can
  recall what was said in earlier chats.
- **Subtitles and live translation.** Read what the person in front of you is saying,
  optionally in your own language.
- **Second opinion.** Ask another of your AIs the same question and compare.
- **Discreet mode** dims the display for meetings and dark rooms.
- **Calendars.** Add a private iCal link and EDITH knows what's next.
- **Accounts (optional).** Sign in with Google or email to keep your AIs, settings and chats
  on every phone.
- **Nine languages:** English, German, French, Spanish, Italian, Chinese, Japanese, Korean
  and Arabic.

## Website and PC app

Both talk to the same server as the glasses and send `surface: "web"` or `"desktop"` with each
question, so EDITH words its answers for a screen instead of the glasses.

- **Website** (`web.html`, `src/web/`): built with the rest of the site and served at `/web`.
  Every visitor brings their own key, which is checked by the server and then kept only in that
  browser's local storage. Hold the talk button or Space to speak; answers stream into the activity
  log. Optional: read answers aloud with the browser's voice.
- **PC app** (`desktop/edith.py`, one file, Python 3.9+): PyQt6 window with a system monitor, an
  animated HUD and a typewriter activity log. Hold **Space** to talk, **F4** turns voice replies on
  or off, **F11** goes fullscreen. Missing packages (PyQt6, sounddevice, numpy, requests) are
  installed on first run; spoken replies use [edge-tts](https://pypi.org/project/edge-tts/),
  installed the first time voice is used. Settings and keys live in `~/.edith/config.json`.
  It uses `https://edith.starktech.workers.dev` unless you pass `--server https://your-server`
  or set `EDITH_URL`. `--selftest` runs its checks without opening a window; `--reset` forgets
  this PC.

## How it works

```
G2 mic ──BLE──▶ Even app (runs EDITH) ──HTTPS──▶ EDITH server /api/chat ──▶ your AI provider
G2 display ◀──BLE── words as they arrive ◀──── NDJSON stream ◀──────────── streamed reply
```

1. **The phone app** (`src/`) runs inside the Even app and uses the
   [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk) to read the
   glasses' microphone and gestures and to draw on the display. Your AI keys are saved on
   your phone.
2. **A small server** (`server/`) runs on Cloudflare Workers. For each question it
   transcribes your voice, calls the AI you picked with the key your phone sent, runs tools
   such as web search, and streams the answer back. Memories, saved chats and accounts live
   in a Cloudflare D1 database.

Keys are sent with each request and used for that request only. They are never logged, and
only stored (encrypted) if you sign in to an account.

## Self-hosting

You need Node.js 22 or later, a free Cloudflare account, and G2 glasses with the Even app.

```bash
git clone https://github.com/edith-g2/edith-g2.git edith && cd edith
npm install
npx wrangler login
```

1. **Create the database.** Run `npx wrangler d1 create edith` and put the `database_id` it
   prints into `wrangler.jsonc`.
2. **Deploy.** `npm run deploy` builds the app and deploys the Worker. Wrangler prints your
   server's address, e.g. `https://edith.your-subdomain.workers.dev`.
3. **Point the app at it.** Copy `.env.example` to `.env.local` and set `EDITH_URL` to that
   address.
4. **Open it on your glasses.** `npm run qr` shows a QR code to scan with the Even app, or
   `npm run pack` builds `edith.ehpk` to upload on [Even Hub](https://hub.evenrealities.com).
   To publish your own build, change `package_id` and `author` in `app.json` first.

That's all EDITH needs. Everything below is optional.

### Optional: accounts

Sign-in uses Firebase Authentication (free). `npm run set-up-accounts` walks you through it
and saves these Worker secrets for you:

| Secret | What it is |
| --- | --- |
| `FIREBASE_WEB_CONFIG` | The Firebase web app's public config (JSON) |
| `ACCOUNT_SECRET` | 32+ random characters; the key that encrypts synced settings and AI keys. Never change it |
| `FIREBASE_SERVICE_ACCOUNT` | Lets "Delete account" remove the Firebase user too |
| `ACCOUNT_PROVIDERS` | Sign-in methods, default `google,email` |

Until they are set, the app simply hides the Account section.

### Optional: moderation

EDITH can check questions for harmful use (weapons, malware, threats and the like) with a
separate key of yours, never the user's. It never flags anyone in distress. Turn it on with
`npm run set-moderation-key`, which sets `MODERATION_PROVIDER`, `MODERATION_KEY` and
`MODERATION_MODEL` (plus `MODERATION_BASE` for your own OpenAI-compatible server).
Serious rules ban a phone at once; lighter ones warn, and the third warning bans. Bans and
warnings are rows in the database; to lift every ban and forget the warnings behind them:

```bash
npx wrangler d1 execute edith --remote --command "DELETE FROM kv WHERE key LIKE 'blocked/%' OR key LIKE 'flags/%'"
```

### Other settings

| Variable | Default | What it does |
| --- | --- | --- |
| `CORS_ORIGIN` | `*` | Which origins may call the API |
| `EDITH_SITE_URL` | none | Your server's address, sent to OpenRouter to name the app |
| `CHAT_MODELS`, `TRANSCRIBE_MODELS` | built in | The Gemini models "Auto" tries, in order |

Cloudflare's free Workers plan allows 10 ms of CPU per request. If requests start failing
with "exceeded CPU", the Workers Paid plan lifts that limit.

The same server also runs as a Netlify Function (`netlify/`, `npm run deploy:netlify`) with
Netlify Blobs for storage. The setup scripts, and the sign-in helper accounts need, are
Cloudflare-only.

## Development

```bash
npm run dev        # Vite dev server; /api is proxied to EDITH_URL
npm run simulate   # the Even Hub desktop simulator
npm run qr:dev     # open the dev server on your glasses (same Wi-Fi)
```

`npm run build` type-checks and builds the site. To add a language, copy
`src/i18n/en.ts`, translate it, and register it in `src/i18n/index.ts` and
`server/lib/languages.mjs`; TypeScript fails if a key is missing.

## Project layout

| Path | What's there |
| --- | --- |
| `src/edith.ts` | The app's state machine: gestures, listening, asking, AIs and voice, chats, accounts |
| `src/phone.ts`, `src/phone.css` | The phone screen: setup, conversation, chats and settings |
| `src/hud.ts`, `src/text.ts` | Drawing on the glasses, and text the G2 font can show |
| `src/recorder.ts`, `src/room.ts` | Microphone audio for questions, and for subtitles |
| `src/api.ts` | The client for the server |
| `src/i18n/` | Phone and glasses text in nine languages |
| `web.html`, `src/web/` | EDITH's website (served at `/web`) |
| `desktop/` | The PC app: `edith.py`, `Run EDITH.bat` and its README |
| `signin.html`, `connect.html` | Browser pages for signing in and connecting OpenRouter (served by your server, not packed) |
| `server/app.mjs` | Every `/api` route |
| `server/lib/providers/` | The AI providers: Gemini, Claude and OpenAI-compatible adapters |
| `server/lib/tools.mjs` | Tools: memory, recall, web search, Wikipedia, weather, news, briefing |
| `server/lib/accounts.mjs`, `connect.mjs` | Accounts, and Connect OpenRouter |
| `server/lib/moderation.mjs` | Optional moderation |
| `worker/`, `wrangler.jsonc` | The Cloudflare Worker: D1 storage, static files, Firebase sign-in helper |
| `netlify/`, `netlify.toml` | The same server on Netlify |
| `public/privacy.html` | The privacy policy the app links to |
| `scripts/` | Setup helpers, packaging, QR codes and the store icon |
| `app.json` | The Even Hub manifest |

## Privacy

EDITH has no ads, analytics or tracking. AI keys stay on the phone and travel with each
request; voice recordings are transcribed and dropped; subtitles are never stored. The
server keeps memories, saved chats and, for signed-in users, their encrypted settings, all
deletable from the app. `public/privacy.html` is the policy the app shows: if you run your
own server, update it with your own details.

## License

EDITH is released under the [MIT License](LICENSE).
