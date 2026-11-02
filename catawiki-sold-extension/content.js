// inject.js から受け取った API データと、商品ページの基本情報を background.js に送る
const LOT_PATH = /\/l\/(\d+)(?:-[^/?#]*)?/;
const LOTS_API = /\/buyer\/api\/v\d+\/lots(?:\?|$)/;
const BIDS_API = /\/buyer\/api\/v\d+\/lots\/(\d+)\/bids/;
const ONE_LOT_API = /\/buyer\/api\/v\d+\/lots\/(\d+)(?:\/([a-z_]+))?(?:\?|$)/;
// 1商品の API に含まれていれば残しておく項目（終了日時・リザーブ達成など）
const EXTRA_KEY = /(end|close|reserve|status|sold|state|current_bid|highest|winning)/i;

function send(patches) {
  if (!patches.length) return;
  try { chrome.runtime.sendMessage({ type: 'patches', patches }); } catch (e) {}
}

function pickExtra(obj, out, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || typeof v !== 'object') {
      if (EXTRA_KEY.test(k) && Object.keys(out).length < 30) out[k] = v;
    } else if (!Array.isArray(v)) {
      pickExtra(v, out, depth + 1);
    }
  }
  return out;
}

function fromApi(url, body) {
  const now = new Date().toISOString();
  const patches = [];
  if (LOTS_API.test(url) && body && Array.isArray(body.lots)) {
    for (const x of body.lots) {
      if (!x || x.id == null || !x.title) continue;
      patches.push({ lot_id: String(x.id), title: x.title, url: x.url, image: x.thumbnail2_url, auction_id: x.auction_id, seen_at: now, title_src: 'api' });
    }
    return patches;
  }
  let m = url.match(BIDS_API);
  if (m && body && Array.isArray(body.bids)) {
    const bids = body.bids.filter(b => b && typeof b.amount === 'number');
    const p = { lot_id: m[1], seen_at: now, bid_count: body.bids.length };
    p.bidders = new Set(body.bids.map(b => b && b.bidder && b.bidder.token)).size;
    if (bids.length) {
      p.final_bid = Math.max(...bids.map(b => b.amount));
      p.currency = (bids.find(b => b.currency_code) || {}).currency_code || 'EUR';
      const ds = bids.map(b => b.created_at).filter(Boolean).sort();
      p.first_bid_at = ds[0]; p.last_bid_at = ds[ds.length - 1];
    }
    const extra = pickExtra(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'bids')), {});
    if (Object.keys(extra).length) p.extra = extra;
    patches.push(p);
    return patches;
  }
  m = url.match(ONE_LOT_API);
  if (m && body && !body.error && !['recommendations', 'collections'].includes(m[2])) {
    const extra = pickExtra(body, {});
    if (Object.keys(extra).length) patches.push({ lot_id: m[1], extra, seen_at: now });
  }
  return patches;
}

window.addEventListener('message', e => {
  if (e.source !== window || !e.data || !e.data.__cwSold) return;
  send(fromApi(e.data.url, e.data.body));
});

// 商品ページを開いたら、タイトル・画像・「終了」表示の有無を記録（SPA の画面遷移にも対応）
let lastPath = '';
function recordPage() {
  const m = location.pathname.match(LOT_PATH);
  if (!m || location.pathname === lastPath) return;
  const meta = p => (document.querySelector(`meta[property="${p}"]`) || {}).content || '';
  const title = (meta('og:title') || document.title || '').replace(/\s*[-|]\s*(auction online\s*)?Catawiki\s*$/i, '').trim();
  if (!title) return; // まだ読み込み中
  lastPath = location.pathname;
  const main = document.querySelector('main') || document.body;
  const head = (main ? main.innerText : '').slice(0, 4000);
  const closed = /\b(lot closed|closed|final bid|winning bid|sold for)\b|オークション終了|終了しました|落札/i.test(head)
    && !/\bcloses in\b/i.test(head.slice(0, 300));
  send([{ lot_id: m[1], title, title_src: 'page', url: location.origin + location.pathname, image: meta('og:image'), viewed_at: new Date().toISOString(), page_closed: closed }]);
}
setInterval(recordPage, 1500);
