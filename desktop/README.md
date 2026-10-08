# E.D.I.T.H · PC edition

Talk to any AI from your computer. Type a message, or hold **SPACE** and speak. EDITH answers in the
activity log as it types, shows the answer under the HUD like the glasses do, and reads it aloud.

It is one Python file, `edith.py`, and it uses the same EDITH server as the glasses app
(`https://edith.starktech.workers.dev`). You bring a key for the AI you want: Gemini, Groq,
OpenAI, Claude, Grok, OpenRouter, DeepSeek, Mistral, or your own OpenAI-compatible server.

## Start it

- **Windows:** double-click `Run EDITH.bat`. It finds Python 3 and keeps the window open if
  something goes wrong, so you can read why.
- **Anywhere else:** `python3 edith.py`

The first start installs what EDITH needs with pip (PyQt6, requests, numpy, sounddevice, and psutil for
the SYS MONITOR bars). The first time voice replies are on, it also installs `edge-tts`, the voice, in
the background. If the voice can't be installed or reached, answers stay text only.

On first start the **INITIALISATION REQUIRED** panel opens:

1. Pick an AI. Gemini and Groq have free keys. **GET KEY ↗** opens the page where you make one.
2. Paste the key, press **CHECK**, and pick a model.
3. Press **INITIALISE SYSTEMS**.

You can also press **Connect OpenRouter**. It opens OpenRouter in your browser, you approve EDITH
there, and the key arrives without copying it.

Claude, DeepSeek and your own server can't turn speech into text. To talk to them, add a second key
under **VOICE KEY** from an AI that can (Groq's is free). You can type to them without one.

## Controls

| | |
|---|---|
| Hold **SPACE** (or the **HOLD TO TALK** strip) | talk; let go to send (up to 60 s) |
| **Enter** in the command box | send what you typed |
| **Esc** in the command box | leave the box, so SPACE talks again |
| **F4** | voice replies on/off (it also stops EDITH mid-sentence) |
| **F11** | fullscreen |
| **Settings / switch AI** | the setup panel: AI, key, model, answer length, language, voice, server |
| **ASK ABOUT A PHOTO** | attach a photo, a screenshot of your screen, or drop an image on the window; it goes with your next question (press ▸ on its own to have it described) |
| **SAVED CHATS** | search, open, delete, or start a new chat |

**Talk from any app** (in settings) lets you hold **Right Ctrl** anywhere on the PC to talk. It is off
until you turn it on.

## Your keys and data

- Settings and keys are saved on this PC only, in `~/.edith/config.json`
  (`C:\Users\<you>\.edith\config.json` on Windows, inside your own user folder; on macOS and Linux
  the file is readable only by you).
- Keys are sent only to the EDITH server, in the `X-AI-Key` / `X-Voice-Key` headers of a request, and
  never in a web address. EDITH never prints or logs them.
- The server keeps your memories and saved chats under a random id for this PC.
  **FORGET THIS PC** in settings deletes them from the server, then removes the keys saved here.
- Voice replies are made by Microsoft Edge's online text-to-speech (`edge-tts`): the answer text is
  sent there to be read aloud. Turn voice replies off (F4) if you'd rather it wasn't.

## Command line

```
python edith.py                     start EDITH
python edith.py --server URL        use another EDITH server for this run (https, or http on this PC)
python edith.py --reset             remove this PC's EDITH settings and keys
python edith.py --selftest          check EDITH without opening a window (exit code 0 = all good)
python edith.py --screenshot PNG    save a picture of the main window and exit
python edith.py --screenshot-setup PNG
```

The environment variable `EDITH_URL` also sets the server. `EDITH_NO_INSTALL=1` stops EDITH from
installing anything with pip.

## When something's wrong

- **"No microphone found"**: plug one in (or allow microphone access in Windows privacy settings) and
  press **HOLD TO TALK** to try again. Typing always works.
- **"... rejected this key"**: copy the key again from the provider's site, then **CHECK** it in settings.
- **"Can't reach EDITH's server"**: check your connection. EDITH tries again by itself on brief hiccups.
- On Linux, voice input needs PortAudio: `sudo apt install libportaudio2`.
