"""
メルカリ 月別売上CSV出力スクリプト
使い方:
  1. pip install playwright && python -m playwright install chromium
  2. python mercari_export.py
  3. ブラウザが開いたらメルカリにログイン（SMS認証も手動で完了）
  4. ログイン完了後、Enterキーを押すと自動収集開始
  5. 完了後に mercari_sales_YYYYMM.csv が生成される
"""

import csv
import time
import sys
from datetime import datetime
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeoutError
except ImportError:
    print("Playwright が見つかりません。以下を実行してください:")
    print("  pip install playwright")
    print("  python -m playwright install chromium")
    sys.exit(1)

BASE_URL = "https://jp.mercari.com"
TRANSACTIONS_URL = f"{BASE_URL}/mypage/transaction"

HEADERS = ["取引日時", "商品名", "カテゴリ", "売上金額(円)", "手数料(円)", "送料(円)", "振込金額(円)", "取引ID"]


def wait_for_login(page):
    print("\nブラウザでメルカリにログインしてください。")
    print("SMS認証など完了後、このターミナルでEnterキーを押してください...")
    input()
    print("ログイン確認中...")
    try:
        page.wait_for_selector('[data-testid="user-icon"], [class*="avatar"], nav[aria-label]', timeout=10000)
        print("ログイン確認OK")
    except PWTimeoutError:
        print("警告: ログイン状態の自動確認ができませんでした。続行します。")


def parse_price(text: str) -> int:
    """「¥1,234」→ 1234"""
    if not text:
        return 0
    cleaned = text.replace("¥", "").replace(",", "").replace(" ", "").strip()
    try:
        return int(cleaned)
    except ValueError:
        return 0


def scrape_transactions(page) -> list[dict]:
    records = []
    page.goto(TRANSACTIONS_URL, wait_until="networkidle")
    time.sleep(2)

    page_num = 1
    while True:
        print(f"  ページ {page_num} を取得中...")

        # 取引リストの各アイテムを取得
        items = page.query_selector_all('[data-testid="transaction-item"], [class*="TransactionItem"], li[class*="item"]')

        if not items:
            # セレクタが異なる場合のフォールバック
            items = page.query_selector_all('li[class*="List__item"], div[class*="transaction"]')

        if not items:
            print(f"  取引アイテムが見つかりません（ページ {page_num}）。セレクタを調整してください。")
            # デバッグ用: ページHTMLの一部を出力
            content = page.content()
            with open("debug_page.html", "w", encoding="utf-8") as f:
                f.write(content)
            print("  debug_page.html にページHTMLを保存しました。")
            break

        for item in items:
            record = extract_record(item)
            if record:
                records.append(record)

        # 次ページへ
        next_btn = page.query_selector('[aria-label="次へ"], [data-testid="pagination-next"], button[class*="next"]')
        if not next_btn or not next_btn.is_enabled():
            break

        next_btn.click()
        page.wait_for_load_state("networkidle")
        time.sleep(1)
        page_num += 1

    return records


def extract_record(item) -> dict | None:
    try:
        def text(selector):
            el = item.query_selector(selector)
            return el.inner_text().strip() if el else ""

        # 日時
        date_str = text('[class*="date"], time, [data-testid*="date"]')

        # 商品名
        name = text('[class*="name"], [class*="title"], [data-testid*="name"]')

        # カテゴリ
        category = text('[class*="category"], [data-testid*="category"]')

        # 金額系
        price_el = item.query_selector('[class*="price"],[class*="amount"],[data-testid*="price"]')
        price_text = price_el.inner_text() if price_el else "0"

        # 手数料（通常 price の 10%）
        sale_price = parse_price(price_text)
        fee = round(sale_price * 0.1) if sale_price else 0
        payout = sale_price - fee

        return {
            "取引日時": date_str,
            "商品名": name,
            "カテゴリ": category,
            "売上金額(円)": sale_price,
            "手数料(円)": fee,
            "送料(円)": 0,
            "振込金額(円)": payout,
            "取引ID": "",
        }
    except Exception as e:
        print(f"  アイテム解析エラー: {e}")
        return None


def filter_by_month(records: list[dict], year: int, month: int) -> list[dict]:
    result = []
    for r in records:
        date_str = r.get("取引日時", "")
        for fmt in ("%Y/%m/%d", "%Y-%m-%d", "%Y年%m月%d日", "%m/%d/%Y"):
            try:
                dt = datetime.strptime(date_str[:10], fmt)
                if dt.year == year and dt.month == month:
                    result.append(r)
                break
            except ValueError:
                continue
    return result


def save_csv(records: list[dict], year: int, month: int):
    filename = f"mercari_sales_{year}{month:02d}.csv"
    with open(filename, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=HEADERS)
        writer.writeheader()
        writer.writerows(records)
    total = sum(r["売上金額(円)"] for r in records)
    print(f"\n保存完了: {filename}")
    print(f"件数: {len(records)} 件")
    print(f"合計売上: ¥{total:,}")
    return filename


def main():
    now = datetime.now()

    # 対象月を指定
    year_input = input(f"対象年 [{now.year}]: ").strip() or str(now.year)
    month_input = input(f"対象月 [{now.month}]: ").strip() or str(now.month)
    year, month = int(year_input), int(month_input)

    print(f"\n対象: {year}年{month}月")
    print("ブラウザを起動します...")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(locale="ja-JP")
        page = context.new_page()

        page.goto(f"{BASE_URL}/login", wait_until="domcontentloaded")

        wait_for_login(page)

        print("\n取引履歴を収集中...")
        all_records = scrape_transactions(page)
        browser.close()

    print(f"\n全取引: {len(all_records)} 件")

    if not all_records:
        print("取引データが取得できませんでした。")
        print("debug_page.html を確認してセレクタを調整してください。")
        return

    monthly = filter_by_month(all_records, year, month)
    if not monthly:
        print(f"{year}年{month}月の取引が見つかりませんでした。")
        print("全件CSVを出力しますか？ [y/N]: ", end="")
        if input().strip().lower() == "y":
            save_csv(all_records, year, 0)
    else:
        save_csv(monthly, year, month)


if __name__ == "__main__":
    main()
