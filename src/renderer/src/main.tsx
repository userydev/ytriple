import React from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopApi } from '../../shared/contracts';
import { App } from './App';
import './styles.css';
declare global { interface Window { ytriple: DesktopApi } }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
