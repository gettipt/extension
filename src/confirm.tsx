import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import ConfirmApp from './ConfirmApp';

createRoot(document.getElementById('confirm-root')!).render(
  <StrictMode>
    <ConfirmApp />
  </StrictMode>,
);
