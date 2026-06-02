import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// StrictMode double-invokes effects and renders to surface bugs during
// development. That's wasteful in the shipped extension where each popup
// open is a fresh tree — gate it behind the dev build flag so prod users
// don't pay the cost of a second render.
const tree = import.meta.env.DEV ? (
  <StrictMode>
    <App />
  </StrictMode>
) : (
  <App />
);

createRoot(document.getElementById('root')!).render(tree);
