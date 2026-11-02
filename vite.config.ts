// Vite's settings: how `npm run dev` serves the app on your computer, and how
// `npm run build` makes the files Cloudflare serves.
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ command, mode, isPreview }) => {
  // `npm run dev` must never talk to production, so junk data can't land
  // there. Stop if the dev values match the ones in .env.production.
  if (command === 'serve' && !isPreview) {
    const dev = loadEnv(mode, process.cwd(), 'VITE_')
    const production = loadEnv('production', process.cwd(), 'VITE_')
    if (dev.VITE_SUPABASE_URL && dev.VITE_SUPABASE_URL === production.VITE_SUPABASE_URL) {
      throw new Error("npm run dev is pointed at the production project. Put the dev project's values in .env.development.local.")
    }
  }

  return {
    plugins: [react()],
    build: {
      // Remove every console call from the live build, including ones inside
      // packages, so nothing can log bets, keys or tokens there
      // (fmbt-security, section 8).
      rolldownOptions: { output: { minify: { compress: { dropConsole: true } } } },
    },
  }
})
