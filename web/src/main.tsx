import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { syncOutbox } from './offline';
import { DEMO, installDemo } from './demo';

if (DEMO) await installDemo();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

// Offline support (D-121): the service worker keeps the app shell; the outbox is sent on start, when the connection
// returns, and every minute while there is something to send.
if (!DEMO && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* unsupported or blocked: the app still works online */ }); });
}
if (!DEMO) {
  window.addEventListener('online', () => { void syncOutbox(); });
  setInterval(() => { void syncOutbox(); }, 60_000);
  void syncOutbox();
}
