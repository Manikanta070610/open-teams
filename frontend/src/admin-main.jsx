import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import AdminApp from './AdminApp.jsx';

// Surface render/runtime crashes in DevTools console with an app tag.
window.addEventListener('error', (e) => console.error('[frontend] uncaught:', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[frontend] unhandled rejection:', e.reason?.message || e.reason));

createRoot(document.getElementById('root')).render(<AdminApp />);
