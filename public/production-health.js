(() => {
  const reported = new Map();
  const pending = new Set();
  const categories = new Set(['chat_network', 'chat_response', 'api_network', 'script_load', 'script_runtime']);

  function report(kind) {
    if (!categories.has(kind)) return;
    if (!navigator.onLine) {
      pending.add(kind);
      return;
    }
    const now = Date.now();
    if (now - (reported.get(kind) || 0) < 60_000) return;
    const url = '/__health/client/' + kind;
    try {
      if (typeof navigator.sendBeacon === 'function' && navigator.sendBeacon(url)) reported.set(kind, now);
    } catch { /* Monitoring is best effort. */ }
  }

  window.addEventListener('online', () => {
    for (const kind of pending) report(kind);
    pending.clear();
  });
  window.addEventListener('error', event => {
    if (event.target instanceof HTMLScriptElement) {
      const url = new URL(event.target.src, location.href);
      if (url.origin === location.origin) report('script_load');
    } else if (event instanceof ErrorEvent && event.filename.startsWith(location.origin + '/')) {
      report('script_runtime');
    }
  }, true);

  const fetchOriginal = window.fetch;
  window.fetch = async function (input, options) {
    try {
      return await fetchOriginal.call(this, input, options);
    } catch (error) {
      if (error?.name !== 'AbortError') {
        try {
          const url = new URL(input instanceof Request ? input.url : input, location.href);
          if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
            report(url.pathname === '/api/voice/chat' || url.pathname === '/api/chat/history' ? 'chat_network' : 'api_network');
          }
        } catch { /* Monitoring must never replace the original error. */ }
      }
      throw error;
    }
  };
  window.zuanzuanHealthReport = report;
})();
