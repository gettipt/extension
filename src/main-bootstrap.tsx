import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';

// Shared React boot helper used by both the popup (main.tsx) and the 402
// confirm window (confirm.tsx). StrictMode double-invokes effects and
// renders to surface bugs during development; that's wasteful in the
// shipped extension where each surface open is a fresh tree — gate it
// behind the dev build flag so prod users don't pay the cost of a second
// render.
export function bootstrap(rootId: string, Component: ComponentType): void {
  const el = document.getElementById(rootId);
  if (!el) throw new Error(`Root element #${rootId} not found.`);
  const tree = import.meta.env.DEV ? (
    <StrictMode>
      <Component />
    </StrictMode>
  ) : (
    <Component />
  );
  createRoot(el).render(tree);
}
