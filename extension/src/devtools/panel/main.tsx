import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('panel.html is missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
