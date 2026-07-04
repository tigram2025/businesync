const statusEl = document.getElementById("status");

function extractTransactions() {
  // ページ内で実行される（拡張機能のコードとは別コンテキスト）
  // ¥X,XXX 形式に厳密マッチ（末尾に「5時間前」の数字が混入するのを防ぐ）
  const priceRegex = /¥\d{1,3}(?:,\d{3})*/;
  const dateRegex = /\d{4}[\/\-年]\d{1,2}[\/\-月]\d{1,2}日?|\d{1,2}[\/月]\d{1,2}日?/;
  const relativeRegex = /\d+時間前|\d+日前|昨日|今日/;

  // 価格(¥)を含む子要素が一番多いリスト(ul/ol)を「取引一覧」とみなす
  const lists = document.querySelectorAll("ul, ol");
  let best = null;
  let bestScore = 0;
  for (const list of lists) {
    const children = Array.from(list.children);
    const score = children.filter((c) => priceRegex.test(c.textContent)).length;
    if (score > bestScore) {
      bestScore = score;
      best = list;
    }
  }

  if (!best || bestScore < 2) {
    return { records: [], found: false };
  }

  const records = [];
  for (const child of best.children) {
    const text = child.textContent.replace(/\s+/g, " ").trim();
    const priceMatch = text.match(priceRegex);
    if (!priceMatch) continue;

    const dateMatch = text.match(dateRegex) || text.match(relativeRegex);
    const img = child.querySelector("img[alt]");
    // alt末尾の「のサムネイル undefined」などを除去
    const rawAlt = img && img.alt ? img.alt.trim() : "";
    const title = rawAlt
      ? rawAlt.replace(/のサムネイル.*$/u, "").trim()
      : text.slice(0, 60);
    const price = parseInt(priceMatch[0].replace(/[¥,]/g, ""), 10);
    const fee = Math.round(price * 0.1);

    records.push({
      date: dateMatch ? dateMatch[0] : "",
      title,
      price,
      fee,
      payout: price - fee,
    });
  }

  return { records, found: true };
}

function toCSV(records) {
  const headers = ["取引日時", "商品名", "売上金額(円)", "手数料(円)", "振込金額(円)"];
  const rows = records.map((r) => [r.date, r.title, r.price, r.fee, r.payout]);
  let csv = "﻿" + headers.join(",") + "\n";
  for (const row of rows) {
    csv += row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",") + "\n";
  }
  return csv;
}

function downloadText(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  statusEl.textContent = "取得中...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: extractTransactions,
  });

  if (!result || !result.found || result.records.length === 0) {
    statusEl.textContent =
      "取引データが見つかりませんでした。\n「HTMLを保存」ボタンで構造を確認してください。";
    return;
  }

  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const csv = toCSV(result.records);
  downloadText(csv, `mercari_sales_${yyyymm}.csv`, "text/csv");
  statusEl.textContent = `${result.records.length} 件をCSV出力しました。`;
});

document.getElementById("debugBtn").addEventListener("click", async () => {
  statusEl.textContent = "HTML取得中...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => document.documentElement.outerHTML,
  });
  downloadText(result, "debug_page.html", "text/html");
  statusEl.textContent = "debug_page.html を保存しました。";
});
