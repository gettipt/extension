import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import ConfirmApp from './ConfirmApp';

const tree = import.meta.env.DEV ? (
  <StrictMode>
    <ConfirmApp />
  </StrictMode>
) : (
  <ConfirmApp />
);

createRoot(document.getElementById('confirm-root')!).render(tree);
