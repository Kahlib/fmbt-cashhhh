// The app's starting point: load the font and styles, then draw <App /> into <div id="root">.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Archivo is bundled with the app, so nothing loads from Google or any other site.
import '@fontsource-variable/archivo/standard.css'
import './index.css'
import App from './App.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('The page is missing <div id="root">.')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
