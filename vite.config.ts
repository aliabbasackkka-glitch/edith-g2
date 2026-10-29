import { cpSync, existsSync, readFileSync } from 'node:fs'
import { defineConfig, loadEnv, type Plugin } from 'vite'

// The website's own files (the About page, sitemap, robots.txt, llms.txt, icons, share card,
// _headers) sit in site-public/ and are copied into the site build only: they link to GitHub,
// YouTube and Discord, and Even Hub turns down a package that mentions addresses its whitelist
// doesn't cover.
const siteFiles = (packaged: boolean): Plugin => ({
  name: 'edith-site-files',
  apply: 'build',
  closeBundle() {
    if (!packaged && existsSync('site-public')) cpSync('site-public', 'dist', { recursive: true })
  },
})

// The version testers see in the Even app, so Settings can show the same one.
const appVersion = String(JSON.parse(readFileSync('app.json', 'utf8')).version || '')

// EDITH_URL (set in .env.local) is EDITH's server, e.g. https://edith.example.workers.dev
//  - npm run dev:     the app calls /api and Vite proxies it to EDITH_URL.
//  - npm run build:   the site build; the app and its API share an origin, so it calls /api.
//                     It also builds the sign-in and OpenRouter pages (signin.html, connect.html),
//                     which only the site serves.
//  - --mode package:  the .ehpk runs inside the Even app, so it calls EDITH_URL/api directly.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const edithUrl = (env.EDITH_URL || '').trim().replace(/\/+$/, '')
  const packaged = command === 'build' && mode === 'package'

  if (packaged && !edithUrl) {
    throw new Error('EDITH_URL is not set. Add it to .env.local before packaging.')
  }

  return {
    // Relative asset paths inside the .ehpk, so it loads however the Even app serves it.
    base: packaged ? './' : '/',
    plugins: [siteFiles(packaged)],
    server: {
      host: true, // bind to the LAN so the phone can load the dev server
      port: 5173,
      strictPort: true,
      proxy: edithUrl ? { '/api': { target: edithUrl, changeOrigin: true } } : undefined,
    },
    define: {
      __API_BASE__: JSON.stringify(packaged ? `${edithUrl}/api` : '/api'),
      __EDITH_URL__: JSON.stringify(edithUrl),
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    build: {
      target: 'esnext',
      rollupOptions: {
        // The sign-in and OpenRouter pages belong to EDITH's server: never part of the packaged app.
        // web.html is EDITH's website for everyone (served at /web), also never packaged.
        input: packaged
          ? { main: 'index.html' }
          : { main: 'index.html', signin: 'signin.html', connect: 'connect.html', web: 'web.html' },
      },
    },
  }
})
