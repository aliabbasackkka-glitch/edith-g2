#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
E.D.I.T.H  ·  PC EDITION
Talk to any AI from your computer: type a message, or hold SPACE and speak.

The desktop twin of EDITH's glasses app. It talks to EDITH's server
(https://edith.starktech.workers.dev by default), which answers with the AI you pick:
Gemini, Groq, OpenAI, Claude, Grok, OpenRouter, DeepSeek, Mistral or your own server.

Run:   python edith.py                 (Windows: double-click "Run EDITH.bat")
       python edith.py --selftest      checks itself without opening a window
       python edith.py --server URL    use another EDITH server for this run
       python edith.py --reset         forget this PC's settings and keys
       python edith.py --screenshot PNG | --screenshot-setup PNG

Keys stay on this PC in ~/.edith/config.json and are only ever sent to the EDITH server,
in the X-AI-Key / X-Voice-Key headers of a request. They are never printed or logged.
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import site
import subprocess
import sys

APP_VERSION = "1.0.0"
DEFAULT_SERVER = "https://edith.starktech.workers.dev"

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  STARTUP — PYTHON PACKAGES                                               ║
# ╚══════════════════════════════════════════════════════════════════════════╝
REQUIRED_PACKAGES = (("PyQt6", "PyQt6"), ("requests", "requests"), ("numpy", "numpy"), ("sounddevice", "sounddevice"))
HELPFUL_PACKAGES = (("psutil", "psutil"),)  # the SYS MONITOR bars; EDITH runs without it


def _refresh_import_paths():
    importlib.invalidate_caches()
    try:
        user_site = site.getusersitepackages()
        if user_site and os.path.isdir(user_site) and user_site not in sys.path:
            site.addsitedir(user_site)
    except Exception:
        pass


def _missing(pairs):
    out = []
    for module, package in pairs:
        try:
            if importlib.util.find_spec(module) is None:
                out.append(package)
        except Exception:
            out.append(package)
    return out


def pip_install(packages, quiet=False):
    """Installs packages for this Python: per user, or into the active virtualenv."""
    in_venv = sys.prefix != getattr(sys, "base_prefix", sys.prefix)
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check"]
    if not in_venv:
        cmd.append("--user")
    kwargs = {}
    if quiet:
        cmd.append("--quiet")
        kwargs.update(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        if sys.platform == "win32":
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    try:
        ok = subprocess.run(cmd + list(packages), timeout=900, **kwargs).returncode == 0
    except Exception:
        ok = False
    _refresh_import_paths()
    return ok


def ensure_packages():
    if os.environ.get("EDITH_NO_INSTALL") == "1":
        return
    missing, helpful = _missing(REQUIRED_PACKAGES), _missing(HELPFUL_PACKAGES)
    if not missing and not helpful:
        return
    if missing:
        print("E.D.I.T.H needs these Python packages, which aren't installed yet: " + ", ".join(missing))
    print("Installing " + ", ".join(missing + helpful) + " with pip (one time only)...", flush=True)
    if not pip_install(missing + helpful) and missing and helpful:
        pip_install(missing)
    still = _missing(REQUIRED_PACKAGES)
    hard = [p for p in still if p in ("PyQt6", "requests")]
    if hard:
        print("\nCouldn't install " + ", ".join(hard) + ". Install it yourself, then start EDITH again:\n"
              f'  "{sys.executable}" -m pip install --user ' + " ".join(still))
        sys.exit(1)
    if still:
        print("Note: " + ", ".join(still) + " couldn't be installed, so talking by voice is off. Typing works.")


ensure_packages()

import asyncio  # noqa: E402
import base64  # noqa: E402
import functools  # noqa: E402
import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import platform  # noqa: E402
import random  # noqa: E402
import re  # noqa: E402
import secrets  # noqa: E402
import shutil  # noqa: E402
import tempfile  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import wave  # noqa: E402
import webbrowser  # noqa: E402
from datetime import datetime  # noqa: E402
from pathlib import Path  # noqa: E402
from urllib.parse import quote, urlparse  # noqa: E402

import requests  # noqa: E402

try:
    import numpy as np
except Exception:  # voice input needs it; everything else works without
    np = None
try:
    import sounddevice as sd
except Exception:  # e.g. PortAudio missing on Linux: typing still works
    sd = None
try:
    import psutil
except Exception:
    psutil = None

from PyQt6.QtCore import (QBuffer, QByteArray, QEvent, QIODevice, QLocale, QObject, QPointF, QRectF, Qt,  # noqa: E402
                          QTimer, QUrl, pyqtSignal)
from PyQt6.QtGui import (QBrush, QColor, QFont, QFontMetrics, QGuiApplication, QImage, QKeySequence,  # noqa: E402
                         QPainter, QPen, QShortcut, QTextCharFormat, QTextCursor)
from PyQt6.QtWidgets import (QApplication, QComboBox, QDialog, QFileDialog, QFrame, QGridLayout,  # noqa: E402
                             QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QMainWindow,
                             QPushButton, QScrollArea, QSizePolicy, QTextEdit, QVBoxLayout, QWidget)

_OS = platform.system()

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  EDITH — CONSTANTS                                                       ║
# ╚══════════════════════════════════════════════════════════════════════════╝
REQUEST_TIMEOUT = 60          # seconds, like the phone app (src/api.ts)
RETRY_WAITS = (1.2, 2.6)      # retries for 429/502/503/504 before an answer starts
CHAT_TURNS = 20               # questions and answers sent along as context
CHAT_SHOWN = 60               # messages shown when a saved chat opens
CONTINUE_CHAT_S = 12 * 3600   # starting EDITH carries on with a chat this recent
MAX_IMAGE_B64 = 1_800_000     # the server refuses bigger photos
MAX_RECORD_S = 60
CONNECT_POLL_MS = 2500

LANGUAGES = [("en", "English"), ("de", "Deutsch"), ("fr", "Français"), ("es", "Español"), ("it", "Italiano"),
             ("zh", "中文"), ("ja", "日本語"), ("ko", "한국어"), ("ar", "العربية")]
LANGUAGE_IDS = [code for code, _ in LANGUAGES]
VOICES = [("en-GB-SoniaNeural", "Sonia · British English"), ("en-US-AvaNeural", "Ava · American English"),
          ("en-US-AndrewNeural", "Andrew · American English"), ("en-GB-RyanNeural", "Ryan · British English"),
          ("de-DE-KatjaNeural", "Katja · Deutsch"), ("fr-FR-DeniseNeural", "Denise · Français"),
          ("es-ES-ElviraNeural", "Elvira · Español"), ("it-IT-ElsaNeural", "Elsa · Italiano"),
          ("zh-CN-XiaoxiaoNeural", "Xiaoxiao · 中文"), ("ja-JP-NanamiNeural", "Nanami · 日本語"),
          ("ko-KR-SunHiNeural", "SunHi · 한국어"), ("ar-SA-ZariyahNeural", "Zariyah · العربية")]
VOICE_IDS = [v for v, _ in VOICES]
VOICE_FOR_LANGUAGE = {"en": "en-GB-SoniaNeural", "de": "de-DE-KatjaNeural", "fr": "fr-FR-DeniseNeural",
                      "es": "es-ES-ElviraNeural", "it": "it-IT-ElsaNeural", "zh": "zh-CN-XiaoxiaoNeural",
                      "ja": "ja-JP-NanamiNeural", "ko": "ko-KR-SunHiNeural", "ar": "ar-SA-ZariyahNeural"}
STYLES = [("short", "SHORT"), ("normal", "NORMAL"), ("detailed", "DETAILED")]
TOOL_CAPTIONS = {"weather_report": "◆ Checking the weather…", "web_search": "◆ Searching the web…",
                 "wikipedia": "◆ Looking it up…", "news_headlines": "◆ Reading the news…",
                 "daily_briefing": "◆ Preparing your briefing…", "recall_conversations": "◆ Remembering…"}
SHORT_PROVIDER = {"gemini": "Gemini", "groq": "Groq", "openai": "OpenAI", "anthropic": "Claude", "xai": "Grok",
                  "openrouter": "OpenRouter", "deepseek": "DeepSeek", "mistral": "Mistral", "custom": "Own server"}
KEY_HINT = {"gemini": "AIza…", "groq": "gsk_…", "openai": "sk-…", "anthropic": "sk-ant-…", "xai": "xai-…",
            "openrouter": "sk-or-…", "deepseek": "sk-…", "mistral": "Paste your Mistral key…", "custom": "Optional"}

# What GET /api/providers said when this was written, for a first start without a connection.
FALLBACK_PROVIDERS = [
    {"id": "gemini", "label": "Google Gemini", "note": "Free key", "keyUrl": "aistudio.google.com/apikey", "voice": True,
     "defaultModel": "auto", "models": [
         {"id": "auto", "name": "Auto: fastest available (recommended)"},
         {"id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash: smartest Flash"},
         {"id": "gemini-3.1-flash-lite", "name": "Gemini 3.1 Flash-Lite: quickest"},
         {"id": "gemini-3.1-pro-preview", "name": "Gemini 3.1 Pro: deep thinking, paid keys"}]},
    {"id": "groq", "label": "Groq", "note": "Free key, very fast", "keyUrl": "console.groq.com/keys", "voice": True,
     "defaultModel": "openai/gpt-oss-120b", "models": [
         {"id": "openai/gpt-oss-120b", "name": "GPT-OSS 120B: fast (recommended)"},
         {"id": "openai/gpt-oss-20b", "name": "GPT-OSS 20B: faster"},
         {"id": "llama-3.3-70b-versatile", "name": "Llama 3.3 70B"},
         {"id": "llama-3.1-8b-instant", "name": "Llama 3.1 8B: instant"}]},
    {"id": "openai", "label": "OpenAI (ChatGPT)", "note": "", "keyUrl": "platform.openai.com/api-keys", "voice": True,
     "defaultModel": "gpt-5.6-luna", "models": [
         {"id": "gpt-5.6-luna", "name": "GPT-5.6 Luna: fast (recommended)"},
         {"id": "gpt-5.6-terra", "name": "GPT-5.6 Terra: balanced"},
         {"id": "gpt-5.6-sol", "name": "GPT-5.6 Sol: flagship"},
         {"id": "gpt-6-astra", "name": "GPT-6 Astra: most capable, slower"}]},
    {"id": "anthropic", "label": "Anthropic (Claude)", "note": "Needs a second key for voice",
     "keyUrl": "console.anthropic.com/settings/keys", "voice": False, "defaultModel": "claude-sonnet-5", "models": [
         {"id": "claude-sonnet-5", "name": "Claude Sonnet 5: fast (recommended)"},
         {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5: fastest"},
         {"id": "claude-opus-5", "name": "Claude Opus 5: slower"},
         {"id": "claude-fable-5-1", "name": "Claude Fable 5.1: most capable, pricier"}]},
    {"id": "xai", "label": "xAI (Grok)", "note": "", "keyUrl": "console.x.ai", "voice": True, "defaultModel": "grok-4.6",
     "models": [{"id": "grok-4.6", "name": "Grok 4.6 (recommended)"}, {"id": "grok-4.5", "name": "Grok 4.5"},
                {"id": "grok-4.3", "name": "Grok 4.3: lower cost"}]},
    {"id": "openrouter", "label": "OpenRouter", "note": "Hundreds of models, one key", "keyUrl": "openrouter.ai/keys",
     "voice": True, "defaultModel": "google/gemini-3.8-flash", "models": [
         {"id": "google/gemini-3.8-flash", "name": "Gemini 3.8 Flash: fast (recommended)"},
         {"id": "anthropic/claude-sonnet-5", "name": "Claude Sonnet 5"},
         {"id": "openai/gpt-5.6-luna", "name": "GPT-5.6 Luna"}, {"id": "x-ai/grok-4.6", "name": "Grok 4.6"},
         {"id": "deepseek/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash: low cost"},
         {"id": "moonshotai/kimi-k3", "name": "Kimi K3"}]},
    {"id": "deepseek", "label": "DeepSeek", "note": "Needs a second key for voice",
     "keyUrl": "platform.deepseek.com/api_keys", "voice": False, "defaultModel": "deepseek-flash", "models": [
         {"id": "deepseek-flash", "name": "DeepSeek Flash: fast (recommended)"},
         {"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro: deeper reasoning"}]},
    {"id": "mistral", "label": "Mistral", "note": "", "keyUrl": "console.mistral.ai/api-keys", "voice": True,
     "defaultModel": "mistral-medium-latest", "models": [
         {"id": "mistral-medium-latest", "name": "Mistral Medium (recommended)"},
         {"id": "mistral-small-latest", "name": "Mistral Small: faster"},
         {"id": "mistral-large-latest", "name": "Mistral Large"}]},
    {"id": "custom", "label": "Your own server", "note": "Any OpenAI-compatible address", "keyUrl": "", "voice": False,
     "defaultModel": "", "models": [], "needsBase": True, "keyOptional": True},
]


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  EDITH — SMALL HELPERS                                                   ║
# ╚══════════════════════════════════════════════════════════════════════════╝
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
_DEVICE_RE = re.compile(r"^edith_[a-z0-9]{24}$")
_CHAT_RE = re.compile(r"^[A-Za-z0-9_-]{6,40}$")
_DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
           "November", "December")


def new_device_id():
    return "edith_" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(24))


def new_chat_id():
    return "c" + "".join(secrets.choice(_ID_ALPHABET) for _ in range(20))


def clean_chat_id(raw):
    raw = str(raw or "")
    return raw if _CHAT_RE.match(raw) else ""


def _zone_name():
    tz = os.environ.get("TZ", "").strip()
    if re.fullmatch(r"[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)+", tz):
        return tz
    try:
        from PyQt6.QtCore import QTimeZone
        zone = bytes(QTimeZone.systemTimeZoneId()).decode("ascii", "ignore").strip()
        if "/" in zone:
            return zone
    except Exception:
        pass
    if sys.platform != "win32":
        try:
            real = os.path.realpath("/etc/localtime")
            if "zoneinfo/" in real:
                return real.split("zoneinfo/", 1)[1]
        except Exception:
            pass
    offset = datetime.now().astimezone().utcoffset()
    if offset is None:
        return ""
    mins = int(offset.total_seconds() // 60)
    sign = "+" if mins >= 0 else "-"
    mins = abs(mins)
    return f"UTC{sign}{mins // 60:02d}:{mins % 60:02d}"


def local_time(now=None):
    """e.g. "Thursday, 8 October 2026 at 07:41 (Asia/Dubai)", like api.ts localTime()."""
    now = now or datetime.now()
    text = f"{_DAYS[now.weekday()]}, {now.day} {_MONTHS[now.month - 1]} {now.year} at {now.hour:02d}:{now.minute:02d}"
    zone = _zone_name()
    return f"{text} ({zone})" if zone else text


def guess_language():
    try:
        code = QLocale.system().name()[:2].lower()
        return code if code in LANGUAGE_IDS else "en"
    except Exception:
        return "en"


def normalise_server(url):
    """An EDITH server address, cleaned. https anywhere; plain http only on this computer."""
    url = str(url or "").strip().rstrip("/")
    if url.lower().endswith("/api"):
        url = url[:-4]
    parts = urlparse(url)
    host = (parts.hostname or "").lower()
    if parts.scheme == "https" and host:
        return url
    if parts.scheme == "http" and host in ("localhost", "127.0.0.1", "::1"):
        return url
    raise ValueError("The server address must start with https://")


def _is_https(url):
    try:
        parts = urlparse(str(url).strip())
        return parts.scheme == "https" and bool(parts.hostname)
    except Exception:
        return False


def safe_web_url(url):
    """Only https links (or http on this computer) are opened in the browser."""
    try:
        parts = urlparse(str(url))
        return parts.scheme == "https" or (parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1"))
    except Exception:
        return False


def key_page_url(key_url):
    key_url = str(key_url or "").strip()
    if not key_url:
        return ""
    if not key_url.startswith("https://"):
        if not re.fullmatch(r"[A-Za-z0-9.-]+\.[A-Za-z]{2,}(/[A-Za-z0-9._~/-]*)?", key_url):
            return ""
        key_url = "https://" + key_url
    return key_url


def model_label(models, model_id):
    """ "Gemini 3.8 Flash: smartest Flash" -> "Gemini 3.8 Flash"; unknown ids are shown as they are."""
    for m in models or []:
        if m.get("id") == model_id:
            name = str(m.get("label") or m.get("name") or model_id)
            return name.split(":")[0].strip() or model_id
    if model_id == "auto":
        return "Auto"
    return str(model_id or "")


def time_ago(ms):
    try:
        secs = max(0, time.time() - float(ms) / 1000)
    except Exception:
        return ""
    if secs < 90:
        return "just now"
    if secs < 3600:
        return f"{int(secs // 60)} min ago"
    if secs < 86400:
        return f"{int(secs // 3600)} h ago"
    if secs < 86400 * 14:
        return f"{int(secs // 86400)} d ago"
    return datetime.fromtimestamp(float(ms) / 1000).strftime("%d %b %Y")


def speech_text(text):
    """An answer as it should be read aloud: no links, markdown or list dashes."""
    t = re.sub(r"https?://\S+", "link", str(text or ""))
    t = re.sub(r"^\s*[-•]\s+", "", t, flags=re.M)
    t = re.sub(r"[*_#`>|~]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:1500]


def clean_history(raw):
    out = []
    for h in raw if isinstance(raw, list) else []:
        if not isinstance(h, dict):
            continue
        role = "model" if h.get("role") in ("model", "assistant") else "user"
        parts = h.get("parts")
        text = " ".join(str(p.get("text", "")) for p in parts if isinstance(p, dict)) if isinstance(parts, list) else ""
        text = text.strip()
        if text:
            out.append({"role": role, "parts": [{"text": text[:4000]}]})
    return out[-CHAT_TURNS:]


def clean_providers(raw):
    """GET /api/providers as EDITH uses it, with anything odd dropped."""
    out = []
    for p in raw if isinstance(raw, list) else []:
        if not isinstance(p, dict) or not re.fullmatch(r"[a-z0-9_-]{1,32}", str(p.get("id", ""))):
            continue
        models = []
        for m in p.get("models") if isinstance(p.get("models"), list) else []:
            if isinstance(m, dict) and m.get("id"):
                models.append({"id": str(m["id"])[:200], "name": str(m.get("name") or m["id"])[:200],
                               "label": str(m.get("label") or "")[:120]})
        out.append({"id": str(p["id"]), "label": str(p.get("label") or p["id"])[:60], "note": str(p.get("note") or "")[:120],
                    "keyUrl": str(p.get("keyUrl") or "")[:200], "voice": bool(p.get("voice")),
                    "defaultModel": str(p.get("defaultModel") or "")[:200], "models": models[:80],
                    "needsBase": bool(p.get("needsBase")), "keyOptional": bool(p.get("keyOptional"))})
    return out[:24]


def wrap_text(text, fm, width):
    """Word-wraps text to a pixel width with the given font metrics."""
    lines = []
    for para in str(text).split("\n"):
        line = ""
        for word in para.split(" "):
            cand = word if not line else line + " " + word
            if fm.horizontalAdvance(cand) <= width:
                line = cand
                continue
            if line:
                lines.append(line)
            while len(word) > 1 and fm.horizontalAdvance(word) > width:
                k = len(word)
                while k > 1 and fm.horizontalAdvance(word[:k]) > width:
                    k -= 1
                lines.append(word[:k])
                word = word[k:]
            line = word
        lines.append(line)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def wav_bytes(samples, rate=16000):
    """16-bit mono PCM samples as a WAV file."""
    pcm = samples.astype("<i2").tobytes() if hasattr(samples, "astype") else bytes(samples)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def shrink_image(img):
    """A photo as base64 JPEG, at most 1024 px on its longest side and small enough for the server."""
    if img is None or img.isNull():
        raise ValueError("That isn't a photo EDITH can read.")
    if max(img.width(), img.height()) > 1024:
        img = img.scaled(1024, 1024, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
    flat = QImage(img.size(), QImage.Format.Format_RGB32)
    flat.fill(QColor("#ffffff"))
    painter = QPainter(flat)
    painter.drawImage(0, 0, img)
    painter.end()
    for quality in (85, 75, 62, 50, 38):
        data = QByteArray()
        buf = QBuffer(data)
        buf.open(QIODevice.OpenModeFlag.WriteOnly)
        if not flat.save(buf, "JPEG", quality):
            raise ValueError("This PC can't make a JPEG.")
        buf.close()
        b64 = base64.b64encode(bytes(data)).decode("ascii")
        if len(b64) <= MAX_IMAGE_B64:
            return b64
    raise ValueError("That photo is too big to send.")


def voice_module_ready():
    try:
        return importlib.util.find_spec("edge_tts") is not None
    except Exception:
        return False


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  EDITH — SETTINGS (~/.edith/config.json)                                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class Config:
    """This PC's settings and keys. Saved with owner-only permissions; never printed."""

    def __init__(self, path):
        self.path = Path(path) if path else None
        self.data = self._defaults()
        if self.path:
            self.load()

    @staticmethod
    def default_path():
        return Path.home() / ".edith" / "config.json"

    @staticmethod
    def _defaults():
        lang = guess_language()
        return {"version": 1, "server": "", "device_id": new_device_id(), "chat_id": "", "chat_used": 0,
                "provider": "", "keys": {}, "models": {}, "voice_provider": "", "voice_key": "",
                "style": "normal", "language": lang, "voice_on": True,
                "voice_name": VOICE_FOR_LANGUAGE.get(lang, "en-GB-SoniaNeural"), "global_ptt": False}

    def load(self):
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except Exception:
            print("EDITH: the settings file couldn't be read, so EDITH starts fresh.")
            return
        if not isinstance(raw, dict):
            return
        d = self.data
        for k in ("server", "chat_id", "provider", "voice_provider", "voice_key", "voice_name"):
            if isinstance(raw.get(k), str):
                d[k] = raw[k]
        if isinstance(raw.get("device_id"), str) and _DEVICE_RE.match(raw["device_id"]):
            d["device_id"] = raw["device_id"]
        if isinstance(raw.get("chat_used"), (int, float)):
            d["chat_used"] = raw["chat_used"]
        if raw.get("style") in [s for s, _ in STYLES]:
            d["style"] = raw["style"]
        if raw.get("language") in LANGUAGE_IDS:
            d["language"] = raw["language"]
        for k in ("voice_on", "global_ptt"):
            if isinstance(raw.get(k), bool):
                d[k] = raw[k]
        if isinstance(raw.get("keys"), dict):
            d["keys"] = {str(p): {"key": str(v.get("key", "")), "model": str(v.get("model", "")),
                                  "base": str(v.get("base", "")), "label": str(v.get("label", p)),
                                  "voice": bool(v.get("voice"))}
                         for p, v in raw["keys"].items() if isinstance(v, dict)}
        if isinstance(raw.get("models"), dict):
            d["models"] = {str(p): [m for m in v if isinstance(m, dict) and m.get("id")]
                           for p, v in raw["models"].items() if isinstance(v, list)}
        if d["voice_name"] not in VOICE_IDS:
            d["voice_name"] = VOICE_FOR_LANGUAGE.get(d["language"], "en-GB-SoniaNeural")

    def save(self):
        if not self.path:
            return
        folder = self.path.parent
        folder.mkdir(parents=True, exist_ok=True)
        if os.name == "posix":
            try:
                os.chmod(folder, 0o700)
            except OSError:
                pass
        tmp = self.path.with_name(self.path.name + ".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def reset(self):
        if self.path:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
        self.data = self._defaults()

    # ── access ──
    def saved(self, provider):
        return self.data["keys"].get(provider) or {}

    def has_access(self):
        k = self.saved(self.data["provider"])
        return bool(self.data["provider"] and k and (k.get("key") or k.get("base")))

    def access(self):
        """Which AI answers and which one listens, as headers want them (like edith.ts access())."""
        d = self.data
        pid = d["provider"] if self.has_access() else ""
        k = self.saved(pid)
        a = {"provider": pid, "key": k.get("key", ""), "model": k.get("model", ""), "base": k.get("base", ""),
             "voice_provider": "", "voice_key": ""}
        if not pid:
            return a
        if k.get("voice") and k.get("key"):
            a["voice_provider"], a["voice_key"] = pid, k["key"]
        elif d["voice_provider"] and d["voice_key"]:
            a["voice_provider"], a["voice_key"] = d["voice_provider"], d["voice_key"]
        else:
            for other, v in d["keys"].items():
                if v.get("voice") and v.get("key"):
                    a["voice_provider"], a["voice_key"] = other, v["key"]
                    break
        return a


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  EDITH — SERVER CLIENT (the contract of src/api.ts)                      ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class ApiError(Exception):
    def __init__(self, kind, message, server_kind=""):
        super().__init__(message)
        self.kind, self.message, self.server_kind = kind, message, server_kind


def failure(status, data):
    """The server's error, as a kind EDITH words for the user (api.ts failure())."""
    data = data if isinstance(data, dict) else {}
    message = str(data.get("error") or f"Server error {status}")
    kind = str(data.get("kind") or "")
    if kind == "session":
        return ApiError("session", message, kind)
    if status == 401 or data.get("needsKey") or kind == "key":
        return ApiError("setup", message, kind)
    if data.get("needsVoiceKey") or kind == "voice":
        return ApiError("voice", message, kind)
    if kind == "quota" or re.search("quota", message, re.I):
        return ApiError("quota", message, kind)
    if kind == "unclear":
        return ApiError("unclear", message, kind)
    if kind == "model":
        return ApiError("model", message, kind)
    if kind in ("network", "timeout", "overloaded"):
        return ApiError("offline", message, kind)
    return ApiError("server", message, kind)


def to_reply(data, history):
    return {"reply": str(data.get("reply") or ""), "userText": str(data.get("userText") or ""),
            "history": data["history"] if isinstance(data.get("history"), list) else history,
            "toolsUsed": [str(t) for t in data.get("toolsUsed") or [] if isinstance(t, str)],
            "model": str(data.get("model") or ""), "chatId": str(data.get("chatId") or ""),
            # Owner features aren't part of the PC app: the token itself is never kept.
            "ownerToken": bool(data.get("ownerToken"))}


class NdjsonReader:
    """Splits a byte stream into JSON lines; each whole line is decoded as UTF-8 only once complete."""

    def __init__(self):
        self.buf = b""

    def feed(self, chunk):
        self.buf += chunk
        out = []
        while True:
            i = self.buf.find(b"\n")
            if i < 0:
                return out
            line, self.buf = self.buf[:i], self.buf[i + 1:]
            out.extend(self._parse(line))

    def end(self):
        line, self.buf = self.buf, b""
        return self._parse(line)

    @staticmethod
    def _parse(line):
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            return []
        try:
            value = json.loads(text)
        except ValueError:
            return []  # a malformed line is skipped rather than failing the answer
        return [value] if isinstance(value, dict) else []


class CancelToken:
    def __init__(self):
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._resp = None

    @property
    def cancelled(self):
        return self._event.is_set()

    def attach(self, resp):
        with self._lock:
            self._resp = resp
        if self.cancelled:
            self._close()

    def cancel(self):
        self._event.set()
        self._close()

    def wait(self, seconds):
        return self._event.wait(seconds)

    def _close(self):
        with self._lock:
            resp = self._resp
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass


def _reason(err):
    if isinstance(err, requests.exceptions.SSLError):
        return "secure connection failed"
    if isinstance(err, requests.exceptions.ConnectionError):
        return "no connection"
    return type(err).__name__


class EdithApi:
    """EDITH's backend over HTTPS. Keys travel only in the X-AI-Key / X-Voice-Key headers."""

    def __init__(self, server, cfg):
        self._server = server if callable(server) else (lambda: server)
        self.cfg = cfg

    @property
    def base(self):
        return self._server().rstrip("/") + "/api"

    def headers(self, extra=None):
        a = self.cfg.access()
        h = {"X-Device-Id": self.cfg.data["device_id"], "X-Edith-Language": self.cfg.data["language"],
             "User-Agent": f"EDITH-PC/{APP_VERSION}"}
        if a["provider"]:
            h["X-AI-Provider"] = a["provider"]
            if a["key"]:
                h["X-AI-Key"] = a["key"]
            if a["model"]:
                h["X-AI-Model"] = a["model"]
        if a["base"]:
            h["X-AI-Base"] = a["base"]
        if a["voice_provider"]:
            h["X-Voice-Provider"] = a["voice_provider"]
            if a["voice_key"]:
                h["X-Voice-Key"] = a["voice_key"]
        if extra:
            h.update(extra)
        return h

    def _request(self, method, path, headers=None, body=None, stream=False):
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        try:
            # No redirects: the key headers must never follow a request somewhere else.
            return requests.request(method, self.base + path, headers=hdrs, data=data, stream=stream,
                                    timeout=(10, REQUEST_TIMEOUT), allow_redirects=False)
        except requests.Timeout:
            raise ApiError("offline", "The server took too long to answer.") from None
        except requests.RequestException as err:
            raise ApiError("offline", f"Can't reach EDITH's server ({_reason(err)}).") from None

    @staticmethod
    def _json(resp):
        try:
            data = resp.json()
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def providers(self):
        h = {"X-Device-Id": self.cfg.data["device_id"], "X-Edith-Language": self.cfg.data["language"],
             "X-Edith-Can": "ownServer", "User-Agent": f"EDITH-PC/{APP_VERSION}"}
        r = self._request("GET", "/providers", headers=h)
        if r.status_code != 200:
            raise ApiError("server", f"Server error {r.status_code}")
        return clean_providers(self._json(r).get("providers"))

    def check_key(self, provider, key, base=""):
        h = {"X-AI-Provider": provider, "X-AI-Key": key, "User-Agent": f"EDITH-PC/{APP_VERSION}"}
        if base:
            h["X-AI-Base"] = base
        r = self._request("POST", "/check-key", headers=h)
        d = self._json(r)
        return {"ok": bool(d.get("ok")), "error": str(d.get("error") or f"Server error {r.status_code}"),
                "code": str(d.get("code") or ("" if d.get("ok") else "other")), "other": str(d.get("other") or ""),
                "freeTier": bool(d.get("freeTier")),
                "models": clean_providers([{"id": "x", "models": d.get("models")}])[0]["models"],
                "defaultModel": str(d.get("defaultModel") or "")}

    def chats(self, query=""):
        if query:
            r = self._request("POST", "/chats/search", headers=self.headers(), body={"q": query})
        else:
            r = self._request("GET", "/chats", headers=self.headers())
        d = self._json(r)
        if r.status_code != 200:
            raise ApiError("server", str(d.get("error") or f"Server error {r.status_code}"))
        return [c for c in d.get("chats") or [] if isinstance(c, dict) and clean_chat_id(c.get("id"))]

    def open_chat(self, chat_id):
        chat_id = clean_chat_id(chat_id)
        if not chat_id:
            return None
        r = self._request("GET", f"/chats/{quote(chat_id)}", headers=self.headers())
        if r.status_code == 404:
            return None
        d = self._json(r)
        if r.status_code != 200 or not isinstance(d.get("chat"), dict):
            raise ApiError("server", str(d.get("error") or f"Server error {r.status_code}"))
        chat = d["chat"]
        msgs = [m for m in chat.get("messages") or [] if isinstance(m, dict) and isinstance(m.get("content"), str)]
        return {"id": chat_id, "title": str(chat.get("title") or ""), "messages": msgs}

    def delete_chat(self, chat_id):
        chat_id = clean_chat_id(chat_id)
        if not chat_id:
            return
        r = self._request("DELETE", f"/chats/{quote(chat_id)}", headers=self.headers())
        if r.status_code >= 400:
            raise ApiError("server", f"Server error {r.status_code}")

    def forget(self):
        """Deletes this PC's memories, conversation, saved chats and lists from the server."""
        for path in ("/memory", "/history", "/chats", "/lists"):
            r = self._request("DELETE", path, headers=self.headers())
            if r.status_code >= 400:
                raise ApiError("server", f"Server error {r.status_code}")

    def connect_start(self):
        r = self._request("POST", "/connect/openrouter/start", headers=self.headers())
        d = self._json(r)
        if r.status_code != 200 or not d.get("id"):
            raise ApiError("server", str(d.get("error") or f"Server error {r.status_code}"), str(d.get("kind") or ""))
        return d

    def connect_poll(self, link):
        r = self._request("POST", "/connect/openrouter/poll", headers=self.headers(),
                          body={"id": link.get("id"), "pollToken": link.get("pollToken")})
        d = self._json(r)
        if r.status_code != 200:
            raise ApiError("server", str(d.get("error") or f"Server error {r.status_code}"))
        return d

    def _with_retry(self, send, cancel):
        for attempt in range(len(RETRY_WAITS) + 1):
            last = attempt == len(RETRY_WAITS)
            try:
                res = send()
                retryable = res.status_code in (429, 502, 503, 504) and "json" not in res.headers.get("content-type", "")
                if last or not retryable:
                    return res
                res.close()
            except ApiError as err:
                if last or err.kind == "cancelled":
                    raise
            if cancel is not None and cancel.wait(RETRY_WAITS[attempt]):
                raise ApiError("cancelled", "Cancelled.")
            if cancel is None:
                time.sleep(RETRY_WAITS[attempt])

    def chat(self, payload, history, options, on_event=None, cancel=None):
        """Sends a question and streams the answer; on_event hears transcript/delta/reset/tool/status."""
        body = {"localTime": local_time(), "history": clean_history(history)[-CHAT_TURNS:], **options, **payload}
        headers = self.headers({"Accept": "application/x-ndjson", "Accept-Encoding": "identity"})
        cancel = cancel or CancelToken()
        if cancel.cancelled:
            raise ApiError("cancelled", "Cancelled.")
        res = self._with_retry(lambda: self._request("POST", "/chat", headers=headers, body=body, stream=True), cancel)
        cancel.attach(res)
        if cancel.cancelled:
            raise ApiError("cancelled", "Cancelled.")
        if "ndjson" not in res.headers.get("content-type", ""):
            data = self._json(res)
            res.close()
            if res.status_code >= 400 or data.get("error"):
                raise failure(res.status_code, data)
            return to_reply(data, history)

        timed_out = {"v": False}

        def deadline():
            timed_out["v"] = True
            cancel._close()

        timer = threading.Timer(REQUEST_TIMEOUT, deadline)
        timer.daemon = True
        timer.start()
        done = None
        reader = NdjsonReader()
        try:
            def handle(events):
                nonlocal done
                for ev in events:
                    kind = ev.get("type")
                    if kind == "error":
                        raise failure(0, ev)
                    if kind == "done":
                        done = to_reply(ev, history)
                    elif kind in ("transcript", "delta", "reset", "tool", "status") and on_event:
                        on_event(ev)
            for chunk in res.iter_content(chunk_size=None):
                if cancel.cancelled and not timed_out["v"]:
                    raise ApiError("cancelled", "Cancelled.")
                if chunk:
                    handle(reader.feed(chunk))
            handle(reader.end())
        except ApiError:
            raise
        except Exception:
            if timed_out["v"]:
                raise ApiError("offline", "The server took too long to answer.") from None
            if cancel.cancelled:
                raise ApiError("cancelled", "Cancelled.") from None
            raise ApiError("offline", "The connection dropped before the answer finished.") from None
        finally:
            timer.cancel()
            try:
                res.close()
            except Exception:
                pass
        if timed_out["v"] and done is None:
            raise ApiError("offline", "The server took too long to answer.")
        if cancel.cancelled and done is None:
            raise ApiError("cancelled", "Cancelled.")
        if done is None:
            raise ApiError("offline", "The connection dropped before the answer finished.")
        return done


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  EDITH — MICROPHONE (hold to talk)                                       ║
# ╚══════════════════════════════════════════════════════════════════════════╝
def _resample(x, src, dst):
    if src == dst or len(x) == 0:
        return x
    n = int(round(len(x) * dst / src))
    t = np.linspace(0, len(x) - 1, n)
    return np.interp(t, np.arange(len(x)), x.astype(np.float32)).astype(np.int16)


class Recorder:
    """16 kHz mono 16-bit audio from the default microphone, up to a minute."""
    RATE = 16000

    def __init__(self):
        self._stream = None
        self._chunks = []
        self._rate = self.RATE
        self.started = 0.0

    @staticmethod
    def probe():
        if sd is None or np is None:
            return False, "sounddevice isn't installed"
        try:
            dev = sd.query_devices(kind="input")
            if not dev or int(dev.get("max_input_channels", 0)) < 1:
                return False, "no input device"
            return True, str(dev.get("name", ""))
        except Exception as err:
            return False, str(err)[:120]

    @property
    def active(self):
        return self._stream is not None

    def start(self):
        self._chunks = []

        def callback(indata, frames, time_info, status):
            self._chunks.append(indata.copy())
        try:
            stream = sd.InputStream(samplerate=self.RATE, channels=1, dtype="int16", callback=callback)
            self._rate = self.RATE
        except Exception:
            dev = sd.query_devices(kind="input")
            rate = int(dev.get("default_samplerate") or 44100)
            stream = sd.InputStream(samplerate=rate, channels=1, dtype="int16", callback=callback)
            self._rate = rate
        stream.start()
        self._stream = stream
        self.started = time.time()

    def stop(self):
        stream, self._stream = self._stream, None
        if stream is None:
            return None
        try:
            stream.stop()
            stream.close()
        except Exception:
            pass
        if not self._chunks:
            return np.zeros(0, dtype=np.int16)
        x = np.concatenate(self._chunks).reshape(-1).astype(np.int16)
        self._chunks = []
        return _resample(x, self._rate, self.RATE)[: self.RATE * MAX_RECORD_S]


class GlobalTalkKey(QObject):
    """Optional: hold Right Ctrl anywhere on the PC to talk (pynput). Off unless switched on."""
    pressed = pyqtSignal()
    released = pyqtSignal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._listener = None
        self._down = False

    @staticmethod
    def available():
        return importlib.util.find_spec("pynput") is not None

    def start(self):
        from pynput import keyboard

        def on_press(key):
            if key == keyboard.Key.ctrl_r and not self._down:
                self._down = True
                self.pressed.emit()

        def on_release(key):
            if key == keyboard.Key.ctrl_r and self._down:
                self._down = False
                self.released.emit()
        self._listener = keyboard.Listener(on_press=on_press, on_release=on_release)
        self._listener.daemon = True
        self._listener.start()

    def stop(self):
        if self._listener is not None:
            try:
                self._listener.stop()
            except Exception:
                pass
        self._listener = None
        self._down = False


# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — COLORS & HELPERS                                                   ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class C:
    BG=     "#050403"; PANEL=  "#0b0904"; PANEL2= "#110e06"
    BORDER= "#352b12"; BORDER_B="#6b5722"; BORDER_A="#4a3c16"
    PRI=    "#f5c542"; PRI_DIM="#9c7f2a"; PRI_GHO="#1d1606"; PRI_BRIGHT="#fef991"
    ACC=    "#ff8c1a"; ACC2=   "#fef991"
    GREEN=  "#3dff9a"; GREEN_D="#1f9e5c"
    RED=    "#ff3b4e"; MUTED_C="#ff3366"
    TEXT=   "#f1dfa0"; TEXT_DIM="#7d6a35"; TEXT_MED="#b89a4e"
    WHITE=  "#fff6d8"; DARK=   "#080603"; BAR_BG= "#171206"

def qcol(h,a=255):
    c=QColor(h); c.setAlpha(a); return c

def _label(txt,fs=9,bold=False,color=C.PRI,align=Qt.AlignmentFlag.AlignCenter):
    w=QLabel(txt); w.setTextFormat(Qt.TextFormat.PlainText); w.setAlignment(align)
    w.setFont(QFont("Courier New",fs,QFont.Weight.Bold if bold else QFont.Weight.Normal))
    w.setStyleSheet(f"color:{color};background:transparent;"); return w

def _sep():
    s=QFrame(); s.setFrameShape(QFrame.Shape.HLine); s.setStyleSheet(f"color:{C.BORDER};"); return s

def _field_style():
    return f"QLineEdit{{background:{C.DARK};color:{C.TEXT};border:1px solid {C.BORDER};border-radius:3px;padding:4px 8px;}}QLineEdit:focus{{border:1px solid {C.PRI};}}QLineEdit:disabled{{color:{C.TEXT_DIM};}}"

def _combo_style():
    return (f"QComboBox{{background:{C.DARK};color:{C.TEXT};border:1px solid {C.BORDER};border-radius:3px;padding:4px 8px;}}"
            f"QComboBox:focus,QComboBox:hover{{border:1px solid {C.BORDER_B};}}QComboBox::drop-down{{border:none;width:22px;}}"
            f"QComboBox QAbstractItemView{{background:{C.PANEL};color:{C.TEXT};border:1px solid {C.BORDER_B};selection-background-color:{C.PRI_GHO};selection-color:{C.PRI};outline:0;}}")

def _line_button_style():
    return f"QPushButton{{background:transparent;color:{C.PRI};border:1px solid {C.PRI_DIM};border-radius:3px;}}QPushButton:hover{{background:{C.PRI_GHO};border:1px solid {C.PRI};}}QPushButton:disabled{{color:{C.TEXT_DIM};border:1px solid {C.BORDER};}}"

def _dashed_style():
    return f"QPushButton{{background:{C.DARK};color:{C.TEXT_MED};border:2px dashed {C.BORDER};border-radius:6px;}}QPushButton:hover{{border-color:{C.PRI};color:{C.PRI};}}"

def _choice_style(selected,fg=C.PRI):
    if selected: return f"QPushButton{{background:{fg};color:{C.BG};border:none;border-radius:3px;font-weight:bold;}}"
    return f"QPushButton{{background:{C.DARK};color:{C.TEXT_DIM};border:1px solid {C.BORDER};border-radius:3px;}}QPushButton:hover{{color:{C.TEXT};border:1px solid {C.BORDER_B};}}"

def _scroll_style():
    return (f"QScrollBar:vertical{{background:{C.BG};width:8px;border:none;}}QScrollBar::handle:vertical{{background:{C.BORDER_B};border-radius:4px;min-height:20px;}}"
            "QScrollBar::add-line:vertical,QScrollBar::sub-line:vertical{height:0;}QScrollBar::add-page:vertical,QScrollBar::sub-page:vertical{background:none;}")

def _dialog_button(text,danger=False):
    b=QPushButton(text); b.setFixedHeight(38); b.setFont(QFont("Courier New",10,QFont.Weight.Bold))
    b.setCursor(Qt.CursorShape.PointingHandCursor)
    if danger: b.setStyleSheet(f"QPushButton{{background:#140006;color:{C.RED};border:1px solid {C.RED};border-radius:6px;padding:0 14px;}}QPushButton:hover{{background:{C.RED};color:{C.BG};}}")
    else: b.setStyleSheet(f"QPushButton{{background:{C.PRI_GHO};color:{C.PRI};border:1px solid {C.PRI_DIM};border-radius:6px;padding:0 14px;}}QPushButton:hover{{background:{C.PRI};color:{C.BG};}}")
    return b

def confirm_dialog(parent,title,text,yes="CONFIRM",danger=False):
    """A yes/no question in EDITH's dialog style."""
    dlg=QDialog(parent); dlg.setWindowTitle("E.D.I.T.H"); dlg.setFixedWidth(400)
    dlg.setStyleSheet(f"background:{C.BG};color:{C.WHITE};")
    vl=QVBoxLayout(dlg); vl.setSpacing(10); vl.setContentsMargins(24,18,24,18)
    t=_label(title,10,True,C.RED if danger else C.GREEN); vl.addWidget(t)
    b=_label(text,8,False,C.TEXT_MED); b.setWordWrap(True); vl.addWidget(b)
    row=QHBoxLayout(); row.setSpacing(6)
    no=_dialog_button("CANCEL"); ok=_dialog_button(yes,danger)
    no.clicked.connect(dlg.reject); ok.clicked.connect(dlg.accept)
    row.addWidget(no); row.addWidget(ok); vl.addLayout(row)
    return dlg.exec()==QDialog.DialogCode.Accepted

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — SYSTEM METRICS                                                     ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class _SysMetrics:
    def __init__(self):
        self.cpu=self.mem=self.net=0.0; self.gpu=self.tmp=-1.0; self.ok=psutil is not None
        self._lock=threading.Lock(); self._nvsmi=shutil.which("nvidia-smi")
        self._last_net=psutil.net_io_counters() if psutil else None
        self._last_t=time.time()
        if psutil: threading.Thread(target=self._loop,daemon=True).start()
    def _loop(self):
        while True:
            try: self._update()
            except Exception: pass
            time.sleep(1.5)
    def _update(self):
        cpu=psutil.cpu_percent(interval=None); mem=psutil.virtual_memory().percent
        nc=psutil.net_io_counters(); now=time.time(); dt=now-self._last_t
        net=((nc.bytes_sent-self._last_net.bytes_sent)+(nc.bytes_recv-self._last_net.bytes_recv))/dt/1048576 if dt>0 else 0
        self._last_net=nc; self._last_t=now
        gpu=-1.0
        if self._nvsmi:
            try:
                r=subprocess.run([self._nvsmi,"--query-gpu=utilization.gpu","--format=csv,noheader,nounits"],capture_output=True,text=True,timeout=2,
                                 creationflags=0x08000000 if sys.platform=="win32" else 0)
                if r.returncode==0:
                    vals=[float(v.strip()) for v in r.stdout.strip().split("\n") if v.strip()]
                    if vals: gpu=sum(vals)/len(vals)
            except Exception: self._nvsmi=None
        tmp=-1.0
        try:
            ts=psutil.sensors_temperatures()
            for name in ["coretemp","k10temp","cpu_thermal","acpitz"]:
                if name in ts and ts[name]: tmp=ts[name][0].current; break
        except Exception: pass
        with self._lock: self.cpu=cpu; self.mem=mem; self.net=net; self.gpu=gpu; self.tmp=tmp
    def snapshot(self):
        with self._lock: return {"cpu":self.cpu,"mem":self.mem,"net":self.net,"gpu":self.gpu,"tmp":self.tmp}

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — HUD CANVAS                                                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class HudCanvas(QWidget):
    def __init__(self,parent=None):
        super().__init__(parent)
        self.setAttribute(Qt.WidgetAttribute.WA_OpaquePaintEvent)
        self.setMinimumSize(300,300); self.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
        self.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Expanding)
        self.muted=False; self.speaking=False; self.state="INITIALISING"
        self._tick=0; self._scale=1.0; self._tgt_scale=1.0
        self._halo=55.0; self._tgt_halo=55.0; self._last_t=time.time()
        self._scan=0.0; self._scan2=180.0; self._rings=[0.0,120.0,240.0]
        self._pulses=[0.0,50.0,100.0]; self._blink=True; self._blink_tick=0
        self._particles=[]; self._face_px=None
        # The live answer under the state text, like the glasses display.
        self._caption=""; self._cap_until=float("inf"); self._cap_alpha=0.0; self._cap_h=0.0; self._cap_h_tgt=0.0
        self._tmr=QTimer(self); self._tmr.timeout.connect(self._step); self._tmr.start(16)

    def set_caption(self,text,hold=None):
        self._caption=" ".join(str(text or "").split())
        self._cap_until=time.time()+hold if hold else float("inf")

    def fade_caption(self,after):
        if self._caption: self._cap_until=time.time()+after

    def _step(self):
        self._tick+=1; now=time.time()
        if now-self._last_t>(0.12 if self.speaking else 0.5):
            if self.speaking: self._tgt_scale=random.uniform(1.06,1.14); self._tgt_halo=random.uniform(145,190)
            elif self.muted:  self._tgt_scale=random.uniform(0.998,1.002); self._tgt_halo=random.uniform(15,28)
            else:             self._tgt_scale=random.uniform(1.001,1.008); self._tgt_halo=random.uniform(48,68)
            self._last_t=now
        sp=0.38 if self.speaking else 0.15
        self._scale+=(self._tgt_scale-self._scale)*sp; self._halo+=(self._tgt_halo-self._halo)*sp
        speeds=[1.3,-0.9,2.0] if self.speaking else [0.55,-0.35,0.9]
        for i,spd in enumerate(speeds): self._rings[i]=(self._rings[i]+spd)%360
        self._scan=(self._scan+(3.0 if self.speaking else 1.3))%360
        self._scan2=(self._scan2+(-2.0 if self.speaking else -0.75))%360
        fw=min(self.width(),self.height()); lim=fw*0.74; spd=4.2 if self.speaking else 2.0
        self._pulses=[r+spd for r in self._pulses if r+spd<lim]
        if len(self._pulses)<3 and random.random()<(0.07 if self.speaking else 0.025): self._pulses.append(0.0)
        if self.speaking and random.random()<0.28:
            cx,cy=self.width()/2,self.height()/2; ang=random.uniform(0,2*math.pi); rs=fw*0.28
            self._particles.append([cx+math.cos(ang)*rs,cy+math.sin(ang)*rs,math.cos(ang)*random.uniform(0.9,2.4),math.sin(ang)*random.uniform(0.9,2.4)-0.4,1.0])
        self._particles=[[p[0]+p[2],p[1]+p[3],p[2]*0.97,p[3]*0.97,p[4]-0.028] for p in self._particles if p[4]>0]
        self._blink_tick+=1
        if self._blink_tick>=38: self._blink=not self._blink; self._blink_tick=0
        tgt=1.0 if self._caption and now<self._cap_until else 0.0
        self._cap_alpha+=(tgt-self._cap_alpha)*0.10
        if tgt==0.0 and self._cap_alpha<0.02: self._cap_alpha=0.0; self._caption=""; self._cap_h_tgt=0.0
        self._cap_h+=(self._cap_h_tgt-self._cap_h)*0.2
        self.update()

    def paintEvent(self,_):
        p=QPainter(self); p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.fillRect(self.rect(),qcol(C.BG))
        W,H=self.width(),self.height(); cx,cy=W/2,H/2; fw=min(W,H)
        p.setPen(QPen(qcol(C.PRI_GHO),1))
        for x in range(0,W,48):
            for y in range(0,H,48): p.drawPoint(x,y)
        r_face=fw*0.31
        for i in range(10):
            r=r_face*(1.8-i*0.08); frc=1.0-i/10
            a=max(0,min(255,int(self._halo*0.085*frc)))
            col=qcol(C.MUTED_C if self.muted else C.PRI,a)
            p.setPen(QPen(col,1.5)); p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawEllipse(QRectF(cx-r,cy-r,r*2,r*2))
        for pr in self._pulses:
            a=max(0,int(230*(1.0-pr/(fw*0.74))))
            p.setPen(QPen(qcol(C.MUTED_C if self.muted else C.PRI,a),1.5))
            p.setBrush(Qt.BrushStyle.NoBrush); p.drawEllipse(QRectF(cx-pr,cy-pr,pr*2,pr*2))
        for idx,(r_frac,w_r,arc_l,gap) in enumerate([(0.48,3,115,78),(0.40,2,78,55),(0.32,1,56,40)]):
            ring_r=fw*r_frac; base=self._rings[idx]
            a_val=max(0,min(255,int(self._halo*(1.0-idx*0.18))))
            col=qcol(C.MUTED_C if self.muted else C.PRI,a_val)
            p.setPen(QPen(col,w_r)); p.setBrush(Qt.BrushStyle.NoBrush)
            angle=base; rect=QRectF(cx-ring_r,cy-ring_r,ring_r*2,ring_r*2)
            while angle<base+360: p.drawArc(rect,int(angle*16),int(arc_l*16)); angle+=arc_l+gap
        sr=fw*0.50; sa=min(255,int(self._halo*1.5)); ex=75 if self.speaking else 44
        p.setPen(QPen(qcol(C.MUTED_C if self.muted else C.PRI,sa),2.5))
        p.setBrush(Qt.BrushStyle.NoBrush)
        srect=QRectF(cx-sr,cy-sr,sr*2,sr*2)
        p.drawArc(srect,int(self._scan*16),int(ex*16))
        p.setPen(QPen(qcol(C.ACC,sa//2),1.5)); p.drawArc(srect,int(self._scan2*16),int(ex*16))
        t_out,t_in=fw*0.497,fw*0.474
        p.setPen(QPen(qcol(C.PRI,140),1))
        for deg in range(0,360,10):
            rad=math.radians(deg); inn=t_in if deg%30==0 else t_in+6
            p.drawLine(QPointF(cx+t_out*math.cos(rad),cy-t_out*math.sin(rad)),QPointF(cx+inn*math.cos(rad),cy-inn*math.sin(rad)))
        ch_r,gap_h=fw*0.51,fw*0.16
        p.setPen(QPen(qcol(C.PRI,int(self._halo*0.5)),1))
        p.drawLine(QPointF(cx-ch_r,cy),QPointF(cx-gap_h,cy)); p.drawLine(QPointF(cx+gap_h,cy),QPointF(cx+ch_r,cy))
        p.drawLine(QPointF(cx,cy-ch_r),QPointF(cx,cy-gap_h)); p.drawLine(QPointF(cx,cy+gap_h),QPointF(cx,cy+ch_r))
        bl=24; bc=qcol(C.PRI,210)
        hl,hr,ht,hb=cx-fw//2,cx+fw//2,cy-fw//2,cy+fw//2
        p.setPen(QPen(bc,2))
        for bx,by,dx,dy in [(hl,ht,1,1),(hr,ht,-1,1),(hl,hb,1,-1),(hr,hb,-1,-1)]:
            p.drawLine(QPointF(bx,by),QPointF(bx+dx*bl,by)); p.drawLine(QPointF(bx,by),QPointF(bx,by+dy*bl))
        if self._face_px:
            fsz=int(fw*0.62*self._scale)
            scaled=self._face_px.scaled(fsz,fsz,Qt.AspectRatioMode.KeepAspectRatio,Qt.TransformationMode.SmoothTransformation)
            p.drawPixmap(int(cx-fsz/2),int(cy-fsz/2),scaled)
        else:
            orb_r=int(fw*0.27*self._scale)
            oc=(200,0,50) if self.muted else (84,62,10)
            for i in range(8,0,-1):
                r2=int(orb_r*i/8); frc=i/8
                a=max(0,min(255,int(self._halo*1.1*frc)))
                p.setBrush(QBrush(QColor(int(oc[0]*frc),int(oc[1]*frc),int(oc[2]*frc),a))); p.setPen(Qt.PenStyle.NoPen)
                p.drawEllipse(QRectF(cx-r2,cy-r2,r2*2,r2*2))
            p.setPen(QPen(qcol(C.PRI,min(255,int(self._halo*2))),1))
            p.setFont(QFont("Courier New",13,QFont.Weight.Bold))
            p.drawText(QRectF(cx-80,cy-14,160,28),Qt.AlignmentFlag.AlignCenter,"E.D.I.T.H")
        for pt in self._particles:
            a=max(0,min(255,int(pt[4]*255))); p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QBrush(qcol(C.PRI,a))); p.drawEllipse(QPointF(pt[0],pt[1]),2.5,2.5)
        # Caption: the live answer, 2-3 lines under the state text (the state text rises to make room).
        cap_lines=[]; cf=QFont("Courier New",10); fm=QFontMetrics(cf); lh=fm.height()+2
        if self._caption and self._cap_alpha>0.01:
            cap_lines=wrap_text(self._caption,fm,int(min(W-60,fw*0.86)))[-3:]
            self._cap_h_tgt=float(len(cap_lines)*lh+10)
        else: self._cap_h_tgt=0.0
        sy=cy+fw*0.40-self._cap_h
        if self.muted:             txt,col="⊘  MUTED",          qcol(C.MUTED_C)
        elif self.speaking:        txt,col=("●  ANSWERING" if self.state=="ANSWERING" else "●  SPEAKING"),qcol(C.ACC)
        elif self.state=="THINKING":sym="◈" if self._blink else "◇"; txt,col=f"{sym}  THINKING",  qcol(C.ACC2)
        elif self.state=="LISTENING":sym="●" if self._blink else "○"; txt,col=f"{sym}  LISTENING", qcol(C.GREEN)
        else:                      sym="●" if self._blink else "○"; txt,col=f"{sym}  {self.state}",qcol(C.PRI)
        p.setPen(QPen(col,1)); p.setFont(QFont("Courier New",11,QFont.Weight.Bold))
        p.drawText(QRectF(0,sy,W,26),Qt.AlignmentFlag.AlignCenter,txt)
        if cap_lines:
            a=self._cap_alpha; top=sy+28
            pw=max(fm.horizontalAdvance(l) for l in cap_lines)+30; ph=len(cap_lines)*lh+8
            p.setPen(Qt.PenStyle.NoPen); p.setBrush(QBrush(qcol(C.BG,int(175*a))))
            p.drawRoundedRect(QRectF(cx-pw/2,top-2,pw,ph),4,4)
            p.setPen(QPen(qcol(C.PRI_DIM,int(150*a)),1))
            for ex_ in (cx-pw/2,cx+pw/2):
                p.drawLine(QPointF(ex_,top+1),QPointF(ex_,top+ph-5))
            p.setFont(cf); p.setPen(QPen(qcol(C.PRI,int(235*a)),1))
            for i,line in enumerate(cap_lines):
                p.drawText(QRectF(0,top+2+i*lh,W,lh),Qt.AlignmentFlag.AlignHCenter|Qt.AlignmentFlag.AlignVCenter,line)
        wy=sy+30+self._cap_h; N,bw=36,8; wx0=(W-N*bw)/2
        for i in range(N):
            if self.muted:           hgt,cl=2,qcol(C.MUTED_C)
            elif self.speaking:      hgt=random.randint(3,20); cl=qcol(C.PRI) if hgt>12 else qcol(C.PRI_DIM)
            else:                    hgt=int(3+2*math.sin(self._tick*0.09+i*0.6)); cl=qcol(C.BORDER_B)
            p.fillRect(QRectF(wx0+i*bw,wy+20-hgt,bw-1,hgt),cl)

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — METRIC BAR                                                         ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class MetricBar(QWidget):
    def __init__(self,label,color=C.PRI,parent=None):
        super().__init__(parent); self._label=label; self._color=color
        self._value=0.0; self._text="--"; self.setFixedHeight(38); self.setMinimumWidth(80)
    def set_value(self,pct,text):
        self._value=max(0.0,min(100.0,pct)); self._text=text; self.update()
    def paintEvent(self,_):
        p=QPainter(self); p.setRenderHint(QPainter.RenderHint.Antialiasing)
        W,H=self.width(),self.height()
        p.setBrush(QBrush(qcol(C.PANEL2))); p.setPen(QPen(qcol(C.BORDER_A),1))
        p.drawRoundedRect(QRectF(1,1,W-2,H-2),4,4)
        bar_h=4; bar_y=H-bar_h-5; bar_w=W-12; bar_x=6; fill_w=int(bar_w*self._value/100)
        p.setBrush(QBrush(qcol(C.BAR_BG))); p.setPen(Qt.PenStyle.NoPen)
        p.drawRoundedRect(QRectF(bar_x,bar_y,bar_w,bar_h),2,2)
        bar_col=qcol(C.RED) if self._value>85 else qcol(C.ACC) if self._value>65 else qcol(self._color)
        if fill_w>0: p.setBrush(QBrush(bar_col)); p.drawRoundedRect(QRectF(bar_x,bar_y,fill_w,bar_h),2,2)
        p.setFont(QFont("Courier New",7,QFont.Weight.Bold)); p.setPen(QPen(qcol(C.TEXT_DIM),1))
        p.drawText(QRectF(8,5,50,14),Qt.AlignmentFlag.AlignLeft|Qt.AlignmentFlag.AlignVCenter,self._label)
        p.setFont(QFont("Courier New",9,QFont.Weight.Bold))
        p.setPen(QPen(bar_col if self._text not in ("--","N/A") else qcol(C.TEXT_DIM),1))
        p.drawText(QRectF(0,4,W-6,16),Qt.AlignmentFlag.AlignRight|Qt.AlignmentFlag.AlignVCenter,self._text)

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — LOG WIDGET (typewriter, with live entries for streamed answers)    ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class _LogEntry:
    __slots__=("log","text","tag","live","done","prefix")
    def __init__(self,log,text,tag,live):
        self.log=log; self.text=text; self.tag=tag; self.live=live; self.done=not live; self.prefix=len(text) if live else 0
    def append(self,s):
        if self.done or not s: return
        self.text+=s; self.log._kick()
    def reset(self): self.log._reset(self)
    def finish(self,final=None): self.log._finish(self,final)
    def discard(self): self.log._discard(self)
    def body(self): return self.text[self.prefix:]

class LogWidget(QTextEdit):
    _sig=pyqtSignal(str)
    def __init__(self,parent=None):
        super().__init__(parent); self.setReadOnly(True); self.setFont(QFont("Courier New",9))
        self.setStyleSheet(f"QTextEdit{{background:{C.PANEL};color:{C.TEXT};border:1px solid {C.BORDER};border-radius:4px;padding:6px;}}QScrollBar:vertical{{background:{C.BG};width:8px;border:none;}}QScrollBar::handle:vertical{{background:{C.BORDER_B};border-radius:4px;min-height:20px;}}")
        self.setUndoRedoEnabled(False)
        self._queue=[]; self._typing=False; self._cur=None; self._pos=0; self._start=0
        self._tmr=QTimer(self); self._tmr.timeout.connect(self._step); self._sig.connect(self._enqueue)
    def append_log(self,text): self._sig.emit(text)
    @staticmethod
    def _tag(text):
        tl=text.lower()
        if   tl.startswith("you:"):   return "you"
        elif tl.startswith("edith:"): return "ai"
        elif tl.startswith("err"):    return "err"
        return "sys"
    @staticmethod
    def _colour(tag): return {"you":qcol(C.WHITE),"ai":qcol(C.PRI),"err":qcol(C.RED),"sys":qcol(C.ACC2)}.get(tag,qcol(C.TEXT))
    def _enqueue(self,text):
        self._queue.append(_LogEntry(self,text,self._tag(text),False))
        if not self._typing: self._next()
    def begin_live(self,prefix):
        """A line typed as its text arrives: append(), reset(), finish() or discard() it."""
        e=_LogEntry(self,prefix,self._tag(prefix),True); self._queue.append(e)
        if not self._typing: self._next()
        return e
    def _end_pos(self):
        c=QTextCursor(self.document()); c.movePosition(QTextCursor.MoveOperation.End); return c.position()
    def _next(self):
        if not self._queue: self._typing=False; self._cur=None; return
        self._typing=True; self._cur=self._queue.pop(0); self._pos=0; self._start=self._end_pos()
        self._tmr.start(6)
    def _insert(self,s,tag):
        sb=self.verticalScrollBar(); stick=sb.value()>=sb.maximum()-4
        c=QTextCursor(self.document()); c.movePosition(QTextCursor.MoveOperation.End)
        fmt=QTextCharFormat(); fmt.setForeground(QBrush(self._colour(tag)))
        c.insertText(s,fmt)  # plain text only, never HTML
        if stick: sb.setValue(sb.maximum())
    def _step(self):
        e=self._cur
        if e is None: self._tmr.stop(); return
        if self._pos<len(e.text):
            backlog=len(e.text)-self._pos; n=1 if backlog<60 else 3 if backlog<240 else 9
            self._insert(e.text[self._pos:self._pos+n],e.tag); self._pos+=n
        elif not e.done:
            self._tmr.stop()  # waits for more of a live line; _kick() starts it again
        else:
            self._tmr.stop(); self._insert("\n",e.tag); self._cur=None
            QTimer.singleShot(20,self._next)
    def _kick(self):
        if self._cur is not None and not self._tmr.isActive(): self._tmr.start(6)
    @staticmethod
    def _units(s): return len(s.encode("utf-16-le"))//2
    def _delete_from(self,pos):
        c=QTextCursor(self.document()); c.setPosition(min(pos,self._end_pos()))
        c.movePosition(QTextCursor.MoveOperation.End,QTextCursor.MoveMode.KeepAnchor); c.removeSelectedText()
    def _reset(self,e):
        if e.done: return
        if e is self._cur and self._pos>e.prefix:
            self._delete_from(self._start+self._units(e.text[:e.prefix])); self._pos=e.prefix
        e.text=e.text[:e.prefix]
    def _finish(self,e,final=None):
        if e.done: return
        if final is not None:
            new=e.text[:e.prefix]+final
            if e is self._cur and not new.startswith(e.text[:self._pos]):
                keep=min(self._pos,e.prefix); self._delete_from(self._start+self._units(e.text[:keep])); self._pos=keep
            e.text=new
        e.done=True; self._kick()
    def _discard(self,e):
        e.done=True
        if e in self._queue: self._queue.remove(e); return
        if e is self._cur:
            self._tmr.stop(); self._delete_from(self._start); self._cur=None
            QTimer.singleShot(0,self._next)
    def clear_log(self):
        self._tmr.stop()
        for e in self._queue: e.done=True
        if self._cur is not None: self._cur.done=True
        self._queue=[]; self._cur=None; self._typing=False; self.clear()
    def append_now(self,lines):
        """Many lines at once, without the typewriter (e.g. a saved chat being opened)."""
        if self._typing:
            for t in lines: self._enqueue(t)
            return
        for t in lines: self._insert(t+"\n",self._tag(t))
        self.verticalScrollBar().setValue(self.verticalScrollBar().maximum())

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — SETUP OVERLAY (AI link + settings)                                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class SetupOverlay(QWidget):
    done=pyqtSignal(dict); closed=pyqtSignal(); forgot=pyqtSignal()
    def __init__(self,win,first_run,parent=None):
        super().__init__(parent)
        self.win=win; self.cfg=win.cfg; self.first_run=first_run
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground,True)
        self.setStyleSheet(f"SetupOverlay{{background:rgba(5,4,3,245);border:1px solid {C.BORDER_B};border-radius:6px;}}")
        self._providers=win._providers or [dict(p) for p in FALLBACK_PROVIDERS]
        d=self.cfg.data
        cur=d["provider"] if any(p["id"]==d["provider"] for p in self._providers) else self._providers[0]["id"]
        self._sel_provider=cur; self._checked={}; self._got_key={}; self._busy=False
        self._style=d["style"]; self._voice_on=d["voice_on"]; self._ptt=d["global_ptt"]
        self._link=None; self._poll_busy=False; self._poll_until=0.0
        self._poll_tmr=QTimer(self); self._poll_tmr.timeout.connect(self._poll_connect)
        lay=QVBoxLayout(self); lay.setContentsMargins(30,22,30,22); lay.setSpacing(8)
        lay.addWidget(_label("◈  INITIALISATION REQUIRED" if first_run else "◈  SYSTEM SETTINGS",13,True))
        lay.addWidget(_label("Pick an AI and paste its key to start E.D.I.T.H." if first_run else "Switch AI, voice, language or server.",9,color=C.PRI_DIM))
        lay.addSpacing(6); lay.addWidget(_sep())
        scroll=QScrollArea(); scroll.setWidgetResizable(True); scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setStyleSheet("QScrollArea{background:transparent;border:none;}"+_scroll_style())
        body=QWidget(); body.setObjectName("setupBody"); body.setStyleSheet("#setupBody{background:transparent;}")
        f=QVBoxLayout(body); f.setContentsMargins(0,4,10,4); f.setSpacing(8)
        left=Qt.AlignmentFlag.AlignLeft
        # ── AI provider: one button row, wrapped ──
        f.addWidget(_label("AI PROVIDER",8,color=C.TEXT_DIM,align=left))
        self._note=_label("",8,color=C.ACC2,align=left); self._note.setWordWrap(True); f.addWidget(self._note)
        self._grid=QGridLayout(); self._grid.setSpacing(6); self._prov_btns={}; f.addLayout(self._grid)
        f.addSpacing(12); f.addWidget(_sep()); f.addSpacing(4)
        # ── key ──
        self._key_lbl=_label("API KEY",8,color=C.TEXT_DIM,align=left); f.addWidget(self._key_lbl)
        row=QHBoxLayout(); row.setSpacing(6)
        self._key=QLineEdit(); self._key.setEchoMode(QLineEdit.EchoMode.Password)
        self._key.setFont(QFont("Courier New",10)); self._key.setFixedHeight(32); self._key.setStyleSheet(_field_style())
        self._key.returnPressed.connect(lambda: self._check()); row.addWidget(self._key,1)
        self._check_btn=QPushButton("CHECK"); self._check_btn.setFixedSize(70,32); self._check_btn.setFont(QFont("Courier New",9,QFont.Weight.Bold))
        self._check_btn.setCursor(Qt.CursorShape.PointingHandCursor); self._check_btn.setStyleSheet(_line_button_style())
        self._check_btn.clicked.connect(lambda: self._check()); row.addWidget(self._check_btn)
        self._getkey_btn=QPushButton("GET KEY ↗"); self._getkey_btn.setFixedSize(84,32); self._getkey_btn.setFont(QFont("Courier New",8))
        self._getkey_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._getkey_btn.setStyleSheet(f"QPushButton{{background:transparent;color:{C.TEXT_MED};border:1px solid {C.BORDER};border-radius:3px;}}QPushButton:hover{{color:{C.PRI};border:1px solid {C.BORDER_B};}}")
        self._getkey_btn.clicked.connect(self._open_key_page); row.addWidget(self._getkey_btn)
        f.addLayout(row)
        self._base_lbl=_label("SERVER ADDRESS (https://…/v1)",8,color=C.TEXT_DIM,align=left); f.addWidget(self._base_lbl)
        self._base=QLineEdit(); self._base.setPlaceholderText("https://my-server.example.com/v1"); self._base.setFont(QFont("Courier New",10))
        self._base.setFixedHeight(32); self._base.setStyleSheet(_field_style()); f.addWidget(self._base)
        f.addWidget(_label("MODEL",8,color=C.TEXT_DIM,align=left))
        self._model=QComboBox(); self._model.setFixedHeight(32); self._model.setFont(QFont("Courier New",9)); self._model.setStyleSheet(_combo_style())
        f.addWidget(self._model)
        # ── a second key to listen with, for AIs that can't hear ──
        self._vbox=QWidget(); self._vbox.setStyleSheet("background:transparent;"); vb=QVBoxLayout(self._vbox); vb.setContentsMargins(0,4,0,0); vb.setSpacing(6)
        self._vnote=_label("",8,color=C.ACC2,align=left); self._vnote.setWordWrap(True); vb.addWidget(self._vnote)
        vb.addWidget(_label("VOICE KEY (optional)",8,color=C.TEXT_DIM,align=left))
        vrow=QHBoxLayout(); vrow.setSpacing(6)
        self._vprov=QComboBox(); self._vprov.setFixedSize(130,32); self._vprov.setFont(QFont("Courier New",9)); self._vprov.setStyleSheet(_combo_style())
        self._vkey=QLineEdit(); self._vkey.setEchoMode(QLineEdit.EchoMode.Password); self._vkey.setFont(QFont("Courier New",10))
        self._vkey.setFixedHeight(32); self._vkey.setStyleSheet(_field_style())
        vrow.addWidget(self._vprov); vrow.addWidget(self._vkey,1); vb.addLayout(vrow); f.addWidget(self._vbox)
        self._connect_btn=QPushButton("⇄  Connect OpenRouter  ·  no key to copy"); self._connect_btn.setFixedHeight(40)
        self._connect_btn.setFont(QFont("Courier New",8)); self._connect_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._connect_btn.setStyleSheet(_dashed_style()); self._connect_btn.clicked.connect(self._connect); f.addWidget(self._connect_btn)
        # ── answers ──
        f.addSpacing(12); f.addWidget(_sep()); f.addSpacing(4)
        f.addWidget(_label("ANSWER LENGTH",8,color=C.TEXT_DIM,align=left))
        srow=QHBoxLayout(); srow.setSpacing(6); self._style_btns={}
        for key,label in STYLES:
            b=self._choice_button(label); b.clicked.connect(lambda _,k=key:self._sel_style(k)); srow.addWidget(b); self._style_btns[key]=b
        f.addLayout(srow)
        f.addWidget(_label("ANSWER LANGUAGE",8,color=C.TEXT_DIM,align=left))
        self._lang=QComboBox(); self._lang.setFixedHeight(32); self._lang.setFont(QFont("Courier New",9)); self._lang.setStyleSheet(_combo_style())
        for code,name in LANGUAGES: self._lang.addItem(name,code)
        self._lang.setCurrentIndex(max(0,LANGUAGE_IDS.index(d["language"]) if d["language"] in LANGUAGE_IDS else 0))
        self._lang.currentIndexChanged.connect(self._lang_changed); f.addWidget(self._lang)
        # ── voice ──
        f.addSpacing(12); f.addWidget(_sep()); f.addSpacing(4)
        f.addWidget(_label("VOICE REPLIES  [F4]",8,color=C.TEXT_DIM,align=left))
        orow=QHBoxLayout(); orow.setSpacing(6); self._von=self._choice_button("🔊  ON"); self._voff=self._choice_button("🔇  OFF")
        self._von.clicked.connect(lambda: self._sel_voice(True)); self._voff.clicked.connect(lambda: self._sel_voice(False))
        orow.addWidget(self._von); orow.addWidget(self._voff); f.addLayout(orow)
        f.addWidget(_label("VOICE",8,color=C.TEXT_DIM,align=left))
        self._voice=QComboBox(); self._voice.setFixedHeight(32); self._voice.setFont(QFont("Courier New",9)); self._voice.setStyleSheet(_combo_style())
        for vid,name in VOICES: self._voice.addItem(name+("  (default)" if vid=="en-GB-SoniaNeural" else ""),vid)
        self._voice.setCurrentIndex(VOICE_IDS.index(d["voice_name"]) if d["voice_name"] in VOICE_IDS else 0); f.addWidget(self._voice)
        f.addWidget(_label("TALK FROM ANY APP  ·  HOLD RIGHT CTRL",8,color=C.TEXT_DIM,align=left))
        prow=QHBoxLayout(); prow.setSpacing(6); self._pon=self._choice_button("ON"); self._poff=self._choice_button("OFF")
        self._pon.clicked.connect(lambda: self._sel_ptt(True)); self._poff.clicked.connect(lambda: self._sel_ptt(False))
        prow.addWidget(self._pon); prow.addWidget(self._poff); f.addLayout(prow)
        if not GlobalTalkKey.available(): self._pon.setEnabled(False); self._ptt=False
        # ── server ──
        f.addSpacing(12); f.addWidget(_sep()); f.addSpacing(4)
        f.addWidget(_label("EDITH SERVER",8,color=C.TEXT_DIM,align=left))
        self._server=QLineEdit(); self._server.setFont(QFont("Courier New",9)); self._server.setFixedHeight(32); self._server.setStyleSheet(_field_style())
        self._server.setPlaceholderText(DEFAULT_SERVER); self._server.setText(d["server"] if d["server"] and d["server"]!=DEFAULT_SERVER else "")
        if win._server_locked():
            self._server.setText(win.server_url()); self._server.setEnabled(False)
            f.addWidget(self._server); f.addWidget(_label("Set for this run by --server or EDITH_URL.",7,color=C.TEXT_DIM,align=left))
        else: f.addWidget(self._server)
        f.addSpacing(6)
        self._forget=QPushButton("⚠  FORGET THIS PC"); self._forget.setFixedHeight(32); self._forget.setFont(QFont("Courier New",9,QFont.Weight.Bold))
        self._forget.setCursor(Qt.CursorShape.PointingHandCursor)
        self._forget.setStyleSheet(f"QPushButton{{background:#140006;color:{C.MUTED_C};border:1px solid {C.MUTED_C};border-radius:3px;}}QPushButton:hover{{background:#22000a;}}")
        self._forget.clicked.connect(self._forget_pc); f.addWidget(self._forget)
        f.addWidget(_label("Deletes this PC's memories, saved chats and keys.",7,color=C.TEXT_DIM,align=left))
        f.addStretch()
        scroll.setWidget(body); lay.addWidget(scroll,1)
        self._status=_label("",8,color=C.ACC2,align=left); self._status.setWordWrap(True); lay.addWidget(self._status)
        self._init=QPushButton("▸  INITIALISE SYSTEMS" if first_run else "▸  SAVE SETTINGS"); self._init.setFont(QFont("Courier New",10,QFont.Weight.Bold))
        self._init.setFixedHeight(36); self._init.setCursor(Qt.CursorShape.PointingHandCursor); self._init.setStyleSheet(_line_button_style())
        self._init.clicked.connect(lambda: self._submit()); lay.addWidget(self._init)
        self._close=None
        if not first_run:
            self._close=QPushButton("✕",self); self._close.setFixedSize(26,26); self._close.setCursor(Qt.CursorShape.PointingHandCursor)
            self._close.setFont(QFont("Courier New",10,QFont.Weight.Bold)); self._close.setToolTip("Close (Esc)")
            self._close.setStyleSheet(f"QPushButton{{background:transparent;color:{C.TEXT_DIM};border:1px solid {C.BORDER};border-radius:3px;}}QPushButton:hover{{color:{C.PRI};border:1px solid {C.PRI_DIM};}}")
            self._close.clicked.connect(lambda: self.closed.emit())
        QShortcut(QKeySequence("Escape"),self,activated=self._escape)
        self._build_provider_buttons(); self._sel(self._sel_provider)
        self._sel_style(self._style); self._sel_voice(self._voice_on); self._sel_ptt(self._ptt)

    # ── layout helpers ──
    def resizeEvent(self,e):
        super().resizeEvent(e)
        if self._close is not None: self._close.move(self.width()-36,10)
    def _choice_button(self,text):
        b=QPushButton(text); b.setFont(QFont("Courier New",9,QFont.Weight.Bold)); b.setFixedHeight(32)
        b.setCursor(Qt.CursorShape.PointingHandCursor); return b
    def _escape(self):
        if not self.first_run: self.closed.emit()
    def _info(self,pid=None):
        pid=pid or self._sel_provider
        return next((p for p in self._providers if p["id"]==pid),{"id":pid,"label":pid,"note":"","keyUrl":"","voice":False,"models":[],"defaultModel":""})
    def _set_status(self,text,color=C.ACC2):
        self._status.setText(text); self._status.setStyleSheet(f"color:{color};background:transparent;")
    def _api(self):
        return EdithApi(self._server_value,self.cfg)
    def _server_value(self):
        if self.win._server_locked(): return self.win.server_url()
        try: return normalise_server(self._server.text()) if self._server.text().strip() else DEFAULT_SERVER
        except ValueError: return self.win.server_url()
    def set_providers(self,providers):
        self._providers=providers; self._build_provider_buttons()
        if not any(p["id"]==self._sel_provider for p in providers): self._sel_provider=providers[0]["id"]
        self._sel(self._sel_provider,keep_key=True)

    # ── provider row ──
    def _build_provider_buttons(self):
        while self._grid.count():
            it=self._grid.takeAt(0)
            if it.widget(): it.widget().deleteLater()
        self._prov_btns={}
        for i,p in enumerate(self._providers):
            b=self._choice_button(SHORT_PROVIDER.get(p["id"],p["label"].split(" (")[0])); b.setToolTip(p["label"])
            b.clicked.connect(lambda _,k=p["id"]:self._sel(k)); self._grid.addWidget(b,i//3,i%3); self._prov_btns[p["id"]]=b
        vp=[p for p in self._providers if p.get("voice") and p["id"]!="custom"]
        cur=self.cfg.data["voice_provider"] or "groq"; self._vprov.clear()
        for p in vp: self._vprov.addItem(SHORT_PROVIDER.get(p["id"],p["label"]),p["id"])
        idx=self._vprov.findData(cur); self._vprov.setCurrentIndex(idx if idx>=0 else 0)
    def _sel(self,pid,keep_key=False):
        self._sel_provider=pid; info=self._info(pid); saved=self.cfg.saved(pid)
        for k,btn in self._prov_btns.items(): btn.setStyleSheet(_choice_style(k==pid))
        parts=[info["label"]]+([info["note"]] if info.get("note") else [])+([info["keyUrl"]] if info.get("keyUrl") else [])
        self._note.setText(" · ".join(parts))
        if not keep_key: self._key.clear()
        self._key_lbl.setText("API KEY (optional)" if info.get("keyOptional") else "API KEY")
        has_saved=bool(saved.get("key")) or bool(self._got_key.get(pid))
        self._key.setPlaceholderText("Saved key kept · paste a new one to replace" if has_saved else KEY_HINT.get(pid,"Paste your key…"))
        self._getkey_btn.setVisible(bool(key_page_url(info.get("keyUrl"))))
        nb=bool(info.get("needsBase")); self._base_lbl.setVisible(nb); self._base.setVisible(nb)
        if nb and not self._base.text(): self._base.setText(saved.get("base",""))
        models=self.cfg.data["models"].get(pid) or info.get("models") or []
        self._fill_models(models,saved.get("model") or info.get("defaultModel",""),editable=nb)
        hears=bool(info.get("voice")); self._vbox.setVisible(not hears)
        if not hears:
            self._vnote.setText(f"{info['label']} can't hear you. For HOLD TO TALK, add a key from an AI that can (Groq is free). Typing works without one.")
            self._vkey.setPlaceholderText("Saved voice key kept" if self.cfg.data["voice_key"] else "Voice key (optional)")
    def _fill_models(self,models,current,editable=False):
        self._model.blockSignals(True); self._model.clear(); self._model.setEditable(editable)
        if editable and self._model.lineEdit() is not None:
            self._model.lineEdit().setPlaceholderText("model name"); self._model.lineEdit().setFont(QFont("Courier New",9))
        for m in models: self._model.addItem(m.get("name") or m["id"],m["id"])
        idx=self._model.findData(current) if current else -1
        if idx<0 and current and editable: self._model.setEditText(current)
        elif idx>=0: self._model.setCurrentIndex(idx)
        elif self._model.count(): self._model.setCurrentIndex(0)
        self._model.blockSignals(False)
    def _model_id(self):
        if self._model.isEditable():
            txt=self._model.currentText().strip(); idx=self._model.findText(txt)
            return self._model.itemData(idx) if idx>=0 else txt
        return self._model.currentData() or ""
    def _sel_style(self,key):
        self._style=key
        for k,b in self._style_btns.items(): b.setStyleSheet(_choice_style(k==key))
    def _sel_voice(self,on):
        self._voice_on=on; self._von.setStyleSheet(_choice_style(on,C.GREEN)); self._voff.setStyleSheet(_choice_style(not on,C.MUTED_C))
    def _sel_ptt(self,on):
        self._ptt=on; self._pon.setStyleSheet(_choice_style(on,C.GREEN)); self._poff.setStyleSheet(_choice_style(not on))
    def _lang_changed(self,_):
        lang=self._lang.currentData(); want=VOICE_FOR_LANGUAGE.get(lang)
        cur=self._voice.currentData() or ""
        if want and not (lang=="en" and cur.startswith("en-")) and not cur.lower().startswith(lang+"-"):
            self._voice.setCurrentIndex(VOICE_IDS.index(want))
    def _open_key_page(self):
        url=key_page_url(self._info().get("keyUrl"))
        if url: webbrowser.open(url)

    # ── checking a key ──
    def _key_value(self,pid):
        return self._key.text().strip() or self._got_key.get(pid) or self.cfg.saved(pid).get("key","")
    def _base_value(self,pid):
        return self._base.text().strip() if self._info(pid).get("needsBase") else ""
    def _validate(self,pid):
        info=self._info(pid); key=self._key_value(pid); base=self._base_value(pid)
        if info.get("needsBase"):
            base=base.rstrip("/") if _is_https(base) else ""
            if not base: return None,"Your server's address must start with https://"
        if not key and not info.get("keyOptional"): return None,f"Paste your {info['label']} key first, or use Connect OpenRouter."
        return (pid,key,base),""
    def _check(self,then=None):
        if self._busy: return
        sig,err=self._validate(self._sel_provider)
        if not sig: self._set_status(err,C.RED); return
        self._busy=True; self._check_btn.setEnabled(False); self._init.setEnabled(False)
        self._set_status(f"Checking your {self._info(sig[0])['label']} key with EDITH's server…",C.ACC2)
        api=self._api()
        def work():
            try: res=api.check_key(*sig)
            except ApiError as e: res={"ok":False,"error":e.message,"code":"network","other":"","models":[],"defaultModel":"","freeTier":False}
            self.win.ui(lambda: self._checked_key(sig,res,then))
        threading.Thread(target=work,daemon=True).start()
    def _checked_key(self,sig,res,then):
        self._busy=False; self._check_btn.setEnabled(True); self._init.setEnabled(True)
        if not res["ok"]:
            other=res.get("other") or ""
            if res.get("code")=="elsewhere" and any(p["id"]==other for p in self._providers) and other!=sig[0]:
                key=sig[1]; self._sel(other); self._key.setText(key)
                self._set_status(f"That looks like a {self._info(other)['label']} key, so EDITH switched to it. Checking…",C.ACC2)
                QTimer.singleShot(50,lambda: self._check(then)); return
            self._set_status(res.get("error") or "That key didn't work.",C.RED); return
        self._checked[sig]=res
        if sig[0]==self._sel_provider:
            models=res.get("models") or self._info(sig[0]).get("models") or []
            cur=self._model_id() or res.get("defaultModel","")
            if not any(m["id"]==cur for m in models): cur=res.get("defaultModel") or (models[0]["id"] if models else cur)
            self._fill_models(models,cur,editable=bool(self._info(sig[0]).get("needsBase")))
        extra="  OpenRouter's free tier limits some models." if res.get("freeTier") else ""
        self._set_status("✓ Key works. Pick a model, then "+("INITIALISE SYSTEMS." if self.first_run else "SAVE SETTINGS.")+extra,C.GREEN)
        if then: then()

    # ── saving ──
    def _submit(self):
        if self._busy: return
        pid=self._sel_provider; info=self._info(pid)
        sig,err=self._validate(pid)
        if not sig: self._set_status(err,C.RED); return
        saved=self.cfg.saved(pid)
        unchanged=bool(saved) and sig[1]==saved.get("key","") and sig[2]==saved.get("base","")
        if sig not in self._checked and not unchanged: self._check(then=self._submit); return
        vprov=self._vprov.currentData() or ""; vkey=self._vkey.text().strip()
        if not info.get("voice") and vkey and (vprov,vkey,"") not in self._checked:
            self._busy=True; self._init.setEnabled(False); self._set_status(f"Checking the voice key with EDITH's server…",C.ACC2)
            api=self._api()
            def work():
                try: res=api.check_key(vprov,vkey)
                except ApiError as e: res={"ok":False,"error":e.message}
                def back():
                    self._busy=False; self._init.setEnabled(True)
                    if not res.get("ok"): self._set_status("Voice key: "+(res.get("error") or "it didn't work."),C.RED); return
                    self._checked[(vprov,vkey,"")]=res; self._submit()
                self.win.ui(back)
            threading.Thread(target=work,daemon=True).start(); return
        server=self.cfg.data["server"]
        if not self.win._server_locked():
            txt=self._server.text().strip()
            try: server=normalise_server(txt) if txt else ""
            except ValueError as e: self._set_status(str(e),C.RED); return
        models=(self._checked.get(sig) or {}).get("models") or self.cfg.data["models"].get(pid) or info.get("models") or []
        self.done.emit({"provider":pid,"key":sig[1],"base":sig[2],"model":self._model_id(),"label":info["label"],"voice":bool(info.get("voice")),
                        "models":models,"voice_provider":vprov if (vkey and not info.get("voice")) else None,"voice_key":vkey or None,
                        "style":self._style,"language":self._lang.currentData() or "en","voice_on":self._voice_on,
                        "voice_name":self._voice.currentData() or "en-GB-SoniaNeural","global_ptt":self._ptt,"server":server})

    # ── OpenRouter without copying a key ──
    def _connect(self):
        if self._link is not None: self._stop_connect("Stopped waiting for OpenRouter."); return
        self._set_status("Asking EDITH's server for an OpenRouter link…",C.ACC2); api=self._api()
        def work():
            try: link=api.connect_start(); self.win.ui(lambda: self._connect_started(link))
            except ApiError as e: msg=e.message; self.win.ui(lambda: self._set_status(f"Couldn't start: {msg}",C.RED))
        threading.Thread(target=work,daemon=True).start()
    def _connect_started(self,link):
        url=str(link.get("url") or "")
        if not safe_web_url(url): self._set_status("EDITH's server sent a link EDITH won't open.",C.RED); return
        self._link=link; self._poll_until=time.time()+max(60,min(900,float(link.get("expiresIn") or 900)))
        webbrowser.open(url); self._poll_tmr.start(CONNECT_POLL_MS)
        self._connect_btn.setText("⇄  Waiting for OpenRouter…  ·  click to stop")
        self._set_status("Approve EDITH on the OpenRouter page that just opened in your browser. Waiting…",C.ACC2)
    def _stop_connect(self,msg="",color=C.ACC2):
        self._poll_tmr.stop(); self._link=None; self._connect_btn.setText("⇄  Connect OpenRouter  ·  no key to copy")
        if msg: self._set_status(msg,color)
    def _poll_connect(self):
        link=self._link
        if link is None or self._poll_busy: return
        if time.time()>self._poll_until: self._stop_connect("That OpenRouter link expired. Try again.",C.RED); return
        self._poll_busy=True; api=self._api()
        def work():
            try: res=api.connect_poll(link)
            except ApiError: res={"status":"pending"}  # a network blip: ask again next time
            self.win.ui(lambda: self._polled(link,res))
        threading.Thread(target=work,daemon=True).start()
    def _polled(self,link,res):
        self._poll_busy=False
        if link is not self._link: return
        st=res.get("status")
        if st=="pending": return
        if st=="connected" and isinstance(res.get("key"),str) and res["key"]:
            self._stop_connect(); self._got_key["openrouter"]=res["key"]; self._sel("openrouter")
            self._set_status("OpenRouter approved EDITH. Checking the key…",C.ACC2); self._check(then=self._submit); return
        self._stop_connect("OpenRouter didn't connect. Try again." if st=="failed" else "That OpenRouter link expired. Try again.",C.RED)

    # ── forgetting this PC ──
    def _forget_pc(self):
        if not confirm_dialog(self.win,"⚠  FORGET THIS PC","EDITH deletes this PC's memories, conversation, saved chats and lists on the server, then removes the keys and settings saved here. This can't be undone.","FORGET",True): return
        self._set_status("Forgetting this PC…",C.ACC2); api=EdithApi(self.win.server_url,self.cfg)
        def work():
            try: api.forget(); self.win.ui(self.forgot.emit)
            except ApiError as e: msg=e.message; self.win.ui(lambda: self._set_status(f"Nothing was deleted: {msg} Try again.",C.RED))
        threading.Thread(target=work,daemon=True).start()

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — SAVED CHATS                                                        ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class ChatsDialog(QDialog):
    def __init__(self,win):
        super().__init__(win); self.win=win; self._seq=0
        self.setWindowTitle("Saved chats — E.D.I.T.H"); self.setFixedSize(440,520)
        self.setStyleSheet(f"background:{C.BG};color:{C.WHITE};")
        vl=QVBoxLayout(self); vl.setSpacing(10); vl.setContentsMargins(24,18,24,18)
        vl.addWidget(_label("💬  SAVED CHATS",10,True,C.GREEN))
        vl.addWidget(_label("Pick up an old conversation, or start a new one.",8,False,C.TEXT_MED))
        row=QHBoxLayout(); row.setSpacing(6)
        self._q=QLineEdit(); self._q.setPlaceholderText("search chats"); self._q.setFixedHeight(38)
        self._q.setStyleSheet(f"QLineEdit{{background:{C.DARK};color:{C.WHITE};border:1px solid {C.BORDER};border-radius:6px;padding:0 10px;font-family:'Courier New';}}QLineEdit:focus{{border:1px solid {C.PRI};}}")
        go=_dialog_button("GO"); go.setFixedWidth(64)
        self._tmr=QTimer(self); self._tmr.setSingleShot(True); self._tmr.timeout.connect(lambda: self._load(self._q.text().strip()))
        self._q.textChanged.connect(lambda _: self._tmr.start(350)); self._q.returnPressed.connect(lambda: self._load(self._q.text().strip()))
        go.clicked.connect(lambda: self._load(self._q.text().strip()))
        row.addWidget(self._q); row.addWidget(go); vl.addLayout(row)
        self._list=QListWidget(); self._list.setFont(QFont("Courier New",9))
        self._list.setStyleSheet(f"QListWidget{{background:{C.DARK};color:{C.TEXT};border:1px solid {C.BORDER};border-radius:6px;padding:4px;outline:0;}}QListWidget::item{{padding:6px 4px;border-bottom:1px solid {C.PANEL2};}}QListWidget::item:selected{{background:{C.PRI_GHO};color:{C.PRI};}}QListWidget::item:hover{{background:{C.PANEL2};}}"+_scroll_style())
        self._list.itemDoubleClicked.connect(lambda _: self._open()); vl.addWidget(self._list,1)
        self._status=_label("",8,False,C.TEXT_DIM); self._status.setWordWrap(True); vl.addWidget(self._status)
        brow=QHBoxLayout(); brow.setSpacing(6)
        ob=_dialog_button("OPEN"); db=_dialog_button("DELETE",True); nb=_dialog_button("NEW CHAT")
        ob.clicked.connect(self._open); db.clicked.connect(self._delete); nb.clicked.connect(self._new)
        brow.addWidget(ob); brow.addWidget(db); brow.addWidget(nb); vl.addLayout(brow)
        self._load("")
    def _set(self,text,color=C.TEXT_DIM):
        self._status.setText(text); self._status.setStyleSheet(f"color:{color};background:transparent;")
    def _load(self,query):
        self._seq+=1; seq=self._seq; self._set("Searching…" if query else "Loading your chats…")
        api=self.win.api
        def work():
            try: chats=api.chats(query); self.win.ui(lambda: self._fill(seq,chats,query))
            except ApiError as e: msg=e.message; self.win.ui(lambda: self._seq==seq and self._set(f"Couldn't load chats: {msg}",C.RED))
        threading.Thread(target=work,daemon=True).start()
    def _fill(self,seq,chats,query):
        if seq!=self._seq: return
        self._list.clear(); cur=self.win.cfg.data["chat_id"]
        for c in chats:
            n=int(c.get("count") or 0); title=" ".join(str(c.get("title") or "Untitled chat").split())[:60]
            it=QListWidgetItem(f"{'● ' if c['id']==cur else '  '}{title}\n    {n} message{'s' if n!=1 else ''}  ·  {time_ago(c.get('updated'))}")
            it.setData(Qt.ItemDataRole.UserRole,c["id"]); self._list.addItem(it)
        if chats: self._list.setCurrentRow(0)
        self._set(f"{len(chats)} chat{'s' if len(chats)!=1 else ''}"+(f" match “{query}”" if query else "") if chats else ("Nothing matches that." if query else "No saved chats yet. Ask EDITH something to start one."))
    def _selected(self):
        it=self._list.currentItem(); return it.data(Qt.ItemDataRole.UserRole) if it else None
    def _open(self):
        cid=self._selected()
        if cid: self.win._open_chat(cid); self.accept()
    def _delete(self):
        cid=self._selected()
        if not cid: return
        if not confirm_dialog(self,"DELETE THIS CHAT?","The chat is deleted from EDITH's server. This can't be undone.","DELETE",True): return
        self._set("Deleting…"); api=self.win.api
        def work():
            try: api.delete_chat(cid); self.win.ui(lambda: self._deleted(cid))
            except ApiError as e: msg=e.message; self.win.ui(lambda: self._set(f"Couldn't delete: {msg}",C.RED))
        threading.Thread(target=work,daemon=True).start()
    def _deleted(self,cid):
        for i in range(self._list.count()):
            if self._list.item(i).data(Qt.ItemDataRole.UserRole)==cid: self._list.takeItem(i); break
        self._set("Chat deleted.",C.GREEN); self.win._chat_deleted(cid)
    def _new(self):
        self.win._new_chat(); self.accept()

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  UI — MAIN WINDOW                                                        ║
# ╚══════════════════════════════════════════════════════════════════════════╝
class MainWindow(QMainWindow):
    _log_sig=pyqtSignal(str); _state_sig=pyqtSignal(str); _ui_sig=pyqtSignal(object)
    def __init__(self,cfg,demo=False,server_override=""):
        super().__init__()
        self.cfg=cfg; self.demo=demo; self._server_override=server_override
        self.api=EdithApi(self.server_url,cfg); self._providers=[dict(p) for p in FALLBACK_PROVIDERS]
        self.setWindowTitle("E.D.I.T.H"); self.setMinimumSize(820,580); self.resize(980,700)
        try:
            screen=QApplication.primaryScreen().availableGeometry()
            self.move(screen.x()+(screen.width()-980)//2,screen.y()+(screen.height()-700)//2)
        except Exception: pass
        self._state="INITIALISING"; self._overlay=None; self._history=[]; self._answers_in_chat=0
        self._req_token=0; self._cancel=None; self._you=None; self._live=None; self._answer=""
        self._recorder=Recorder(); self._mic_ok=None; self._recording=False; self._space_rec=False
        self._photo=None; self._player=None; self._audio_out=None; self._voice_path=None; self._speak_token=0
        self._voice_installing=False; self._voice_install_failed=False; self._voice_warned=False
        self._server_ok=None; self._talk_key=None; self._probing=False; self._metrics=_SysMetrics()
        central=QWidget(); central.setStyleSheet(f"background:{C.BG};"); self.setCentralWidget(central)
        root=QVBoxLayout(central); root.setContentsMargins(0,0,0,0); root.setSpacing(0)
        root.addWidget(self._build_header())
        body=QHBoxLayout(); body.setContentsMargins(0,0,0,0); body.setSpacing(0)
        body.addWidget(self._build_left_panel(),stretch=0)
        self.hud=HudCanvas()
        self.hud.setSizePolicy(QSizePolicy.Policy.Expanding,QSizePolicy.Policy.Expanding)
        body.addWidget(self.hud,stretch=5)
        body.addWidget(self._build_right_panel(),stretch=0)
        root.addLayout(body,stretch=1); root.addWidget(self._build_footer())
        self._clock_tmr=QTimer(self); self._clock_tmr.timeout.connect(self._tick_clock); self._clock_tmr.start(1000); self._tick_clock()
        self._metric_tmr=QTimer(self); self._metric_tmr.timeout.connect(self._update_metrics); self._metric_tmr.start(2000); self._update_metrics()
        self._rec_tmr=QTimer(self); self._rec_tmr.timeout.connect(self._rec_tick)
        self._log_sig.connect(self._on_log); self._state_sig.connect(self._apply_state); self._ui_sig.connect(self._run_ui)
        QShortcut(QKeySequence("F4"),self).activated.connect(self._toggle_voice)
        QShortcut(QKeySequence("F11"),self).activated.connect(self._toggle_fs)
        app=QApplication.instance(); app.installEventFilter(self); app.applicationStateChanged.connect(self._app_state)
        self.setAcceptDrops(True)
        self._refresh_link(); self._style_talk(); self._style_voice(); self._apply_state("INITIALISING")
        self.hud.setFocus()
        if not demo: QTimer.singleShot(0,self._boot)

    # ── plumbing ──
    def ui(self,fn):
        """Runs fn on the UI thread: every worker thread reaches the window through this signal."""
        self._ui_sig.emit(fn)
    def _run_ui(self,fn):
        try: fn()
        except RuntimeError: pass  # a dialog closed while its request was out
        except Exception: traceback.print_exc()
    def server_url(self):
        for raw in (self._server_override,os.environ.get("EDITH_URL",""),self.cfg.data.get("server","")):
            if raw:
                try: return normalise_server(raw)
                except ValueError: continue
        return DEFAULT_SERVER
    def _server_locked(self):
        return bool(self._server_override or os.environ.get("EDITH_URL",""))
    def _info(self,pid):
        return next((p for p in self._providers if p["id"]==pid),None) or next((p for p in FALLBACK_PROVIDERS if p["id"]==pid),{"id":pid,"label":pid,"models":[]})
    def _link_parts(self):
        a=self.cfg.access(); pid=a["provider"]
        if not pid: return "","",""
        info=self._info(pid); label=self.cfg.saved(pid).get("label") or info.get("label") or pid
        models=self.cfg.data["models"].get(pid) or info.get("models") or []
        return label,model_label(models,a["model"]) or "default model",pid
    def _link_text(self):
        label,model,_=self._link_parts(); return f"{label} / {model}"

    def _toggle_fs(self):
        self.showNormal() if self.isFullScreen() else self.showFullScreen()

    def resizeEvent(self,event):
        super().resizeEvent(event); self._place_overlay()

    def _update_metrics(self):
        snap=self._metrics.snapshot()
        if not self._metrics.ok:
            for bar in (self._bar_cpu,self._bar_mem,self._bar_net,self._bar_gpu,self._bar_tmp): bar.set_value(0,"N/A")
        else:
            cpu=snap["cpu"]; self._bar_cpu.set_value(cpu,f"{cpu:.0f}%")
            mem=snap["mem"]; self._bar_mem.set_value(mem,f"{mem:.0f}%")
            net=snap["net"]; self._bar_net.set_value(min(100,net*10),f"{net:.1f}MB/s" if net>=1 else f"{net*1024:.0f}KB/s")
            gpu=snap["gpu"]
            self._bar_gpu.set_value(gpu,f"{gpu:.0f}%") if gpu>=0 else self._bar_gpu.set_value(0,"N/A")
            tmp=snap["tmp"]
            self._bar_tmp.set_value(min(100,tmp),(f"{tmp:.0f}°C")) if tmp>=0 else self._bar_tmp.set_value(0,"N/A")
        try:
            el=time.time()-psutil.boot_time(); h=int(el//3600); m=int((el%3600)//60)
            self._uptime_lbl.setText(f"UP  {h:02d}:{m:02d}")
        except Exception: self._uptime_lbl.setText("UP  --:--")
        try: self._proc_lbl.setText(f"PROC  {len(psutil.pids())}")
        except Exception: pass

    def _build_header(self):
        w=QWidget(); w.setFixedHeight(54); w.setStyleSheet(f"background:{C.DARK};border-bottom:1px solid {C.BORDER_B};")
        lay=QHBoxLayout(w); lay.setContentsMargins(16,0,16,0)
        def badge(txt,color=C.TEXT_MED):
            l=QLabel(txt); l.setFont(QFont("Courier New",8)); l.setStyleSheet(f"color:{color};background:transparent;"); return l
        lay.addWidget(badge("PC EDITION",C.PRI_DIM)); lay.addStretch()
        mid=QVBoxLayout(); mid.setSpacing(1)
        t=QLabel("E.D.I.T.H"); t.setAlignment(Qt.AlignmentFlag.AlignCenter)
        t.setFont(QFont("Courier New",17,QFont.Weight.Bold)); t.setStyleSheet(f"color:{C.PRI};background:transparent;"); mid.addWidget(t)
        s=QLabel("Talk to any AI"); s.setAlignment(Qt.AlignmentFlag.AlignCenter)
        s.setFont(QFont("Courier New",7)); s.setStyleSheet(f"color:{C.PRI_DIM};background:transparent;"); mid.addWidget(s)
        lay.addLayout(mid); lay.addStretch()
        rc=QVBoxLayout(); rc.setSpacing(2)
        self._clock_lbl=QLabel("00:00:00"); self._clock_lbl.setFont(QFont("Courier New",14,QFont.Weight.Bold))
        self._clock_lbl.setStyleSheet(f"color:{C.PRI};background:transparent;"); self._clock_lbl.setAlignment(Qt.AlignmentFlag.AlignRight); rc.addWidget(self._clock_lbl)
        self._date_lbl=QLabel(""); self._date_lbl.setFont(QFont("Courier New",7))
        self._date_lbl.setStyleSheet(f"color:{C.TEXT_DIM};background:transparent;"); self._date_lbl.setAlignment(Qt.AlignmentFlag.AlignRight); rc.addWidget(self._date_lbl)
        lay.addLayout(rc); return w

    def _tick_clock(self):
        now=datetime.now()
        self._clock_lbl.setText(now.strftime("%H:%M:%S")); self._date_lbl.setText(f"{_DAYS[now.weekday()][:3]} {now.day:02d} {_MONTHS[now.month-1][:3]} {now.year}")

    def _build_left_panel(self):
        w=QWidget(); w.setFixedWidth(148); w.setStyleSheet(f"background:{C.DARK};border-right:1px solid {C.BORDER};")
        lay=QVBoxLayout(w); lay.setContentsMargins(8,10,8,10); lay.setSpacing(6)
        hdr=QLabel("◈ SYS MONITOR"); hdr.setFont(QFont("Courier New",7,QFont.Weight.Bold))
        hdr.setStyleSheet(f"color:{C.PRI};background:transparent;border-bottom:1px solid {C.BORDER};padding-bottom:4px;"); lay.addWidget(hdr); lay.addSpacing(2)
        self._bar_cpu=MetricBar("CPU",C.PRI); self._bar_mem=MetricBar("MEM",C.ACC2)
        self._bar_net=MetricBar("NET",C.GREEN); self._bar_gpu=MetricBar("GPU",C.ACC); self._bar_tmp=MetricBar("TMP","#ff6688")
        for bar in [self._bar_cpu,self._bar_mem,self._bar_net,self._bar_gpu,self._bar_tmp]: lay.addWidget(bar)
        lay.addSpacing(4)
        ip=QWidget(); ip.setStyleSheet(f"background:{C.PANEL2};border:1px solid {C.BORDER};border-radius:4px;")
        ipl=QVBoxLayout(ip); ipl.setContentsMargins(6,5,6,5); ipl.setSpacing(3)
        self._uptime_lbl=QLabel("UP  --:--"); self._uptime_lbl.setFont(QFont("Courier New",8,QFont.Weight.Bold))
        self._uptime_lbl.setStyleSheet(f"color:{C.GREEN};background:transparent;border:none;"); ipl.addWidget(self._uptime_lbl)
        self._proc_lbl=QLabel("PROC  --"); self._proc_lbl.setFont(QFont("Courier New",8))
        self._proc_lbl.setStyleSheet(f"color:{C.TEXT_MED};background:transparent;border:none;"); ipl.addWidget(self._proc_lbl)
        os_n={"Windows":"WIN","Darwin":"macOS","Linux":"LINUX"}.get(_OS,_OS.upper())
        ol=QLabel(f"OS  {os_n}"); ol.setFont(QFont("Courier New",8))
        ol.setStyleSheet(f"color:{C.ACC2};background:transparent;border:none;"); ipl.addWidget(ol)
        lay.addWidget(ip); lay.addStretch()
        self._badges=[]
        for txt,col in [("AI CORE\nONLINE",C.GREEN),("VOICE\nREADY",C.PRI),("MODEL\n—",C.TEXT_DIM)]:
            l=QLabel(txt); l.setTextFormat(Qt.TextFormat.PlainText); l.setFont(QFont("Courier New",7,QFont.Weight.Bold)); l.setAlignment(Qt.AlignmentFlag.AlignCenter)
            l.setStyleSheet(f"color:{col};background:{C.PANEL2};border:1px solid {C.BORDER_A};border-radius:3px;padding:4px;"); lay.addWidget(l); self._badges.append(l)
        return w

    def _badge(self,i,txt,col):
        l=self._badges[i]; l.setText(txt)
        l.setStyleSheet(f"color:{col};background:{C.PANEL2};border:1px solid {C.BORDER_A};border-radius:3px;padding:4px;")

    def _build_right_panel(self):
        w=QWidget(); w.setFixedWidth(340); w.setStyleSheet(f"background:{C.DARK};border-left:1px solid {C.BORDER};")
        lay=QVBoxLayout(w); lay.setContentsMargins(8,8,8,8); lay.setSpacing(6)
        def sec(txt):
            l=QLabel(f"▸ {txt}"); l.setFont(QFont("Courier New",7,QFont.Weight.Bold))
            l.setStyleSheet(f"color:{C.TEXT_MED};background:transparent;"); return l
        lay.addWidget(sec("ACTIVITY LOG"))
        self._log=LogWidget(); lay.addWidget(self._log,stretch=1)
        sep=QFrame(); sep.setFrameShape(QFrame.Shape.HLine); sep.setStyleSheet(f"color:{C.BORDER};margin:2px 0;"); lay.addWidget(sep)
        # AI link: which AI answers, and the settings
        lay.addWidget(sec("AI LINK"))
        self._link_label=QLabel("No AI linked"); self._link_label.setTextFormat(Qt.TextFormat.PlainText); self._link_label.setFont(QFont("Courier New",7))
        self._link_label.setStyleSheet(f"color:{C.TEXT_DIM};background:transparent;"); self._link_label.setWordWrap(True); lay.addWidget(self._link_label)
        sbtn=QPushButton("⚙  Settings / switch AI"); sbtn.setFixedHeight(40)
        sbtn.setFont(QFont("Courier New",8)); sbtn.setCursor(Qt.CursorShape.PointingHandCursor); sbtn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        sbtn.setStyleSheet(f"QPushButton{{background:{C.DARK};color:{C.TEXT_MED};border:2px dashed {C.BORDER};border-radius:6px;}}QPushButton:hover{{border-color:{C.PRI};color:{C.PRI};}}")
        sbtn.clicked.connect(lambda: self._show_setup(first_run=False)); lay.addWidget(sbtn)
        # Photo / vision upload
        lay.addWidget(sec("ASK ABOUT A PHOTO"))
        prow=QHBoxLayout(); prow.setContentsMargins(0,0,0,0); prow.setSpacing(4)
        self._photo_label=QLabel("No photo loaded"); self._photo_label.setTextFormat(Qt.TextFormat.PlainText); self._photo_label.setFont(QFont("Courier New",7))
        self._photo_label.setStyleSheet(f"color:{C.TEXT_DIM};background:transparent;"); self._photo_label.setWordWrap(True); prow.addWidget(self._photo_label,1)
        self._shot_btn=QPushButton("▣ Screenshot my screen"); self._shot_btn.setFont(QFont("Courier New",7)); self._shot_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._shot_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._shot_btn.setStyleSheet(f"QPushButton{{background:transparent;color:{C.PRI_DIM};border:none;padding:0;}}QPushButton:hover{{color:{C.PRI};}}")
        self._shot_btn.clicked.connect(self._screenshot_screen); prow.addWidget(self._shot_btn); lay.addLayout(prow)
        pbtn=QPushButton("📷  Browse photo / screenshot"); pbtn.setFixedHeight(40)
        pbtn.setFont(QFont("Courier New",8)); pbtn.setCursor(Qt.CursorShape.PointingHandCursor); pbtn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        pbtn.setStyleSheet(f"QPushButton{{background:{C.DARK};color:{C.TEXT_MED};border:2px dashed {C.BORDER};border-radius:6px;}}QPushButton:hover{{border-color:{C.PRI};color:{C.PRI};}}")
        pbtn.clicked.connect(self._upload_photo); lay.addWidget(pbtn)
        sep2=QFrame(); sep2.setFrameShape(QFrame.Shape.HLine); sep2.setStyleSheet(f"color:{C.BORDER};margin:2px 0;"); lay.addWidget(sep2)
        lay.addWidget(sec("COMMAND INPUT")); lay.addLayout(self._build_input())
        self._talk_btn=QPushButton("🎙  HOLD TO TALK  [SPACE]"); self._talk_btn.setFixedHeight(30)
        self._talk_btn.setFont(QFont("Courier New",8,QFont.Weight.Bold)); self._talk_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._talk_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._talk_btn.pressed.connect(lambda: self._talk_down()); self._talk_btn.released.connect(lambda: self._talk_up()); lay.addWidget(self._talk_btn)
        self._voice_btn=QPushButton("🔊  VOICE REPLIES ON  [F4]"); self._voice_btn.setFixedHeight(26)
        self._voice_btn.setFont(QFont("Courier New",7,QFont.Weight.Bold)); self._voice_btn.setCursor(Qt.CursorShape.PointingHandCursor)
        self._voice_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus); self._voice_btn.clicked.connect(self._toggle_voice); lay.addWidget(self._voice_btn)
        fs_btn=QPushButton("⛶  FULLSCREEN  [F11]"); fs_btn.setFixedHeight(26); fs_btn.setFont(QFont("Courier New",7))
        fs_btn.setCursor(Qt.CursorShape.PointingHandCursor); fs_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        fs_btn.setStyleSheet(f"QPushButton{{background:transparent;color:{C.TEXT_MED};border:1px solid {C.BORDER};border-radius:3px;}}QPushButton:hover{{color:{C.PRI};border:1px solid {C.BORDER_B};}}")
        fs_btn.clicked.connect(self._toggle_fs); lay.addWidget(fs_btn)
        # Saved chats
        self._chats_btn=QPushButton("●  SAVED CHATS"); self._chats_btn.setFixedHeight(26); self._chats_btn.setFont(QFont("Courier New",7,QFont.Weight.Bold))
        self._chats_btn.setCursor(Qt.CursorShape.PointingHandCursor); self._chats_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._chats_btn.setStyleSheet(f"QPushButton{{background:#001a0a;color:{C.GREEN};border:1px solid {C.GREEN};border-radius:3px;}}QPushButton:hover{{background:#002a10;}}")
        self._chats_btn.clicked.connect(self._show_chats); lay.addWidget(self._chats_btn)
        return w

    def _build_input(self):
        row=QHBoxLayout(); row.setSpacing(5)
        self._input=QLineEdit(); self._input.setPlaceholderText("Type a message…")
        self._input.setFont(QFont("Courier New",9)); self._input.setFixedHeight(30); self._input.setMaxLength(4000)
        self._input.setStyleSheet(f"QLineEdit{{background:{C.DARK};color:{C.WHITE};border:1px solid {C.BORDER};border-radius:3px;padding:3px 7px;}}QLineEdit:focus{{border:1px solid {C.PRI};}}")
        self._input.returnPressed.connect(self._send); row.addWidget(self._input)
        send=QPushButton("▸"); send.setFixedSize(30,30); send.setFont(QFont("Courier New",11,QFont.Weight.Bold))
        send.setCursor(Qt.CursorShape.PointingHandCursor); send.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        send.setStyleSheet(f"QPushButton{{background:{C.PANEL};color:{C.PRI};border:1px solid {C.PRI_DIM};border-radius:3px;}}QPushButton:hover{{background:{C.PRI_GHO};border:1px solid {C.PRI};}}")
        send.clicked.connect(self._send); row.addWidget(send); return row

    def _build_footer(self):
        w=QWidget(); w.setFixedHeight(22); w.setStyleSheet(f"background:{C.DARK};border-top:1px solid {C.BORDER};")
        lay=QHBoxLayout(w); lay.setContentsMargins(14,0,14,0)
        def fl(txt,color=C.TEXT_MED):
            l=QLabel(txt); l.setFont(QFont("Courier New",7)); l.setStyleSheet(f"color:{color};background:transparent;"); return l
        lay.addWidget(fl("[SPACE] Hold to talk  ·  [F4] Voice  ·  [F11] Fullscreen")); lay.addStretch()
        lay.addWidget(fl("E.D.I.T.H  ·  PC EDITION")); lay.addStretch()
        lay.addWidget(fl("OPEN SOURCE · MIT",C.PRI_DIM)); return w

    # ── strips ──
    def _style_talk(self):
        if self._recording:
            secs=int(time.time()-self._recorder.started) if self._recorder.started else 0
            self._talk_btn.setText(f"●  LISTENING  {secs//60}:{secs%60:02d}  ·  RELEASE TO SEND")
            self._talk_btn.setStyleSheet(f"QPushButton{{background:#140006;color:{C.RED};border:1px solid {C.RED};border-radius:3px;}}")
        elif self._mic_ok is False:
            self._talk_btn.setText("🔇  NO MICROPHONE  ·  TYPE BELOW")
            self._talk_btn.setStyleSheet(f"QPushButton{{background:#140006;color:{C.MUTED_C};border:1px solid {C.MUTED_C};border-radius:3px;}}")
        else:
            self._talk_btn.setText("🎙  HOLD TO TALK  [SPACE]")
            self._talk_btn.setStyleSheet(f"QPushButton{{background:#00140a;color:{C.GREEN};border:1px solid {C.GREEN};border-radius:3px;}}QPushButton:hover{{background:#001f10;}}")

    def _style_voice(self):
        if self.cfg.data["voice_on"]:
            self._voice_btn.setText("🔊  VOICE REPLIES ON  [F4]")
            self._voice_btn.setStyleSheet(f"QPushButton{{background:{C.PRI_GHO};color:{C.PRI};border:1px solid {C.PRI_DIM};border-radius:3px;}}QPushButton:hover{{border:1px solid {C.PRI};}}")
        else:
            self._voice_btn.setText("🔇  VOICE REPLIES OFF  [F4]")
            self._voice_btn.setStyleSheet(f"QPushButton{{background:#140006;color:{C.MUTED_C};border:1px solid {C.MUTED_C};border-radius:3px;}}")

    def _refresh_link(self):
        label,model,pid=self._link_parts()
        if pid:
            self._link_label.setText(f"● {label}  ·  {model}"); self._link_label.setStyleSheet(f"color:{C.GREEN};background:transparent;")
            short=model.upper(); short=short if len(short)<=16 else short[:15]+"…"
            if self._server_ok is False: self._badge(0,"AI CORE\nOFFLINE",C.RED)
            else: self._badge(0,"AI CORE\nONLINE",C.GREEN)
            self._badge(2,f"MODEL\n{short}",C.TEXT_DIM)
        else:
            self._link_label.setText("No AI linked · open settings to pick one"); self._link_label.setStyleSheet(f"color:{C.TEXT_DIM};background:transparent;")
            self._badge(0,"AI CORE\nOFFLINE" if self._server_ok is False else "AI CORE\nNO LINK",C.RED if self._server_ok is False else C.ACC2)
            self._badge(2,"MODEL\n—",C.TEXT_DIM)
        if self._mic_ok is False: self._badge(1,"VOICE\nNO MIC",C.MUTED_C)
        elif not self.cfg.data["voice_on"]: self._badge(1,"VOICE\nMUTED",C.MUTED_C)
        else: self._badge(1,"VOICE\nREADY",C.PRI)

    # ── state ──
    def _idle_state(self):
        return "READY" if self.cfg.has_access() else "STANDBY"
    def _apply_state(self,state):
        self._state=state; self.hud.state=state
        self.hud.speaking=state in ("SPEAKING","ANSWERING")
        self.hud.muted=(not self.cfg.data["voice_on"]) and state in ("READY","STANDBY")
    def _on_log(self,text):
        self._log.append_log(text)

    # ── boot ──
    def _boot(self):
        self._log.append_log("SYS: E.D.I.T.H online.")
        if self.cfg.has_access():
            self._log.append_log(f"SYS: AI link: {self._link_text()}")
            self._apply_state("READY"); self._restore_chat()
        else:
            self._log.append_log("SYS: No AI linked yet. Pick one and paste its key to begin.")
            self._apply_state("STANDBY"); self._show_setup(first_run=True)
        self._probe_mic(boot=True); self._fetch_providers()
        if self.cfg.data["voice_on"]: self._ensure_voice()
        self._apply_talk_key()

    def _fetch_providers(self):
        api=self.api
        def work():
            try: prov=api.providers(); self.ui(lambda: self._got_providers(prov))
            except ApiError as e: msg=e.message; self.ui(lambda: self._server_down(msg))
        threading.Thread(target=work,daemon=True).start()
    def _got_providers(self,prov):
        self._server_ok=True
        if prov:
            self._providers=prov
            if self._overlay is not None: self._overlay.set_providers(prov)
        self._refresh_link()
    def _server_down(self,msg):
        self._server_ok=False; self._refresh_link()
        self._log.append_log(f"ERR: {msg} Answers need a connection.")

    def _probe_mic(self,boot=False,user=False):
        if self._probing: return
        self._probing=True
        def work():
            ok,why=Recorder.probe(); self.ui(lambda: self._mic_probed(ok,boot,user))
        threading.Thread(target=work,daemon=True).start()
    def _mic_probed(self,ok,boot,user):
        self._probing=False; was=self._mic_ok; self._mic_ok=ok; self._style_talk(); self._refresh_link()
        if ok:
            if boot or was is False: self._log.append_log("SYS: Hold SPACE to talk, or type below.")
        elif boot or user or was is not False:
            self._log.append_log("SYS: No microphone found. Typing works; plug one in and press HOLD TO TALK to try again.")

    def _restore_chat(self):
        d=self.cfg.data; cid=clean_chat_id(d["chat_id"])
        if not cid or time.time()-float(d.get("chat_used") or 0)>CONTINUE_CHAT_S:
            d["chat_id"]=new_chat_id(); self._history=[]; self._answers_in_chat=0; self._save(); return
        d["chat_id"]=cid; api=self.api
        def work():
            try: chat=api.open_chat(cid)
            except ApiError: return
            self.ui(lambda: self._restored(cid,chat))
        threading.Thread(target=work,daemon=True).start()
    def _restored(self,cid,chat):
        if chat is None or cid!=self.cfg.data["chat_id"] or self._req_token: return
        msgs=chat["messages"]
        self._history=clean_history([{"role":"user" if m.get("role")=="user" else "model","parts":[{"text":m["content"]}]} for m in msgs])
        self._answers_in_chat=sum(1 for m in msgs if m.get("role")!="user")
        if msgs: self._log.append_log(f"SYS: Carrying on with your last chat, “{(chat['title'] or 'untitled')[:48]}”.")

    def _save(self):
        try: self.cfg.save()
        except OSError as e: self._log.append_log(f"ERR: Couldn't save settings ({e.strerror or 'disk error'}).")

    # ── setup overlay ──
    def _show_setup(self,first_run=None):
        if first_run is None: first_run=not self.cfg.has_access()
        if not first_run and not self.cfg.has_access(): first_run=True
        self._close_setup()
        ov=SetupOverlay(self,first_run,self.centralWidget())
        ov.done.connect(self._on_setup_done); ov.closed.connect(self._close_setup); ov.forgot.connect(self._on_forgot)
        self._overlay=ov; self._place_overlay(); ov.show(); ov.raise_(); ov._key.setFocus()
    def _place_overlay(self):
        ov=self._overlay
        if ov is None: return
        cw=self.centralWidget(); ow=min(460,cw.width()-24); oh=min(640,cw.height()-24)
        ov.setGeometry((cw.width()-ow)//2,(cw.height()-oh)//2,ow,oh)
    def _close_setup(self):
        ov,self._overlay=self._overlay,None
        if ov is not None: ov.hide(); ov.deleteLater(); self.hud.setFocus()
    def _on_setup_done(self,s):
        d=self.cfg.data; first=not self.cfg.has_access(); before=(d["provider"],self.cfg.saved(d["provider"]).get("model"))
        pid=s["provider"]
        d["keys"][pid]={"key":s["key"],"model":s["model"],"base":s["base"],"label":s["label"],"voice":s["voice"]}
        if s["models"]: d["models"][pid]=s["models"]
        d["provider"]=pid
        if s.get("voice_key") and s.get("voice_provider"): d["voice_provider"]=s["voice_provider"]; d["voice_key"]=s["voice_key"]
        voice_was=d["voice_on"]
        d.update({"style":s["style"],"language":s["language"],"voice_on":s["voice_on"],"voice_name":s["voice_name"],"global_ptt":s["global_ptt"]})
        if not self._server_locked(): d["server"]=s["server"]
        if not clean_chat_id(d["chat_id"]): d["chat_id"]=new_chat_id()
        self._save(); self._close_setup()
        if first: self._log.append_log(f"SYS: Initialised. AI link: {self._link_text()}. E.D.I.T.H online.")
        elif before!=(pid,s["model"]): self._log.append_log(f"SYS: AI link: {self._link_text()}")
        else: self._log.append_log("SYS: Settings saved.")
        if voice_was and not d["voice_on"]: self._stop_speaking()
        if d["voice_on"]: self._ensure_voice()
        self._style_voice(); self._refresh_link(); self._apply_talk_key()
        if self._state in ("READY","STANDBY","INITIALISING"): self._apply_state(self._idle_state())
        if self._server_ok is not True: self._fetch_providers()
    def _on_forgot(self):
        self._cancel_request(); self._stop_speaking(); self._clear_photo()
        self.cfg.reset(); self._history=[]; self._answers_in_chat=0
        self._log.clear_log(); self._log.append_log("SYS: This PC was forgotten: memories, chats and keys are gone.")
        self.hud.set_caption(""); self._refresh_link(); self._style_voice(); self._apply_talk_key()
        self._apply_state("STANDBY"); self._show_setup(first_run=True)

    # ── typing ──
    def _send(self):
        txt=self._input.text().strip()
        if not txt and self._photo: txt="What's in this photo?"
        if not txt: return
        if not self.cfg.has_access():
            self._log.append_log("SYS: Link an AI first: pick one and paste its key."); self._show_setup(first_run=True); return
        self._input.clear(); self._log.append_log(f"You: {'📷 ' if self._photo else ''}{txt}")
        self._ask({"text":txt[:4000]},typed=txt)

    # ── asking EDITH ──
    def _options(self):
        return {"chatId":self.cfg.data["chat_id"],"style":self.cfg.data["style"],"instructions":"","specialist":"general",
                "translateTo":"","can":[],"surface":"desktop"}
    def _ask(self,payload,typed=""):
        self._cancel_request(superseded=True); self._stop_speaking()
        if not clean_chat_id(self.cfg.data["chat_id"]): self.cfg.data["chat_id"]=new_chat_id()
        if self._photo: payload=dict(payload,image={"mime":"image/jpeg","data":self._photo["data"]}); self._clear_photo()
        self._req_token+=1; token=self._req_token; cancel=CancelToken(); self._cancel=cancel
        self._you=None if typed else self._log.begin_live("You: ")
        self._live=self._log.begin_live("EDITH: "); self._answer=""
        self._apply_state("THINKING")
        self.hud.set_caption(f"» {typed}" if typed else "◆ Listening back…")
        options=self._options(); history=list(self._history); api=self.api
        def on_event(ev): self.ui(functools.partial(self._stream_event,token,ev))
        def work():
            try:
                reply=api.chat(payload,history,options,on_event,cancel)
                self.ui(functools.partial(self._answered,token,reply,typed,options))
            except ApiError as e:
                self.ui(functools.partial(self._failed,token,e))
            except Exception as e:
                self.ui(functools.partial(self._failed,token,ApiError("server",f"Something went wrong ({type(e).__name__}).")))
        threading.Thread(target=work,daemon=True).start()
    def _stream_event(self,token,ev):
        if token!=self._req_token: return
        kind=ev.get("type")
        if kind=="transcript":
            text=str(ev.get("text") or "")
            if self._you is not None: self._you.finish(text); self._you=None
            if not self._answer: self.hud.set_caption(f"» {text}")
        elif kind=="delta":
            delta=str(ev.get("text") or "")
            if not delta: return
            if not self._answer: self._apply_state("ANSWERING")
            self._answer+=delta; self._live.append(delta); self.hud.set_caption(self._answer)
        elif kind=="reset":
            self._answer=""; self._live.reset()
        elif kind=="tool":
            names=[str(n) for n in ev.get("names") or []]
            shown=next((TOOL_CAPTIONS[n] for n in names if n in TOOL_CAPTIONS),None)
            if shown and not self._answer: self.hud.set_caption(shown)
        elif kind=="status":
            if ev.get("stage")=="transcribing" and not self._answer: self.hud.set_caption("◆ Listening back…")
    def _answered(self,token,reply,typed,options):
        if token!=self._req_token: return
        self._cancel=None
        said=reply["userText"] or typed
        if self._you is not None: self._you.finish(said or "(voice message)"); self._you=None
        if reply["ownerToken"]:
            self._live.discard(); self._log.append_log("SYS: Owner features aren't part of the PC app.")
            self._apply_state(self._idle_state()); self.hud.set_caption(""); return
        text=reply["reply"].strip() or "…"
        self._live.finish(text); self._answer=text
        self._history=clean_history(reply["history"])
        self._answers_in_chat+=1; self.cfg.data["chat_used"]=int(time.time())
        if reply["chatId"] and clean_chat_id(reply["chatId"]): self.cfg.data["chat_id"]=reply["chatId"]
        self._save()
        if self._server_ok is not True: self._server_ok=True; self._refresh_link()
        self.hud.set_caption(text); self._apply_state(self._idle_state())
        if not self._speak(text,token): self.hud.fade_caption(min(25,8+len(text)*0.06))
    def _failed(self,token,err):
        if token!=self._req_token: return
        self._cancel=None
        if self._live is not None: self._live.discard()
        if self._you is not None: self._you.finish("(voice message)"); self._you=None
        self._apply_state(self._idle_state()); self.hud.set_caption("")
        if err.kind=="cancelled": return
        msg=err.message.replace(" on your phone","").strip()
        if err.kind=="unclear": self._log.append_log("SYS: Didn't catch that. Hold SPACE and try again."); return
        if err.kind=="setup": self._log.append_log(f"ERR: {msg}"); self._log.append_log("SYS: Open settings to check your AI key."); return
        if err.kind=="voice": self._log.append_log(f"ERR: {msg}"); self._log.append_log("SYS: Add a voice key in settings (Groq's is free), or type instead."); return
        if err.kind=="offline": self._server_ok=False; self._refresh_link()
        self._log.append_log(f"ERR: {msg}")
    def _cancel_request(self,superseded=False):
        cancel,self._cancel=self._cancel,None
        if cancel is None: return
        cancel.cancel(); self._req_token+=1
        if self._you is not None: self._you.finish("(voice message)"); self._you=None
        if self._live is not None:
            if self._answer: self._live.finish(self._answer+" …")
            else: self._live.discard()
        self._live=None; self._answer=""

    # ── voice in: hold to talk ──
    def _space_ok(self):
        if QApplication.activeModalWidget() is not None or QApplication.activePopupWidget() is not None: return False
        if QApplication.activeWindow() is not self: return False
        if self._overlay is not None and self._overlay.isVisible(): return False
        fw=QApplication.focusWidget()
        if isinstance(fw,(QLineEdit,QComboBox)): return False
        if isinstance(fw,QTextEdit) and not fw.isReadOnly(): return False
        return True
    def eventFilter(self,obj,ev):
        t=ev.type()
        if t in (QEvent.Type.KeyPress,QEvent.Type.KeyRelease):
            key=ev.key()
            if key==Qt.Key.Key_Space:
                if t==QEvent.Type.KeyPress:
                    if ev.isAutoRepeat(): return self._space_rec
                    if self._space_ok(): self._space_rec=True; self._talk_down(); return True
                else:
                    if ev.isAutoRepeat(): return self._space_rec
                    if self._space_rec: self._space_rec=False; self._talk_up(); return True
            elif key==Qt.Key.Key_Escape and t==QEvent.Type.KeyPress and QApplication.focusWidget() is self._input:
                self._input.clearFocus(); self.hud.setFocus(); return True
        return False
    def _app_state(self,state):
        if state!=Qt.ApplicationState.ApplicationActive and self._space_rec:
            self._space_rec=False; self._talk_up()
    def _talk_down(self):
        if self._recording: return
        if not self.cfg.has_access():
            self._log.append_log("SYS: Link an AI first: pick one and paste its key."); self._show_setup(first_run=True); return
        if not self.cfg.access()["voice_provider"]:
            label,_,_=self._link_parts()
            self._log.append_log(f"SYS: {label} can't hear. Add a voice key in settings (Groq's is free), or type instead."); return
        if self._mic_ok is False or sd is None or np is None:
            self._probe_mic(user=True); return
        self._stop_speaking()
        try: self._recorder.start()
        except Exception:
            self._mic_ok=False; self._style_talk(); self._refresh_link()
            self._log.append_log("SYS: The microphone wouldn't start. Typing works; check it and try again."); return
        self._recording=True; self._rec_tmr.start(250); self._style_talk(); self._apply_state("LISTENING")
        self.hud.set_caption("")
    def _rec_tick(self):
        if not self._recording: self._rec_tmr.stop(); return
        if time.time()-self._recorder.started>=MAX_RECORD_S: self._talk_up(); return
        self._style_talk()
    def _talk_up(self):
        if not self._recording: return
        self._recording=False; self._rec_tmr.stop(); held=time.time()-self._recorder.started
        samples=self._recorder.stop(); self._style_talk()
        if samples is None or held<0.4 or len(samples)<self._recorder.RATE*0.3:
            self._apply_state(self._idle_state()); self._log.append_log("SYS: Hold SPACE (or HOLD TO TALK) while you speak, then let go."); return
        if int(np.abs(samples).max())<200:
            self._apply_state(self._idle_state()); self._log.append_log("SYS: I couldn't hear anything. Check your microphone."); return
        data=base64.b64encode(wav_bytes(samples)).decode("ascii")
        self._ask({"audio":{"mime":"audio/wav","data":data}})
    def _apply_talk_key(self):
        want=bool(self.cfg.data["global_ptt"]) and not self.demo and GlobalTalkKey.available()
        if want and self._talk_key is None:
            try:
                k=GlobalTalkKey(self); k.pressed.connect(self._global_down); k.released.connect(self._global_up); k.start(); self._talk_key=k
                self._log.append_log("SYS: Hold Right Ctrl in any app to talk to EDITH.")
            except Exception:
                self._talk_key=None; self._log.append_log("SYS: Talking from other apps isn't available on this PC.")
        elif not want and self._talk_key is not None:
            self._talk_key.stop(); self._talk_key=None
    def _global_down(self):
        if self._overlay is None and QApplication.activeModalWidget() is None: self._talk_down()
    def _global_up(self):
        self._talk_up()

    # ── voice out ──
    def _toggle_voice(self):
        d=self.cfg.data; d["voice_on"]=not d["voice_on"]; self._save(); self._style_voice(); self._refresh_link()
        if d["voice_on"]: self._log.append_log("SYS: Voice replies on."); self._ensure_voice()
        else: self._stop_speaking(); self._log.append_log("SYS: Voice replies off.")
        if self._state in ("READY","STANDBY"): self._apply_state(self._state)
    def _ensure_voice(self):
        if voice_module_ready(): return True
        if self._voice_installing or self._voice_install_failed or self.demo: return False
        if os.environ.get("EDITH_NO_INSTALL")=="1":
            self._voice_install_failed=True; self._log.append_log("SYS: The voice (edge-tts) isn't installed, so answers stay text only."); return False
        self._voice_installing=True; self._log.append_log("SYS: Installing EDITH's voice (edge-tts), one moment…")
        def work():
            ok=pip_install(["edge-tts"],quiet=True) and voice_module_ready()
            self.ui(lambda: self._voice_installed(ok))
        threading.Thread(target=work,daemon=True).start(); return False
    def _voice_installed(self,ok):
        self._voice_installing=False
        if ok: self._log.append_log("SYS: Voice ready.")
        else: self._voice_install_failed=True; self._log.append_log("SYS: Couldn't install the voice (edge-tts), so answers stay text only.")
    def _speak(self,text,token):
        if not self.cfg.data["voice_on"] or self.demo: return False
        clean=speech_text(text)
        if not clean or not self._ensure_voice(): return False
        voice=self.cfg.data["voice_name"]; self._speak_token=token
        def work():
            path=None
            try:
                import edge_tts
                fd,path=tempfile.mkstemp(prefix="edith_voice_",suffix=".mp3"); os.close(fd)
                async def synth(): await edge_tts.Communicate(clean,voice).save(path)
                asyncio.run(synth())
                if os.path.getsize(path)<200: raise RuntimeError("no audio")
                self.ui(lambda: self._play(path,token))
            except Exception:
                if path:
                    try: os.remove(path)
                    except OSError: pass
                self.ui(lambda: self._voice_unavailable(token))
        threading.Thread(target=work,daemon=True).start(); return True
    def _voice_unavailable(self,token):
        if token==self._req_token: self.hud.fade_caption(10)
        if not self._voice_warned:
            self._voice_warned=True; self._log.append_log("SYS: The voice service can't be reached, so answers stay text only for now.")
    def _play(self,path,token):
        if token!=self._req_token or token!=self._speak_token or not self.cfg.data["voice_on"]:
            self._remove_file(path); return
        if self._player is None:
            try:
                from PyQt6.QtMultimedia import QAudioOutput,QMediaPlayer
                self._player=QMediaPlayer(self); self._audio_out=QAudioOutput(self); self._audio_out.setVolume(1.0)
                self._player.setAudioOutput(self._audio_out); self._player.mediaStatusChanged.connect(self._media_status)
                self._player.errorOccurred.connect(lambda *_: self._speech_ended(failed=True))
            except Exception:
                self._player=None; self._remove_file(path); self._voice_unavailable(token); return
        self._stop_player(); self._voice_path=path; self._voice_warned=False
        self._player.setSource(QUrl.fromLocalFile(path)); self._player.play(); self._apply_state("SPEAKING")
    def _media_status(self,status):
        from PyQt6.QtMultimedia import QMediaPlayer
        if status in (QMediaPlayer.MediaStatus.EndOfMedia,QMediaPlayer.MediaStatus.InvalidMedia): self._speech_ended()
    def _speech_ended(self,failed=False):
        self._stop_player()
        if self._state=="SPEAKING": self._apply_state(self._idle_state()); self.hud.fade_caption(6)
    def _stop_player(self):
        if self._player is not None:
            try: self._player.stop(); self._player.setSource(QUrl())
            except Exception: pass
        path,self._voice_path=self._voice_path,None
        if path: self._remove_file(path)
    def _stop_speaking(self):
        self._speak_token+=1; self._stop_player()
        if self._state=="SPEAKING": self._apply_state(self._idle_state())
    @staticmethod
    def _remove_file(path):
        try: os.remove(path)
        except OSError: pass

    # ── photos ──
    def _upload_photo(self):
        path,_=QFileDialog.getOpenFileName(self,"Choose a photo","","Images (*.png *.jpg *.jpeg *.gif *.bmp *.webp);;All files (*)")
        if path: self._attach_file(path)
    def _attach_file(self,path):
        fp=Path(path); name=fp.name
        try: size=fp.stat().st_size
        except OSError: self._photo_error(f"⚠ Can't open {name}"); return
        if size>40*1024*1024: self._photo_error(f"⚠ {name} is too large (>40MB)"); return
        try: data=shrink_image(QImage(str(fp)))
        except ValueError: self._photo_error(f"⚠ {name} is not a photo EDITH can read"); return
        self._attach(data,name)
    def _attach(self,data,name):
        self._photo={"data":data,"name":name}
        self._photo_label.setText(f"📷 {name}  ({len(data)*3/4/1024:.0f} KB) → attached")
        self._photo_label.setStyleSheet(f"color:{C.GREEN};background:transparent;")
        self._log.append_log("SYS: Photo attached. Ask about it, or press ▸ to have it described.")
    def _photo_error(self,text):
        self._photo=None; self._photo_label.setText(text); self._photo_label.setStyleSheet(f"color:{C.RED};background:transparent;")
    def _clear_photo(self):
        self._photo=None; self._photo_label.setText("No photo loaded"); self._photo_label.setStyleSheet(f"color:{C.TEXT_DIM};background:transparent;")
    def _screenshot_screen(self):
        self.setWindowOpacity(0.0); QTimer.singleShot(300,self._grab_screen)
    def _grab_screen(self):
        try:
            scr=self.screen() or QGuiApplication.primaryScreen(); shot=scr.grabWindow(0) if scr else None
        finally: self.setWindowOpacity(1.0)
        try: data=shrink_image(shot.toImage() if shot is not None and not shot.isNull() else None)
        except ValueError: self._photo_error("⚠ Couldn't capture the screen"); return
        self._attach(data,"screenshot")
    def dragEnterEvent(self,e):
        if e.mimeData().hasUrls() and any(u.isLocalFile() for u in e.mimeData().urls()): e.acceptProposedAction()
    def dropEvent(self,e):
        for u in e.mimeData().urls():
            if u.isLocalFile(): self._attach_file(u.toLocalFile()); break

    # ── saved chats ──
    def _show_chats(self):
        if not self.cfg.has_access(): self._log.append_log("SYS: Link an AI first: your chats appear once you've asked something."); return
        ChatsDialog(self).exec()
    def _open_chat(self,cid):
        api=self.api; self._log.append_log("SYS: Opening chat…")
        def work():
            try: chat=api.open_chat(cid); self.ui(lambda: self._opened(cid,chat))
            except ApiError as e: msg=e.message; self.ui(lambda: self._log.append_log(f"ERR: Couldn't open that chat ({msg})."))
        threading.Thread(target=work,daemon=True).start()
    def _opened(self,cid,chat):
        if chat is None: self._log.append_log("ERR: That chat no longer exists."); return
        self._cancel_request(); self._stop_speaking()
        d=self.cfg.data; d["chat_id"]=cid; d["chat_used"]=int(time.time()); self._save()
        msgs=chat["messages"]
        self._history=clean_history([{"role":"user" if m.get("role")=="user" else "model","parts":[{"text":m["content"]}]} for m in msgs])
        self._answers_in_chat=sum(1 for m in msgs if m.get("role")!="user")
        self._log.clear_log()
        self._log.append_now([("You: " if m.get("role")=="user" else "EDITH: ")+" ".join(m["content"].split()) for m in msgs[-CHAT_SHOWN:]])
        self._log.append_log(f"SYS: Opened “{(chat['title'] or 'untitled')[:48]}”.")
        self.hud.set_caption(""); self._apply_state(self._idle_state())
    def _new_chat(self,quiet=False):
        self._cancel_request(); self._stop_speaking()
        d=self.cfg.data
        if not (clean_chat_id(d["chat_id"]) and self._answers_in_chat==0): d["chat_id"]=new_chat_id()
        self._history=[]; self._answers_in_chat=0; self._save(); self.hud.set_caption("")
        if not quiet: self._log.clear_log(); self._log.append_log("SYS: New chat started.")
        self._apply_state(self._idle_state())
    def _chat_deleted(self,cid):
        if cid==self.cfg.data["chat_id"]: self.cfg.data["chat_id"]=""; self._answers_in_chat=0; self._new_chat(quiet=True)

    def closeEvent(self,e):
        self._cancel_request(); self._stop_speaking()
        if self._recording: self._recording=False; self._recorder.stop()
        if self._talk_key is not None: self._talk_key.stop()
        super().closeEvent(e)

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  APP                                                                     ║
# ╚══════════════════════════════════════════════════════════════════════════╝
def _offscreen_fonts():
    # Qt's offscreen platform has no fonts of its own on Windows: point it at the system's.
    if os.environ.get("QT_QPA_PLATFORM","").startswith("offscreen") and not os.environ.get("QT_QPA_FONTDIR") and sys.platform=="win32":
        fonts=os.path.join(os.environ.get("WINDIR",r"C:\Windows"),"Fonts")
        if os.path.isdir(fonts): os.environ["QT_QPA_FONTDIR"]=fonts

def make_app():
    _offscreen_fonts()
    os.environ.setdefault("QT_LOGGING_RULES","qt.multimedia*=false")  # keeps the console quiet while EDITH speaks
    app=QApplication.instance() or QApplication(sys.argv[:1])
    app.setStyle("Fusion"); app.setApplicationName("EDITH"); app.setApplicationDisplayName("E.D.I.T.H")
    QFont.insertSubstitutions("Courier New",["Consolas","Menlo","DejaVu Sans Mono","Liberation Mono","Noto Sans Mono"])
    return app

def _pump(app,seconds):
    end=time.time()+seconds
    while time.time()<end: app.processEvents(); time.sleep(0.004)

def run_screenshot(path,setup=False):
    """Renders the window (offscreen-friendly) with demo content and saves it. Nothing is sent or saved."""
    app=make_app(); cfg=Config(None)
    if not setup:
        cfg.data.update({"provider":"gemini","chat_id":new_chat_id(),
                         "keys":{"gemini":{"key":"demo-not-a-key","model":"gemini-3.8-flash","base":"","label":"Google Gemini","voice":True}}})
    win=MainWindow(cfg,demo=True); win.resize(1280,800); win.show(); win._mic_ok=True; win._server_ok=True
    win._style_talk(); win._refresh_link()
    if setup:
        for line in ["SYS: E.D.I.T.H online.","SYS: No AI linked yet. Pick one and paste its key to begin.","SYS: Hold SPACE to talk, or type below."]:
            win._log.append_log(line)
        win._apply_state("STANDBY"); win._show_setup(first_run=True)
    else:
        for line in ["SYS: E.D.I.T.H online.",f"SYS: AI link: {win._link_text()}","SYS: Hold SPACE to talk, or type below.","You: what's the weather in Dubai?"]:
            win._log.append_log(line)
        live=win._log.begin_live("EDITH: ")
        answer="It's 36°C and clear in Dubai right now. Humidity is low, so it feels close to the real temperature; tonight it drops to 29°C."
        live.append(answer); win._answer=answer; win._apply_state("ANSWERING"); win.hud.set_caption(answer)
    _pump(app,3.2)
    ok=win.grab().save(path); print(("saved " if ok else "could not save ")+path)
    return 0 if ok else 1

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  SELF TEST  (python edith.py --selftest)                                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
def _mock_server():
    """A local stand-in for EDITH's server that speaks the same NDJSON protocol."""
    from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        protocol_version="HTTP/1.1"
        def log_message(self,*a): pass
        def _body(self):
            n=int(self.headers.get("Content-Length") or 0); return self.rfile.read(n) if n else b""
        def _json(self,status,obj):
            data=json.dumps(obj).encode(); self.send_response(status); self.send_header("Content-Type","application/json")
            self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data)
        def _chunk(self,b):
            self.wfile.write(f"{len(b):x}\r\n".encode()+b+b"\r\n"); self.wfile.flush()
        def do_GET(self):
            self.server.seen.append(("GET",self.path,dict(self.headers),None))
            if self.path=="/api/providers": self._json(200,{"providers":FALLBACK_PROVIDERS,"owner":False})
            elif self.path=="/api/chats": self._json(200,{"chats":[{"id":"cmock0000001","title":"Weather in Dubai","specialist":"general","updated":int(time.time()*1000),"count":2}]})
            elif self.path.startswith("/api/chats/"):
                if self.path.endswith("cmock0000001"): self._json(200,{"chat":{"id":"cmock0000001","title":"Weather in Dubai","messages":[{"role":"user","content":"weather?"},{"role":"model","content":"Sunny."}]}})
                else: self._json(404,{"error":"No such chat."})
            else: self._json(404,{"error":"Not found."})
        def do_DELETE(self):
            self.server.seen.append(("DELETE",self.path,dict(self.headers),None)); self._json(200,{"ok":True})
        def do_POST(self):
            raw=self._body(); self.server.seen.append(("POST",self.path,dict(self.headers),raw))
            if self.path=="/api/check-key":
                ok=self.headers.get("X-AI-Key")=="test-key-123"
                return self._json(200,{"ok":True,"models":FALLBACK_PROVIDERS[0]["models"],"defaultModel":"auto"} if ok else {"ok":False,"code":"rejected","error":"Google Gemini rejected this key."})
            if self.path=="/api/chats/search": return self._json(200,{"chats":[]})
            if self.path!="/api/chat": return self._json(404,{"error":"Not found."})
            body=json.loads(raw or b"{}"); text=body.get("text","")
            if text=="needs key": return self._json(401,{"error":"EDITH needs an AI key. Add one in EDITH's settings on your phone.","needsKey":True,"kind":"key"})
            if text=="flaky" and self.server.flaky>0:
                self.server.flaky-=1; data=b"busy"; self.send_response(503); self.send_header("Content-Type","text/plain")
                self.send_header("Content-Length",str(len(data))); self.end_headers(); self.wfile.write(data); return
            self.send_response(200); self.send_header("Content-Type","application/x-ndjson; charset=utf-8")
            self.send_header("Transfer-Encoding","chunked"); self.end_headers()
            line=lambda o: (json.dumps(o,ensure_ascii=False)+"\n").encode("utf-8")
            heard=""
            if body.get("audio"): heard="what's the weather"; self._chunk(line({"type":"status","stage":"transcribing"})+line({"type":"transcript","text":heard}))
            self._chunk(line({"type":"status","stage":"thinking"})); time.sleep(0.05)
            self._chunk(line({"type":"delta","text":"Hel"})); time.sleep(0.05)
            self._chunk(line({"type":"delta","text":"lo wor"})[:-3]); time.sleep(0.05)   # a line split across chunks
            rest=line({"type":"delta","text":"lo wor"})[-3:]
            tricky=line({"type":"delta","text":"ld ☀ é"}); cut=tricky.index("☀".encode())+1   # split inside a UTF-8 character
            self._chunk(rest+tricky[:cut]); time.sleep(0.05); self._chunk(tricky[cut:]+b"not json\n\n"+line({"type":"ping"}))
            if text=="mid error":
                self._chunk(line({"type":"error","error":"Your quota ran out.","kind":"quota"}))
            else:
                said=text or heard; prior=body.get("history") or []
                self._chunk(line({"type":"done","reply":"Hello world ☀ é","userText":said,"toolsUsed":[],"model":"mock",
                                  "chatId":body.get("chatId"),"history":prior+[{"role":"user","parts":[{"text":said}]},{"role":"model","parts":[{"text":"Hello world ☀ é"}]}]}))
            self._chunk(b"")

    srv=ThreadingHTTPServer(("127.0.0.1",0),Handler); srv.seen=[]; srv.flaky=0; srv.daemon_threads=True
    srv.handle_error=lambda *a: None  # a client closing a kept-alive connection is not news
    threading.Thread(target=srv.serve_forever,daemon=True).start()
    return srv

def selftest():
    import contextlib
    os.environ.setdefault("QT_QPA_PLATFORM","offscreen"); _offscreen_fonts()
    app=QGuiApplication.instance() or QGuiApplication(sys.argv[:1])  # kept alive for the whole test
    results=[]
    def check(name,fn):
        try: fn(); results.append((name,True,"")); print(f"PASS  {name}")
        except Exception as e: results.append((name,False,str(e))); print(f"FAIL  {name}: {type(e).__name__}: {e}")
    def expect(cond,msg="unexpected result"):
        if not cond: raise AssertionError(msg)

    def t_wav():
        expect(np is not None,"numpy is missing")
        x=(np.sin(np.arange(8000)*2*math.pi*440/16000)*8000).astype(np.int16)
        b=wav_bytes(x); expect(b[:4]==b"RIFF" and b[8:12]==b"WAVE","not a WAV header")
        with wave.open(io.BytesIO(base64.b64decode(base64.b64encode(b)))) as w:
            expect((w.getnchannels(),w.getsampwidth(),w.getframerate(),w.getnframes())==(1,2,16000,8000),"wrong WAV format")
            expect(np.array_equal(np.frombuffer(w.readframes(8000),dtype="<i2"),x),"samples changed")
        y=_resample(np.arange(0,44100,dtype=np.int16)%1000,44100,16000); expect(abs(len(y)-16000)<=1,"resample length")
    def t_ndjson():
        events=[{"type":"delta","text":"héllo 🌍 ☀"},{"type":"tool","names":["web_search"]},{"type":"done","reply":"x"}]
        blob=b"".join((json.dumps(e,ensure_ascii=False)+"\n").encode() for e in events)+b"\n{broken\n"
        for cut in range(1,len(blob)):
            r=NdjsonReader(); got=r.feed(blob[:cut])+r.feed(blob[cut:])+r.end(); expect(got==events,f"split at {cut}")
        r=NdjsonReader(); got=[]
        for i in range(len(blob)): got+=r.feed(blob[i:i+1])
        expect(got+r.end()==events,"byte by byte")
        r=NdjsonReader(); expect(r.feed(b'{"type":"done"}')==[] and r.end()==[{"type":"done"}],"last line without newline")
    def t_failure_map():
        expect(failure(401,{"error":"x"}).kind=="setup"); expect(failure(400,{"error":"x","needsVoiceKey":True}).kind=="voice")
        expect(failure(502,{"error":"Quota exceeded"}).kind=="quota"); expect(failure(422,{"kind":"unclear"}).kind=="unclear")
        expect(failure(504,{"kind":"timeout"}).kind=="offline"); expect(failure(500,{}).kind=="server")
    def t_ids_time():
        expect(_DEVICE_RE.match(new_device_id()) is not None,"device id"); expect(clean_chat_id(new_chat_id())!="","chat id")
        expect(clean_chat_id("../etc")=="","bad chat id accepted")
        expect(re.fullmatch(r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} [A-Z][a-z]+ \d{4} at \d\d:\d\d( \(.+\))?",local_time()) is not None,local_time())
        expect(normalise_server("https://edith.starktech.workers.dev/api/")==DEFAULT_SERVER,"server normalise")
        for bad in ("http://example.com","ftp://x","javascript:alert(1)",""):
            with contextlib.suppress(ValueError): normalise_server(bad); raise AssertionError(f"accepted {bad!r}")
    def t_mock_round_trip():
        srv=_mock_server(); url=f"http://127.0.0.1:{srv.server_address[1]}"
        try:
            cfg=Config(None); cfg.data.update({"provider":"gemini","language":"de","chat_id":"cselftest0001",
                "keys":{"gemini":{"key":"test-key-123","model":"auto","base":"","label":"Google Gemini","voice":True}}})
            api=EdithApi(url,cfg)
            expect(len(api.providers())==len(FALLBACK_PROVIDERS),"providers")
            expect(api.check_key("gemini","test-key-123")["ok"],"good key refused"); bad=api.check_key("gemini","nope-nope-nope")
            expect(not bad["ok"] and "rejected" in bad["error"],"bad key accepted")
            seen=[]; history=[{"role":"user","parts":[{"text":f"q{i}"}]} for i in range(30)]
            opts={"chatId":"cselftest0001","style":"short","instructions":"","specialist":"general","translateTo":"","can":[],"surface":"desktop"}
            reply=api.chat({"text":"hi there"},history,opts,seen.append)
            deltas="".join(e["text"] for e in seen if e["type"]=="delta")
            expect(deltas=="Hello world ☀ é",f"deltas {deltas!r}"); expect(reply["reply"]=="Hello world ☀ é","reply")
            expect(len(reply["history"])==22 and reply["chatId"]=="cselftest0001","done event")
            m,path,h,raw=[s for s in srv.seen if s[1]=="/api/chat"][-1]; body=json.loads(raw)
            expect(h.get("X-Device-Id")==cfg.data["device_id"] and h.get("X-AI-Key")=="test-key-123" and h.get("X-AI-Provider")=="gemini","headers")
            expect(h.get("X-AI-Model")=="auto" and h.get("X-Edith-Language")=="de" and h.get("X-Voice-Provider")=="gemini","more headers")
            expect("ndjson" in h.get("Accept",""),"accept header")
            expect(body["surface"]=="desktop" and body["can"]==[] and body["style"]=="short" and body["chatId"]=="cselftest0001","body options")
            expect(len(body["history"])==20 and body["history"][-1]["parts"][0]["text"]=="q29" and body["text"]=="hi there","body history")
            expect(isinstance(body.get("localTime"),str) and " at " in body["localTime"],"localTime")
            expect("test-key-123" not in path and "test-key-123" not in raw.decode(),"key outside headers")
            seen=[]; reply=api.chat({"audio":{"mime":"audio/wav","data":base64.b64encode(wav_bytes(np.zeros(1600,dtype=np.int16))).decode()}},[],opts,seen.append)
            expect(any(e["type"]=="transcript" and e["text"]=="what's the weather" for e in seen) and reply["userText"]=="what's the weather","voice transcript")
            srv.flaky=1; t0=time.time(); reply=api.chat({"text":"flaky"},[],opts)
            expect(reply["reply"]=="Hello world ☀ é" and time.time()-t0>=1.0,"no retry after 503")
            try: api.chat({"text":"needs key"},[],opts); raise AssertionError("no error for 401")
            except ApiError as e: expect(e.kind=="setup","401 kind "+e.kind)
            try: api.chat({"text":"mid error"},[],opts); raise AssertionError("no error for a streamed error")
            except ApiError as e: expect(e.kind=="quota","stream error kind "+e.kind)
            tok=CancelToken(); tok.cancel()
            try: api.chat({"text":"hi"},[],opts,None,tok); raise AssertionError("cancel ignored")
            except ApiError as e: expect(e.kind=="cancelled","cancel kind")
            expect(api.chats()[0]["id"]=="cmock0000001" and api.open_chat("cmock0000001")["title"]=="Weather in Dubai","chats")
            expect(api.open_chat("cmissing0001") is None,"missing chat")
            api.forget(); expect([s[1] for s in srv.seen if s[0]=="DELETE"][-4:]==["/api/memory","/api/history","/api/chats","/api/lists"],"forget")
        finally:
            srv.shutdown()
    def t_config():
        tmp=tempfile.mkdtemp(prefix="edith_selftest_"); old={k:os.environ.get(k) for k in ("HOME","USERPROFILE")}
        try:
            os.environ["HOME"]=tmp; os.environ["USERPROFILE"]=tmp
            path=Config.default_path(); expect(str(path).startswith(tmp),f"config not in temp home: {path}")
            c=Config(path); c.data.update({"provider":"groq","style":"detailed","voice_on":False,
                "keys":{"groq":{"key":"gsk_secret_value","model":"openai/gpt-oss-120b","base":"","label":"Groq","voice":True}}}); c.save()
            c2=Config(path)
            expect(c2.data["keys"]["groq"]["key"]=="gsk_secret_value" and c2.data["style"]=="detailed" and c2.data["voice_on"] is False,"round trip")
            expect(c2.data["device_id"]==c.data["device_id"] and c2.has_access(),"device id / access")
            if os.name=="posix": expect((path.stat().st_mode & 0o777)==0o600,"permissions")
            path.write_text("{not json",encoding="utf-8"); buf=io.StringIO()
            with contextlib.redirect_stdout(buf): c3=Config(path)
            expect(not c3.has_access() and "gsk_secret_value" not in buf.getvalue(),"corrupt file")
            c2.reset(); expect(not path.exists() and not c2.has_access(),"reset")
        finally:
            for k,v in old.items():
                if v is None: os.environ.pop(k,None)
                else: os.environ[k]=v
            shutil.rmtree(tmp,ignore_errors=True)
    def t_image():
        img=QImage(3000,2000,QImage.Format.Format_ARGB32); img.fill(QColor(200,150,40,128))
        b64=shrink_image(img); out=QImage(); out.loadFromData(base64.b64decode(b64),"JPEG")
        expect(not out.isNull() and max(out.width(),out.height())==1024 and len(b64)<=MAX_IMAGE_B64,"photo shrink")
        expect(app is not None,"no Qt application")
    def t_text():
        from PyQt6.QtGui import QFont as _F
        lines=wrap_text("one two three four five six seven eight nine ten",QFontMetrics(_F("Courier New",10)),80)
        expect(len(lines)>2 and all(lines),"wrap"); expect(speech_text("**Hi** see https://x.y/z\n- one")=="Hi see link one","speech text")
        expect(clean_history([{"role":"assistant","parts":[{"text":"a"}]},{"role":"x","parts":[]},"junk"])==[{"role":"model","parts":[{"text":"a"}]}],"history clean")

    check("wav encoding",t_wav); check("ndjson parsing (split lines and characters)",t_ndjson); check("error mapping",t_failure_map)
    check("ids, local time, server address",t_ids_time); check("photo shrinking",t_image); check("text helpers",t_text)
    check("mock server round trip",t_mock_round_trip); check("config round trip in a temp home",t_config)
    failed=[r for r in results if not r[1]]
    print(f"\n{len(results)-len(failed)}/{len(results)} passed"); return 1 if failed else 0

# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  MAIN                                                                    ║
# ╚══════════════════════════════════════════════════════════════════════════╝
def main(argv=None):
    import argparse
    ap=argparse.ArgumentParser(prog="edith",description="E.D.I.T.H · PC edition: talk to any AI.")
    ap.add_argument("--selftest",action="store_true",help="check EDITH without opening a window (exit 0 = all good)")
    ap.add_argument("--server",metavar="URL",help="use another EDITH server for this run")
    ap.add_argument("--reset",action="store_true",help="forget this PC's EDITH settings and keys")
    ap.add_argument("--screenshot",metavar="PATH",help="save a picture of the main window and exit")
    ap.add_argument("--screenshot-setup",metavar="PATH",help="save a picture of the setup screen and exit")
    args=ap.parse_args(argv)
    for stream in (sys.stdout,sys.stderr):
        try: stream.reconfigure(errors="replace")  # a console that can't show a character still works
        except Exception: pass
    if args.selftest: return selftest()
    if args.reset:
        path=Config.default_path(); existed=path.exists(); Config(path).reset()
        print("EDITH's settings and keys on this PC were removed." if existed else "EDITH had no settings on this PC.")
        print("Memories and saved chats on the server stay until you use FORGET THIS PC in EDITH's settings."); return 0
    if args.screenshot: return run_screenshot(args.screenshot)
    if args.screenshot_setup: return run_screenshot(args.screenshot_setup,setup=True)
    override=""
    if args.server:
        try: override=normalise_server(args.server)
        except ValueError as e: print(f"--server: {e}"); return 2
    app=make_app(); win=MainWindow(Config(Config.default_path()),server_override=override); win.show()
    return app.exec()

if __name__=="__main__":
    sys.exit(main())
