import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { ServerPage } from './ServerPage.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServerPage />
  </StrictMode>,
);
