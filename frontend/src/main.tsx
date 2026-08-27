import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './styles/index.css';

/**
 * Entry point. Nothing here touches the network: the API base URL is same-origin
 * by default and the Vite dev server proxies /api and /health to the local
 * FastAPI backend (see vite.config.ts). There are no external services.
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
