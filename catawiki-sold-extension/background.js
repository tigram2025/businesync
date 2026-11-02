// 受け取った情報を商品(ロット)ごとに chrome.storage.local へ統合して保存する
let queue = Promise.resolve();

function mergeLot(old, p) {
  const L = Object.assign({}, old || {});
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'title') {
      // API のタイトルを優先（ページタイトルは短縮されている場合がある）
      if (!L.title || p.title_src === 'api' || L.title_src !== 'api') { L.title = v; L.title_src = p.title_src || L.title_src; }
    } else if (k === 'title_src') {
      continue;
    } else if (k === 'final_bid' || k === 'bid_count' || k === 'bidders') {
      L[k] = Math.max(L[k] || 0, v);
    } else if (k === 'seen_at' || k === 'viewed_at' || k === 'last_bid_at') {
      if (!L[k] || v > L[k]) L[k] = v;
    } else if (k === 'first_bid_at' || k === 'first_seen') {
      if (!L[k] || v < L[k]) L[k] = v;
    } else if (k === 'page_closed') {
      L[k] = L[k] || v;
    } else if (k === 'extra') {
      L.extra = Object.assign({}, L.extra || {}, v);
    } else {
      L[k] = v;
    }
  }
  if (!L.first_seen) L.first_seen = p.seen_at || p.viewed_at || new Date().toISOString();
  if (L.title) {
    L.brand = L.title.includes(' - ') ? L.title.split(' - ')[0].trim() : (L.brand || '');
    L.no_reserve = /no\s*reserve/i.test(L.title);
  }
  L.date = (L.last_bid_at || L.viewed_at || L.seen_at || L.date || '').slice(0, 10);
  return L;
}

function applyPatches(patches) {
  queue = queue.then(async () => {
    const keys = [...new Set(patches.filter(p => p && p.lot_id).map(p => 'lot:' + p.lot_id))];
    if (!keys.length) return;
    const cur = await chrome.storage.local.get(keys);
    for (const p of patches) {
      if (!p || !p.lot_id) continue;
      const k = 'lot:' + p.lot_id;
      cur[k] = mergeLot(cur[k], p);
    }
    await chrome.storage.local.set(cur);
  }).catch(e => console.error(e));
  return queue;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'patches') {
    applyPatches(msg.patches).then(() => reply({ ok: true }));
    return true;
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('search.html') });
});

// search.html からの読み込み（sold_data.json の取り込み）もここで統合する
self.cwApplyPatches = applyPatches;
