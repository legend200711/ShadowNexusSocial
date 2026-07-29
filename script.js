/**
 * Shadow Nexus Social — script.js
 * Shared JavaScript utilities loaded by feed.html
 *
 * Responsibilities:
 *  1. Register the app service worker (sw.js)
 *  2. Register the FCM messaging service worker (firebase-messaging-sw.js)
 *  3. Handle SW update notifications (new version available toast)
 *  4. Capture the PWA install prompt and show the install banner
 *  5. Online/offline status handling
 *  6. Misc global utilities used across pages
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   1 & 2. SERVICE WORKER REGISTRATION
   Detects whether we're on GitHub Pages (/ShadowNexusSocial/)
   or running locally (file:// or localhost) and adjusts paths.
   ═══════════════════════════════════════════════════════════ */
(function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  const isGH    = location.pathname.startsWith('/ShadowNexusSocial');
  const base    = isGH ? '/ShadowNexusSocial/' : './';
  const swPath  = base + 'sw.js';

  window.addEventListener('load', async () => {

    // ── Register main app service worker ──
    try {
      const reg = await navigator.serviceWorker.register(swPath, { scope: base });
      console.log('[SW] Registered, scope:', reg.scope);

      // If a new SW is already waiting on first load, show the update bar now
      if (reg.waiting) {
        _showSWUpdateBar(reg.waiting);
      }

      // Detect new SW installing while the page is open
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          // Only show update bar when a truly NEW version is waiting.
          // navigator.serviceWorker.controller is null on the very first install,
          // so this branch is skipped — no update bar on first visit.
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            _showSWUpdateBar(newWorker);
          }
        });
      });

      // ── controllerchange reload guard ──
      // Only reload when the user explicitly clicked "Update" in the update bar.
      // This prevents auto-reloads on first install and on every page open.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('snx-sw-user-update')) {
          sessionStorage.removeItem('snx-sw-user-update');
          window.location.reload();
        }
        // Otherwise silently adopt the new controller — no reload needed.
      });
    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }

    // NOTE: firebase-messaging-sw.js is registered inside initPushNotifications()
    // in index.html (after auth + with the correct scope).
    // Do NOT register it here — a second registration with a conflicting scope
    // throws a SecurityError and silently breaks all push notifications.

  });

})();

/* ═══════════════════════════════════════════════════════════
   3. SW UPDATE BAR
   Shows a slim "New version available" bar at the bottom of
   the screen.  User must tap it to apply the update.
   No automatic reloads — ever.
   ═══════════════════════════════════════════════════════════ */

/**
 * Show (or refresh) the SW update bar.
 * @param {ServiceWorker} worker - the waiting service worker
 */
function _showSWUpdateBar(worker) {
  // De-duplicate: only one bar at a time
  if (document.getElementById('snx-update-bar')) return;

  const bar = document.createElement('div');
  bar.id = 'snx-update-bar';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-live', 'polite');
  bar.style.cssText = [
    'position:fixed',
    'bottom:70px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:99998',
    'background:rgba(0,15,45,0.97)',
    'border:1px solid rgba(0,174,239,0.65)',
    'border-radius:10px',
    'padding:10px 20px',
    'font-size:13px',
    'color:#00AEEF',
    'cursor:pointer',
    'white-space:nowrap',
    'box-shadow:0 4px 18px rgba(0,0,0,0.55)',
    'display:flex',
    'align-items:center',
    'gap:10px',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = '🔄 Update available — tap to refresh';

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = '✕';
  dismissBtn.setAttribute('aria-label', 'Dismiss update notification');
  dismissBtn.style.cssText = 'background:none;border:none;color:#7aadcc;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;';
  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    bar.remove();
  });

  bar.appendChild(label);
  bar.appendChild(dismissBtn);

  // Tapping the bar applies the update and reloads once (user-initiated)
  bar.addEventListener('click', () => {
    label.textContent = 'Updating…';
    dismissBtn.style.display = 'none';
    // Signal the controllerchange handler that THIS reload is intentional
    sessionStorage.setItem('snx-sw-user-update', '1');
    worker.postMessage({ type: 'SKIP_WAITING' });
  });

  document.body.appendChild(bar);

  // Auto-dismiss after 20 s — user can always refresh manually later
  setTimeout(() => { if (bar.parentNode) bar.remove(); }, 20000);
}

// Expose globally so index.html inline scripts can call it if needed
window.showUpdateToast = _showSWUpdateBar;


/* ═══════════════════════════════════════════════
   4. PWA INSTALL BANNER
   ═══════════════════════════════════════════════ */
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;

  if (sessionStorage.getItem('snx-install-dismissed')) return;
  setTimeout(() => showInstallBanner(), 3000);
});

function showInstallBanner() {
  const banner = document.getElementById('pwa-install-banner');
  if (!banner || !_deferredInstallPrompt) return;
  banner.classList.add('visible');
}

window.snxInstallApp = async function () {
  const banner = document.getElementById('pwa-install-banner');
  if (!_deferredInstallPrompt) return;

  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;

  console.log('[PWA] Install outcome:', outcome);
  _deferredInstallPrompt = null;
  if (banner) banner.classList.remove('visible');
};

window.snxDismissInstallBanner = function () {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.classList.remove('visible');
  sessionStorage.setItem('snx-install-dismissed', '1');
};

window.addEventListener('appinstalled', () => {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.classList.remove('visible');
  _deferredInstallPrompt = null;
  console.log('[PWA] App installed successfully.');
});

/* ═══════════════════════════════════════════════
   5. ONLINE / OFFLINE STATUS
   ═══════════════════════════════════════════════ */
function updateOnlineStatus() {
  const isOnline = navigator.onLine;
  let offlineBanner = document.getElementById('snx-offline-bar');

  if (!isOnline) {
    if (!offlineBanner) {
      offlineBanner = document.createElement('div');
      offlineBanner.id = 'snx-offline-bar';
      offlineBanner.setAttribute('role', 'alert');
      offlineBanner.setAttribute('aria-live', 'polite');
      offlineBanner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0;
        z-index: 99999;
        background: rgba(180, 10, 30, 0.92);
        color: #fff; text-align: center;
        font-size: 13px; font-weight: 600;
        padding: 8px 16px; letter-spacing: 0.3px;
        border-bottom: 1px solid rgba(255, 51, 80, 0.5);
        box-shadow: 0 2px 12px rgba(255, 40, 70, 0.3);
        backdrop-filter: blur(4px);
        animation: slideDownBar 0.25s ease both;
      `;
      offlineBanner.textContent = "📡 You're offline — some features may be unavailable";
      document.body.prepend(offlineBanner);

      if (!document.getElementById('snx-offline-bar-style')) {
        const s = document.createElement('style');
        s.id = 'snx-offline-bar-style';
        s.textContent = '@keyframes slideDownBar { from { transform: translateY(-100%); } to { transform: translateY(0); } }';
        document.head.appendChild(s);
      }
    }
  } else {
    if (offlineBanner) offlineBanner.remove();
  }
}

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
document.addEventListener('DOMContentLoaded', updateOnlineStatus);

/* ═══════════════════════════════════════════════
   6. GLOBAL UTILITIES
   ═══════════════════════════════════════════════ */

/** Copy text to clipboard with a toast confirmation. */
window.snxCopyToClipboard = function (text, successMsg) {
  const msg = successMsg || 'Copied to clipboard!';
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(() => { if (typeof toastNotification === 'function') toastNotification(msg); })
      .catch(() => { window.prompt('Copy this:', text); });
  } else {
    window.prompt('Copy this:', text);
  }
};

/** Format byte count as human-readable string. */
window.snxFormatBytes = function (bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

/** Debounce helper. */
window.snxDebounce = function (fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
};

/** Throttle helper. */
window.snxThrottle = function (fn, interval) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= interval) { last = now; fn.apply(this, args); }
  };
};

/** Generate a random alphanumeric ID. */
window.snxUid = function (length) {
  length = length || 8;
  return Array.from({ length }, () => Math.random().toString(36)[2] || '0')
    .join('').toUpperCase();
};

/** Check if the app is running as an installed PWA (standalone mode). */
window.snxIsStandalone = function () {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
};

document.addEventListener('DOMContentLoaded', () => {
  if (window.snxIsStandalone()) {
    console.log('[PWA] Running in standalone mode.');
    document.documentElement.setAttribute('data-pwa', 'standalone');
  }
});
