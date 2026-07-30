import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '#/App.tsx'
// A stylesheet import is a side effect by definition — it is how Vite is told
// to emit the CSS bundle. `import/no-unassigned-import` is switched off for
// entry files in .oxlintrc.json for exactly this.
import '#/styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
