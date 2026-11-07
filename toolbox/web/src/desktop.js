import { KEY_STORAGE } from './useAccounts';

export function initializeDesktop() {
  if (!window.chrome?.webview) return;
  const parameters = new URLSearchParams(location.hash.slice(1));
  const key = parameters.get('desktop_key');
  if (key !== null) {
    localStorage.setItem(KEY_STORAGE, key);
    history.replaceState(null, '', location.pathname + location.search + '#accounts');
  }

  // Register in the document itself; WebView2's injected init scripts can race navigation.
  if (!window.desktopOpenExternal) {
    const rpc = window._rpc = window._rpc || { nextSeq: 1 };
    window.desktopOpenExternal = value => new Promise((resolve, reject) => {
      const id = rpc.nextSeq++;
      rpc[id] = { resolve, reject };
      window.chrome.webview.postMessage(JSON.stringify({ id, method: 'desktopOpenExternal', params: [value] }));
    });
  }
  const open = value => {
    try {
      const url = new URL(value, location.href);
      if (url.protocol === 'https:') window.desktopOpenExternal(url.href).catch(console.error);
    } catch { /* Ignore malformed links. */ }
  };
  window.open = value => { open(value); return null; };
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (link && (link.target === '_blank' || new URL(link.href).origin !== location.origin)) {
      event.preventDefault();
      open(link.href);
    }
  }, true);
}
