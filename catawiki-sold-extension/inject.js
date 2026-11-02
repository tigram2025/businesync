// Catawiki のページ内で動き、ページ自身が読み込む API の結果をのぞき見して content.js に渡す。
// （新しい通信は一切発生させない）
(() => {
  const WANT = /\/buyer\/api\/v\d+\/lots(?:[/?]|$)/;
  const post = (url, body) => {
    try {
      window.postMessage({ __cwSold: true, url: String(url), body }, location.origin);
    } catch (e) {}
  };
  const handle = (url, text) => {
    if (!WANT.test(url) || !text || text.length > 5_000_000) return;
    try { post(url, JSON.parse(text)); } catch (e) {}
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (WANT.test(url)) {
        p.then(res => res.clone().text().then(t => handle(res.url || url, t))).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      if (WANT.test(String(url))) {
        this.addEventListener('load', () => {
          try {
            const t = this.responseType === '' || this.responseType === 'text' ? this.responseText
              : this.responseType === 'json' ? JSON.stringify(this.response) : '';
            handle(this.responseURL || String(url), t);
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };
})();
