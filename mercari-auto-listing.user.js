// ==UserScript==
// @name         メルカリ自動出品アシスト（BusineSYNC）
// @namespace    https://github.com/tigram2025/businesync
// @version      1.0.0
// @description  出品画面で「写真10枚（角・付属品は4分割に自動合成）」と「AI生成のタイトル・説明文」を自動入力します
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.openai.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 設定
   * ------------------------------------------------------------------ */
  const MAX_PHOTOS = 10;
  const TITLE_MAX = 40;
  const DESC_MAX = 3000;

  const DEFAULT_FOOTER = [
    '⚫返品対応について',
    '偽物だった場合全額返金します。',
    '',
    '⚫購入元',
    '日本流通自主管理協会加盟店（AACD）',
    '質屋・古物市場',
    '大手ブランドショップにより',
    '真贋鑑定済みの【確実正規品】です。',
  ].join('\n');

  const store = {
    get: (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch { return d; } },
    set: (k, v) => { try { GM_setValue(k, v); } catch {} },
  };

  /* ------------------------------------------------------------------ *
   * 状態
   * ------------------------------------------------------------------ */
  // 標準構成: 正面(付属品) / 正面 / 背面 / 底面 / 角4 / 側面・持ち手4 / 内側ディテール4 / 内側 / 内側
  const DEFAULT_PATTERN = '1,1,1,1,4,4,4,1,1';

  const state = {
    photos: [], // 投入された写真（撮影順） File[]
    built: [],  // 完成した出品用写真 File[]
  };

  function parsePattern() {
    return String($('pattern').value || DEFAULT_PATTERN)
      .split(/[\s,、]+/).map((s) => parseInt(s, 10)).filter((n) => n === 1 || n === 4)
      .slice(0, MAX_PHOTOS);
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */
  const host = document.createElement('div');
  host.id = 'bsync-mercari-host';
  host.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;';
  const root = host.attachShadow({ mode: 'open' });

  root.innerHTML = `
<style>
*{box-sizing:border-box;font-family:'Hiragino Sans','Noto Sans JP',sans-serif}
#fab{background:#22d3a0;color:#000;border:none;border-radius:999px;padding:12px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)}
#panel{display:none;position:fixed;right:16px;bottom:72px;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 100px);overflow:auto;background:#18181f;color:#e8e8f0;border:1px solid #28283a;border-radius:12px;padding:14px;box-shadow:0 8px 32px rgba(0,0,0,.5);font-size:13px}
#panel.on{display:block}
h2{font-size:14px;color:#22d3a0;margin:0 0 10px}
h3{font-size:12px;color:#9090b0;margin:14px 0 6px;font-weight:600}
.drop{border:2px dashed #35354a;border-radius:8px;padding:12px;text-align:center;position:relative;background:#111118;cursor:pointer}
.drop.over{border-color:#22d3a0}
.drop input{position:absolute;inset:0;opacity:0;cursor:pointer}
.drop .t{font-size:12px;color:#c0c0d8}.drop .s{font-size:10px;color:#6a6a80;margin-top:2px}
.thumbs{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.th{position:relative;width:62px;height:62px;border-radius:6px;overflow:hidden;background:#000}
.th img{width:100%;height:100%;object-fit:cover}
.th .n{position:absolute;left:2px;top:2px;background:rgba(0,0,0,.65);color:#fff;font-size:10px;border-radius:4px;padding:0 4px}
.th .ops{position:absolute;inset:auto 0 0 0;display:flex;justify-content:space-between;background:rgba(0,0,0,.55)}
.th .ops button{background:none;border:none;color:#fff;font-size:11px;cursor:pointer;padding:1px 4px}
textarea,input[type=text],input[type=password],select{width:100%;background:#111118;border:1px solid #28283a;border-radius:6px;color:#e8e8f0;font-size:12px;padding:7px 8px}
textarea{resize:vertical}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px}
.btn{padding:8px 14px;border-radius:8px;border:none;cursor:pointer;font-size:12px;font-weight:600}
.g{background:#22d3a0;color:#000}.o{background:#202028;color:#c0c0d8;border:1px solid #28283a}.b{background:#3b82f6;color:#fff}
.btn:disabled{opacity:.5;cursor:wait}
.cnt{font-size:11px;color:#9090b0;text-align:right}.cnt.bad{color:#f05a5a}
#log{font-size:11px;color:#9090b0;white-space:pre-wrap;margin-top:8px;min-height:14px}
details summary{cursor:pointer;color:#9090b0;font-size:12px;margin-top:12px}
label.sm{font-size:11px;color:#9090b0;display:block;margin:8px 0 3px}
.big{width:100%;padding:12px;font-size:14px;margin-top:12px}
</style>
<button id="fab">🤖 自動出品</button>
<div id="panel">
  <h2>メルカリ自動出品アシスト</h2>

  <h3>① 写真（最大${MAX_PHOTOS}枚）</h3>
  <label class="sm">構成（1＝そのまま / 4＝4枚を2×2に合成。撮影順に当てはめます）</label>
  <div class="row" style="margin-top:0">
    <input type="text" id="pattern" style="flex:1;font-family:monospace">
    <button class="btn o" id="patReset" title="標準構成に戻す">標準</button>
  </div>
  <div class="cnt" id="patInfo" style="text-align:left"></div>

  <div class="drop" id="dropS" style="margin-top:8px"><input type="file" accept="image/*" multiple id="inS">
    <div class="t">📷 写真をまとめてドロップ（撮影順）</div>
    <div class="s">ファイル名順に並べて構成に当てはめます。◀▶で入れ替え</div></div>
  <div class="thumbs" id="thS"></div>
  <div class="row"><button class="btn o" id="clearPh">写真クリア</button></div>
  <h3>出品される写真（この順でアップロード）</h3>
  <div class="thumbs" id="thOut"></div>
  <div class="cnt" id="phCnt"></div>

  <h3>② 文章</h3>
  <label class="sm">メモ（ブランド・管理番号・サイズなど）</label>
  <textarea id="memo" rows="5" placeholder="ロエベ　クロコ&#10;&#10;管理番号 127-3&#10;縦 19cm&#10;横 24.3cm&#10;マチ 16cm&#10;ハンドル 9.5cm"></textarea>
  <div class="row"><button class="btn b" id="gen">✨ 写真＋メモからAI生成</button></div>
  <label class="sm">タイトル</label>
  <input type="text" id="title">
  <div class="cnt" id="tCnt"></div>
  <label class="sm">商品説明（ChatGPTで作った文章をそのまま貼ってもOK）</label>
  <textarea id="desc" rows="12"></textarea>
  <div class="cnt" id="dCnt"></div>

  <button class="btn g big" id="fill">⬇️ メルカリの出品画面に入力</button>
  <div id="log"></div>

  <details>
    <summary>⚙️ 設定</summary>
    <label class="sm">OpenAI APIキー（このブラウザ内にだけ保存）</label>
    <input type="password" id="key" placeholder="sk-...">
    <label class="sm">モデル</label>
    <input type="text" id="model">
    <label class="sm">4分割の余白(px)</label>
    <input type="text" id="gap">
    <label class="sm">説明文の末尾に必ず付ける定型文</label>
    <textarea id="footer" rows="8"></textarea>
    <div class="row"><button class="btn o" id="save">設定を保存</button></div>
  </details>
</div>`;

  const $ = (id) => root.getElementById(id);

  // 設定の読込
  $('key').value = store.get('openai_key', '');
  $('model').value = store.get('model', 'gpt-4o');
  $('gap').value = store.get('gap', '0');
  $('footer').value = store.get('footer', DEFAULT_FOOTER);
  $('pattern').value = store.get('pattern', DEFAULT_PATTERN);

  $('save').onclick = () => {
    store.set('openai_key', $('key').value.trim());
    store.set('model', $('model').value.trim() || 'gpt-4o');
    store.set('gap', $('gap').value.trim() || '0');
    store.set('footer', $('footer').value);
    log('設定を保存しました ✓');
    rebuild();
  };
  $('pattern').addEventListener('change', () => { store.set('pattern', $('pattern').value); rebuild(); });
  $('patReset').onclick = () => { $('pattern').value = DEFAULT_PATTERN; store.set('pattern', DEFAULT_PATTERN); rebuild(); };

  $('fab').onclick = () => $('panel').classList.toggle('on');

  function log(msg) { $('log').textContent = msg; }

  // 出品画面だけボタンを表示（SPA遷移にも対応）
  function syncVisibility() {
    const onSell = /^\/sell\//.test(location.pathname);
    if (onSell && !host.isConnected) document.body.appendChild(host);
    host.style.display = onSell ? 'block' : 'none';
  }
  syncVisibility();
  setInterval(syncVisibility, 1000);

  /* ------------------------------------------------------------------ *
   * 写真の受付
   * ------------------------------------------------------------------ */
  const byName = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
  const onlyImages = (files) => Array.from(files).filter((f) => f.type.startsWith('image/')).sort(byName);

  function wireDrop(dropId, inputId, key) {
    const d = $(dropId);
    d.addEventListener('dragover', (e) => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation(); d.classList.remove('over');
      state[key].push(...onlyImages(e.dataTransfer.files)); rebuild();
    });
    $(inputId).addEventListener('change', (e) => {
      state[key].push(...onlyImages(e.target.files)); e.target.value = ''; rebuild();
    });
  }
  wireDrop('dropS', 'inS', 'photos');

  $('clearPh').onclick = () => { state.photos = []; rebuild(); };

  // 投入写真 i が出品写真の何枚目に入るか（null = 使われない）
  function slotLabels() {
    const labels = [];
    parsePattern().forEach((n, slot) => { for (let k = 0; k < n; k++) labels.push(n === 4 ? `→${slot + 1}田` : `→${slot + 1}`); });
    return labels;
  }

  function renderThumbs(containerId, files, key, labels) {
    const c = $(containerId);
    c.innerHTML = '';
    files.forEach((f, i) => {
      const el = document.createElement('div');
      el.className = 'th';
      const url = URL.createObjectURL(f);
      const tag = labels ? (labels[i] || '未使用') : String(i + 1);
      el.innerHTML = `<img src="${url}"><span class="n"${labels && !labels[i] ? ' style="background:#f05a5a"' : ''}>${tag}</span>` +
        (key ? `<div class="ops"><button data-a="l">◀</button><button data-a="x">✕</button><button data-a="r">▶</button></div>` : '');
      if (key) {
        el.querySelectorAll('button').forEach((b) => b.onclick = () => {
          const arr = state[key];
          if (b.dataset.a === 'x') arr.splice(i, 1);
          if (b.dataset.a === 'l' && i > 0) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
          if (b.dataset.a === 'r' && i < arr.length - 1) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
          rebuild();
        });
      }
      c.appendChild(el);
    });
  }

  let buildSeq = 0;
  async function rebuild() {
    const pat = parsePattern();
    const need = pat.reduce((a, b) => a + b, 0);
    $('patInfo').textContent = `出品${pat.length}枚 ／ 必要な写真 ${need}枚（いま ${state.photos.length}枚）`;
    $('patInfo').className = 'cnt' + (state.photos.length && state.photos.length !== need ? ' bad' : '');
    renderThumbs('thS', state.photos, 'photos', slotLabels());
    const seq = ++buildSeq;
    const out = await buildPhotos();
    if (seq !== buildSeq) return;
    state.built = out.files;
    renderThumbs('thOut', out.files, null);
    const cnt = $('phCnt');
    const msg = [];
    if (out.unused) msg.push(`${out.unused}枚が余っています（構成に「1」を足すか✕で削除）`);
    if (out.short) msg.push(`写真が${out.short}枚足りません`);
    cnt.textContent = `${out.files.length}/${MAX_PHOTOS}枚` + (msg.length ? ' ⚠ ' + msg.join(' / ') : '');
    cnt.className = 'cnt' + (msg.length ? ' bad' : '');
  }

  /* ------------------------------------------------------------------ *
   * 画像処理
   * ------------------------------------------------------------------ */
  function loadImg(file) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = URL.createObjectURL(file);
    });
  }

  function canvasToFile(canvas, name, q = 0.92) {
    return new Promise((res) => canvas.toBlob((b) => res(new File([b], name, { type: 'image/jpeg' })), 'image/jpeg', q));
  }

  // 長辺1920pxまでに縮小してJPEG化（アップロードを軽く・安定させる）
  async function normalize(file, idx) {
    const img = await loadImg(file);
    const scale = Math.min(1, 1920 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return canvasToFile(c, `photo_${String(idx).padStart(2, '0')}.jpg`);
  }

  // 4枚 → 2×2 の1枚（中央を正方形トリミング）
  async function collage(files, idx) {
    const size = 1600;
    const gap = Math.max(0, parseInt(store.get('gap', '6'), 10) || 0);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    const cell = (size - gap * 3) / 2;
    const pos = [[gap, gap], [gap * 2 + cell, gap], [gap, gap * 2 + cell], [gap * 2 + cell, gap * 2 + cell]];
    const imgs = await Promise.all(files.map(loadImg));
    imgs.forEach((img, i) => {
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, pos[i][0], pos[i][1], cell, cell);
    });
    return canvasToFile(c, `collage_${String(idx).padStart(2, '0')}.jpg`);
  }

  // 構成（例 1,1,1,1,4,4,4,1,1）に撮影順の写真を順番に当てはめる
  async function buildPhotos() {
    const pat = parsePattern();
    const files = [];
    let p = 0;
    for (let slot = 0; slot < pat.length && p < state.photos.length; slot++) {
      const group = state.photos.slice(p, p + pat[slot]);
      p += group.length;
      files.push(group.length === 1 ? await normalize(group[0], slot + 1) : await collage(group, slot + 1));
    }
    const need = pat.reduce((a, b) => a + b, 0);
    return {
      files,
      unused: Math.max(0, state.photos.length - need),
      short: state.photos.length ? Math.max(0, need - state.photos.length) : 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 文字数カウンタ
   * ------------------------------------------------------------------ */
  function counters() {
    const t = [...$('title').value].length;
    const d = [...$('desc').value].length;
    $('tCnt').textContent = `${t}/${TITLE_MAX}`;
    $('tCnt').className = 'cnt' + (t > TITLE_MAX ? ' bad' : '');
    $('dCnt').textContent = `${d}/${DESC_MAX}`;
    $('dCnt').className = 'cnt' + (d > DESC_MAX ? ' bad' : '');
  }
  $('title').addEventListener('input', counters);
  $('desc').addEventListener('input', (e) => { splitPasted(); counters(); });
  counters();

  // ChatGPTの出力を「【タイトル】…【商品説明】…」ごと貼った場合に自動で振り分け
  function splitPasted() {
    const v = $('desc').value;
    const m = v.match(/【タイトル】\s*([\s\S]*?)\s*【商品説明】\s*([\s\S]*)$/);
    if (!m) return;
    $('title').value = m[1].replace(/^文章作成\s*/, '').trim().split('\n')[0];
    $('desc').value = m[2].replace(/^文章作成\s*/, '').trim();
  }

  /* ------------------------------------------------------------------ *
   * OpenAI で文章生成
   * ------------------------------------------------------------------ */
  const SYSTEM_PROMPT = `あなたはメルカリでブランド中古品を販売するプロの出品担当です。
商品写真と出品者のメモから、タイトルと商品説明を作成し、次のJSONだけを返してください。
{"title": "...", "body": "..."}

# title のルール
- 形式:「ブランド英字 ブランドカナ 素材 アイテム カラー」を半角スペース区切り
- 例: LOEWE ロエベ クロコダイル ハンドバッグ ダークブラウン
- ${TITLE_MAX}文字以内

# body のルール（この構成・記号を厳守）
導入文を5〜6文。1文ごとに改行し、文と文の間は空行。
ブランド名は「LOEWE（ロエベ）」のように英字（カナ）で1回目に表記。
素材の特徴 → 色と金具 → フォルム・デザイン → 収納力 → 使用シーンの順で、上品で落ち着いた文体。

★管理番号★
（メモの管理番号）

★サイズ★
横：○cm
縦：○cm
厚み：○cm
ハンドル：○cm
（メモにある項目だけ。「マチ」は「厚み」と表記。ショルダー等があればそのまま追加）

★カラー・デザイン★
（色、素材、金具の色、アイテム種別、形を1行ずつ）

★状態★
（写真から分かる範囲で控えめに。断定的な「新品同様」等は避け、
「多少の小傷や使用感はございますが、目立った大きなダメージは写真からは確認できず、まだまだお使いいただけるお品です。」のような表現）

詳しい状態は写真にてご確認ください。

★付属品★
（写真に写っている付属品。例: 保存袋・冊子類（写真掲載分）。無ければ「なし」）

# 注意
- ブランド名はメモに書かれたものを使い、推測で別ブランドにしない
- サイズ・管理番号はメモの数値をそのまま使い、作らない
- 返品・購入元などの定型文は書かない（システムが自動で付けます）`;

  function gmFetch(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: (r) => resolve(r),
        onerror: (e) => reject(new Error('通信エラー')),
        ontimeout: () => reject(new Error('タイムアウト')),
        timeout: 120000,
      });
    });
  }

  async function toDataUrl(file, max = 1024) {
    const img = await loadImg(file);
    const s = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * s);
    c.height = Math.round(img.height * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  }

  $('gen').onclick = async () => {
    const key = ($('key').value || store.get('openai_key', '')).trim();
    if (!key) { log('⚙️ 設定で OpenAI APIキーを入力して保存してください'); return; }
    const memo = $('memo').value.trim();
    if (!memo) { log('メモ（ブランド・管理番号・サイズ）を入力してください'); return; }
    const photos = state.built.slice(0, 4);
    if (!photos.length) { log('写真を1枚以上入れてください'); return; }

    $('gen').disabled = true;
    log('AIが文章を作成中…');
    try {
      const images = await Promise.all(photos.map((f) => toDataUrl(f)));
      const res = await gmFetch({
        method: 'POST',
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        data: JSON.stringify({
          model: store.get('model', 'gpt-4o'),
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: `出品者のメモ:\n${memo}` },
                ...images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
              ],
            },
          ],
        }),
      });
      const json = JSON.parse(res.responseText);
      if (res.status !== 200) throw new Error(json.error?.message || `HTTP ${res.status}`);
      const out = JSON.parse(json.choices[0].message.content);
      const footer = store.get('footer', DEFAULT_FOOTER).trim();
      $('title').value = String(out.title || '').trim();
      $('desc').value = String(out.body || '').trim() + (footer ? `\n\n${footer}` : '');
      counters();
      log('生成しました ✓ 内容を確認して「出品画面に入力」を押してください');
    } catch (e) {
      log('❌ 生成失敗: ' + e.message);
    } finally {
      $('gen').disabled = false;
    }
  };

  /* ------------------------------------------------------------------ *
   * メルカリのフォームへ入力
   * ------------------------------------------------------------------ */
  // Shadow DOM の中まで探す
  function deepQueryAll(sel, base = document) {
    const out = [...base.querySelectorAll(sel)];
    base.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot && el !== host) out.push(...deepQueryAll(sel, el.shadowRoot));
    });
    return out;
  }

  function findByLabel(labelText, tag) {
    const labels = deepQueryAll('label,span,p,h2,h3,div').filter((el) => el.childElementCount === 0 && el.textContent.trim() === labelText);
    for (const lb of labels) {
      let p = lb;
      for (let i = 0; i < 5 && p; i++) {
        p = p.parentElement || p.getRootNode().host;
        const hit = p && p.querySelector(tag);
        if (hit) return hit;
      }
    }
    return null;
  }

  function findTitleInput() {
    return deepQueryAll('input[name="name"]')[0]
      || deepQueryAll('input[data-testid="name"]')[0]
      || deepQueryAll('input[aria-label*="商品名"]')[0]
      || findByLabel('商品名', 'input');
  }
  function findDescInput() {
    return deepQueryAll('textarea[name="description"]')[0]
      || deepQueryAll('textarea[data-testid="description"]')[0]
      || deepQueryAll('textarea[aria-label*="説明"]')[0]
      || findByLabel('商品の説明', 'textarea');
  }
  function findFileInput() {
    const all = deepQueryAll('input[type="file"]');
    return all.find((i) => /image/.test(i.accept || '')) || all[0];
  }

  // React 等の管理下の入力欄にも値を反映させる
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
  }

  function setFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function uploadPhotos(files) {
    let input = findFileInput();
    if (!input) throw new Error('写真のアップロード欄が見つかりません');
    if (input.multiple) {
      setFiles(input, files);
      return;
    }
    // 1枚ずつしか受け付けない場合は順番に入れる
    for (let i = 0; i < files.length; i++) {
      log(`写真をアップロード中… ${i + 1}/${files.length}`);
      input = findFileInput();
      if (!input) throw new Error(`${i + 1}枚目でアップロード欄が見つからなくなりました`);
      setFiles(input, [files[i]]);
      await sleep(1500);
    }
  }

  $('fill').onclick = async () => {
    $('fill').disabled = true;
    const results = [];
    try {
      if (state.built.length) {
        log('写真をアップロード中…');
        await uploadPhotos(state.built);
        results.push(`写真 ${state.built.length}枚 ✓`);
        await sleep(800);
      } else {
        results.push('写真: なし（スキップ）');
      }

      const title = $('title').value.trim();
      if (title) {
        const el = findTitleInput();
        if (el) { setNativeValue(el, [...title].slice(0, TITLE_MAX).join('')); results.push('タイトル ✓'); }
        else results.push('❌ タイトル欄が見つかりません');
      }

      const desc = $('desc').value.trim();
      if (desc) {
        const el = findDescInput();
        if (el) { setNativeValue(el, [...desc].slice(0, DESC_MAX).join('')); results.push('説明文 ✓'); }
        else results.push('❌ 説明文の欄が見つかりません');
      }

      log(results.join('\n') + '\n\nカテゴリ・状態・配送・価格を設定して、最後に「出品する」はご自身で押してください。');
    } catch (e) {
      log(results.join('\n') + '\n❌ ' + e.message);
    } finally {
      $('fill').disabled = false;
    }
  };

  rebuild();
})();
