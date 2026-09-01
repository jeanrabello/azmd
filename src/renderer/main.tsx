import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/app.css'

/*
 * Marca a plataforma antes do primeiro paint.
 *
 * O CSS usa isto para decidir entre fundo transparente (macOS, onde a vibrancy
 * do BrowserWindow pinta atrás) e um sólido (Windows/Linux, sem vibrancy —
 * transparente ali deixaria o popover sem fundo).
 */
if (window.azmd.platform !== 'darwin') {
  document.documentElement.classList.add('platform-other')
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('elemento #root não encontrado')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
