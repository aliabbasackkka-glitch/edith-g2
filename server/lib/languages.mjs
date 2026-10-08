// The languages EDITH speaks. The phone app sends the one picked at setup as
// X-Edith-Language; without it (EDITH 1.2 and older) EDITH answers in whatever
// language the user speaks.
//
// The glasses font has no Arabic letters, so Arabic answers on the glasses are
// written in Latin letters instead. EDITH's website and PC app show Arabic script.

export const LANGUAGES = {
  en: { name: "English", news: "hl=en-US&gl=US&ceid=US:en" },
  de: { name: "German", news: "hl=de&gl=DE&ceid=DE:de" },
  fr: { name: "French", news: "hl=fr&gl=FR&ceid=FR:fr" },
  es: { name: "Spanish", news: "hl=es&gl=ES&ceid=ES:es" },
  it: { name: "Italian", news: "hl=it&gl=IT&ceid=IT:it" },
  zh: { name: "Simplified Chinese", news: "hl=zh-CN&gl=CN&ceid=CN:zh-Hans" },
  ja: { name: "Japanese", news: "hl=ja&gl=JP&ceid=JP:ja" },
  ko: { name: "Korean", news: "hl=ko&gl=KR&ceid=KR:ko" },
  ar: { name: "Arabic", news: "hl=ar&gl=AE&ceid=AE:ar" },
};

/** The language code a request asks for, or "" when it names none EDITH knows. */
export function languageOf(req) {
  const code = String(req.headers.get("x-edith-language") || "").trim().toLowerCase().slice(0, 2);
  return LANGUAGES[code] ? code : "";
}

/**
 * The system prompt's rule for the answer language. onGlasses is false for EDITH's website
 * and PC app, whose screens show Arabic script.
 */
export function languageRule(code, onGlasses = true) {
  if (code === "ar" && !onGlasses) {
    return (
      "LANGUAGE: The user chose Arabic in EDITH's settings. Always reply in Arabic, in Arabic script, even when a " +
      "question or a tool result is in another language, unless the user asks for a different language.\n"
    );
  }
  if (code === "ar") {
    return (
      "LANGUAGE: The user chose Arabic. The glasses cannot show Arabic script, so always reply in Arabic " +
      "written in English letters, the way people text, for example: \"Marhaba! El jaw el yom 36 daraja w mushmes.\" " +
      "Never use Arabic script. Don't use digits in place of letters: write 'a', 'h' or 'kh' instead of 3, 7 or 5. " +
      "Tool results may be in Arabic script or in English; retell them in this style.\n"
    );
  }
  const language = LANGUAGES[code];
  if (!language) return "";
  return (
    `LANGUAGE: The user chose ${language.name} in EDITH's settings. Always reply in ${language.name}, even when a ` +
    "question or a tool result is in another language, unless the user asks for a different language.\n"
  );
}
