/// <reference types="vite/client" />

/** Base URL for API calls: "/api" on the EDITH site and in dev, "<EDITH_URL>/api" in the .ehpk package. */
declare const __API_BASE__: string
/** The EDITH site from EDITH_URL, or "" when unset. */
declare const __EDITH_URL__: string
/** The app version from app.json, shown in Settings so testers can say which build they have. */
declare const __APP_VERSION__: string
