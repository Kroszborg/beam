import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { prepareSinks } from './lib/transfer';

// The service worker powers streaming downloads and the PWA share target.
prepareSinks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
