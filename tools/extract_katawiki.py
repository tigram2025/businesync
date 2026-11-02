#!/usr/bin/env python3
"""
カタウィキ（Catawiki）SOLDデータ抽出スクリプト（Mac / Google Chrome 用）

Chrome の「閲覧履歴」と「キャッシュ」からカタウィキのページを探し出し、
検索ページ（今後作る検索ページ）で読み込める JSON を作ります。

使い方（ターミナルで）:
    python3 extract_katawiki.py
    python3 extract_katawiki.py --keyword catawiki --days 180

出力先（デフォルト）: ~/Desktop/katawiki_sold/
    sold_data.json   … 検索ページに読み込ませるファイル
    raw/             … キャッシュから取り出したページ本体（構造確認用）
    summary.txt      … 何件見つかったかのまとめ

外部ライブラリは不要です（brotli 圧縮のページを読むときだけ
`pip3 install brotli` があると取りこぼしが減ります）。
"""

import argparse
import datetime as dt
import glob
import gzip
import hashlib
import html
import json
import os
import re
import shutil
import sqlite3
import struct
import sys
import tempfile
import zlib
from collections import Counter

try:
    import brotli  # type: ignore
except ImportError:
    brotli = None

HOME = os.path.expanduser("~")
CHROME_SUPPORT = os.path.join(HOME, "Library/Application Support/Google/Chrome")
CHROME_CACHES = os.path.join(HOME, "Library/Caches/Google/Chrome")

# Chrome の simple cache 形式の定数
SIMPLE_INITIAL_MAGIC = 0xFCFB6D1BA7725C30
SIMPLE_FINAL_MAGIC = 0xF4FA6F45970D41D8
INITIAL_MAGIC_BYTES = struct.pack("<Q", SIMPLE_INITIAL_MAGIC)
FINAL_MAGIC_BYTES = struct.pack("<Q", SIMPLE_FINAL_MAGIC)
EOF_SIZE = 24  # magic(8) + flags(4) + crc(4) + stream_size(4) + padding(4)

# Chrome の時刻は 1601-01-01 からのマイクロ秒
CHROME_EPOCH = dt.datetime(1601, 1, 1, tzinfo=dt.timezone.utc)


def chrome_time(us):
    if not us:
        return None
    try:
        return (CHROME_EPOCH + dt.timedelta(microseconds=int(us))).isoformat()
    except (OverflowError, ValueError):
        return None


def list_profiles():
    """Default, Profile 1, Profile 2 ... を返す"""
    profs = []
    for p in sorted(glob.glob(os.path.join(CHROME_SUPPORT, "*"))):
        name = os.path.basename(p)
        if name == "Default" or name.startswith("Profile "):
            if os.path.exists(os.path.join(p, "History")):
                profs.append(name)
    return profs


# ---------------------------------------------------------------- 履歴
def read_history(profile, keyword, since):
    src = os.path.join(CHROME_SUPPORT, profile, "History")
    if not os.path.exists(src):
        return []
    tmpdir = tempfile.mkdtemp()
    dst = os.path.join(tmpdir, "History")
    # Chrome 起動中はロックされているのでコピーしてから読む
    shutil.copy2(src, dst)
    for ext in ("-wal", "-journal"):
        if os.path.exists(src + ext):
            shutil.copy2(src + ext, dst + ext)
    rows = []
    try:
        con = sqlite3.connect(dst)
        cur = con.execute(
            """
            SELECT u.url, u.title, u.visit_count, u.last_visit_time,
                   (SELECT MIN(v.visit_time) FROM visits v WHERE v.url = u.id)
            FROM urls u
            WHERE u.url LIKE ?
            """,
            (f"%{keyword}%",),
        )
        for url, title, count, last, first in cur:
            last_iso = chrome_time(last)
            if since and last_iso and last_iso < since:
                continue
            rows.append(
                {
                    "source": "history",
                    "profile": profile,
                    "url": url,
                    "title": title or "",
                    "visit_count": count,
                    "first_visit": chrome_time(first),
                    "last_visit": last_iso,
                }
            )
        con.close()
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return rows


# ---------------------------------------------------------------- キャッシュ
def cache_dirs(profile):
    base = os.path.join(CHROME_CACHES, profile)
    cands = [
        os.path.join(base, "Cache", "Cache_Data"),
        os.path.join(base, "Cache"),
        os.path.join(CHROME_SUPPORT, profile, "Service Worker", "CacheStorage"),
    ]
    return [c for c in cands if os.path.isdir(c)]


def parse_simple_cache_file(path):
    """simple cache の *_0 ファイルから (url, headers文字列, body bytes) を取り出す"""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 20 or data[:8] != INITIAL_MAGIC_BYTES:
        return None
    _version, key_len, _key_hash = struct.unpack_from("<III", data, 8)
    key_start = 20
    # header は 8 バイト境界にパディングされる場合がある
    if data[key_start:key_start + 4] == b"\x00\x00\x00\x00":
        key_start = 24
    key = data[key_start:key_start + key_len].decode("utf-8", "replace")
    pos = key_start + key_len

    # stream1(本体) → EOF → stream0(HTTPヘッダ) → EOF
    eof1 = data.find(FINAL_MAGIC_BYTES, pos)
    if eof1 < 0:
        return None
    body = data[pos:eof1]
    eof0 = data.find(FINAL_MAGIC_BYTES, eof1 + EOF_SIZE)
    headers_blob = data[eof1 + EOF_SIZE:eof0] if eof0 > 0 else b""

    # key は "1/0/_dk_https://a https://a https://a/path" のような形
    urls = re.findall(r"https?://\S+", key)
    url = urls[-1] if urls else key
    return url, headers_blob.decode("latin-1", "replace"), body


def header_value(headers, name):
    m = re.search(name + r":\s*([^\x00\r\n]+)", headers, re.I)
    return m.group(1).strip() if m else ""


def decode_body(body, headers):
    enc = header_value(headers, "content-encoding").lower()
    try:
        if "gzip" in enc:
            return gzip.decompress(body)
        if "deflate" in enc:
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -zlib.MAX_WBITS)
        if "br" in enc:
            if brotli is None:
                return None
            return brotli.decompress(body)
        if "zstd" in enc:
            return None
    except Exception:
        return None
    return body


def read_cache(profile, keyword, rawdir):
    found = []
    stats = Counter()
    seen = set()
    for cdir in cache_dirs(profile):
        for path in glob.iglob(os.path.join(cdir, "**", "*_0"), recursive=True):
            rp = os.path.realpath(path)
            if rp in seen:
                continue
            seen.add(rp)
            stats["files"] += 1
            try:
                parsed = parse_simple_cache_file(path)
            except Exception:
                stats["parse_error"] += 1
                continue
            if not parsed:
                continue
            url, headers, body = parsed
            if keyword not in url.lower():
                continue
            ctype = header_value(headers, "content-type").lower()
            if ctype.startswith("image/") or re.search(r"\.(jpe?g|png|gif|webp|svg|woff2?|ttf|css|js)(\?|$)", url, re.I):
                stats["skipped_asset"] += 1
                continue
            decoded = decode_body(body, headers)
            if decoded is None:
                stats["undecodable"] += 1
                if "br" in header_value(headers, "content-encoding").lower():
                    stats["brotli_missing"] += 1
                continue
            stats["matched"] += 1
            text = decoded.decode("utf-8", "replace")
            mtime = dt.datetime.fromtimestamp(os.path.getmtime(path), dt.timezone.utc).isoformat()
            ext = ".json" if "json" in ctype or text.lstrip()[:1] in "[{" else ".html"
            fname = hashlib.sha1(url.encode()).hexdigest()[:16] + ext
            with open(os.path.join(rawdir, fname), "w", encoding="utf-8") as f:
                f.write(text)
            found.append(
                {
                    "source": "cache",
                    "profile": profile,
                    "url": url,
                    "content_type": ctype,
                    "date_header": header_value(headers, "date"),
                    "cached_at": mtime,
                    "raw_file": "raw/" + fname,
                    "text": text,
                }
            )
    return found, stats


# ---------------------------------------------------------------- 本文から情報を抜く
LOT_RE = re.compile(r"catawiki\.[a-z.]+/(?:[a-z]{2}/)?l/(\d+)(?:-([^/?#]+))?", re.I)
PRICE_RE = re.compile(r"(?:¥|￥|€|\$|£)\s*([0-9][0-9,.]{1,})|([0-9][0-9,]{2,})\s*(?:円|EUR|€)")
SOLD_RE = re.compile(r"SOLD\s*OUT|\bsold\b|closed|winning bid|final bid|Verkocht|Vendu|売り?切れ|落札|成約済|販売終了|終了しました", re.I)


def strip_html(s):
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    return re.sub(r"\s+", " ", s).strip()


def meta(s, prop):
    m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)' % re.escape(prop), s, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']%s["\']' % re.escape(prop), s, re.I)
    return html.unescape(m.group(1)).strip() if m else ""


def json_strings(obj, out, limit=4000):
    """JSON 内の文字列を全部集める（API レスポンス用の汎用処理）"""
    if len(out) > limit:
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, (str, int, float)) and not isinstance(v, bool):
                out.append(f"{k}:{v}")
            else:
                json_strings(v, out, limit)
    elif isinstance(obj, list):
        for v in obj:
            json_strings(v, out, limit)
    elif isinstance(obj, str):
        out.append(obj)


def enrich(rec):
    raw = rec.pop("text", "")
    title, image, body = "", "", ""
    if rec.get("raw_file", "").endswith(".json"):
        try:
            parts = []
            json_strings(json.loads(raw), parts)
            body = " ".join(parts)
        except ValueError:
            body = raw
    else:
        m = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
        title = meta(raw, "og:title") or (html.unescape(m.group(1)).strip() if m else "")
        image = meta(raw, "og:image")
        body = strip_html(raw)
    prices = []
    for a, b in PRICE_RE.findall(body):
        try:
            num = re.sub(r"[.,]\d{2}$", "", (a or b).rstrip(".,"))  # 小数点以下を除去
            v = int(re.sub(r"[.,]", "", num))
            if 1 <= v <= 100_000_000:
                prices.append(v)
        except ValueError:
            pass
    rec["title"] = title
    rec["image"] = image
    rec["prices"] = prices[:20]
    rec["sold"] = bool(SOLD_RE.search(body))
    rec["text"] = body[:20000]
    return rec


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Chrome からカタウィキのデータを抽出")
    ap.add_argument("--keyword", default="catawiki", help="URL に含まれる文字（ドメインの一部）")
    ap.add_argument("--days", type=int, default=0, help="履歴を直近 N 日に絞る（0 = 全部）")
    ap.add_argument("--out", default=os.path.join(HOME, "Desktop", "katawiki_sold"))
    args = ap.parse_args()
    keyword = args.keyword.lower()

    if not os.path.isdir(CHROME_SUPPORT):
        sys.exit("Chrome のデータフォルダが見つかりません: " + CHROME_SUPPORT)

    since = None
    if args.days:
        since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=args.days)).isoformat()

    rawdir = os.path.join(args.out, "raw")
    os.makedirs(rawdir, exist_ok=True)

    profiles = list_profiles()
    print("プロファイル:", ", ".join(profiles) or "(なし)")

    history, cache, stats = [], [], Counter()
    for prof in profiles:
        try:
            h = read_history(prof, keyword, since)
        except PermissionError:
            print("  ⚠ 履歴を読めません。システム設定 > プライバシーとセキュリティ > フルディスクアクセス で『ターミナル』を許可してください。")
            h = []
        c, s = read_cache(prof, keyword, rawdir)
        history += h
        cache += c
        stats.update(s)
        print(f"  {prof}: 履歴 {len(h)} 件 / キャッシュ {len(c)} 件")

    cache = [enrich(r) for r in cache]

    # URL ごとにまとめる（履歴のタイトル＋キャッシュの本文）
    merged = {}
    for r in history:
        merged[r["url"]] = dict(r)
    for r in cache:
        m = merged.setdefault(r["url"], {"url": r["url"]})
        for k, v in r.items():
            if v and (k not in m or not m[k]):
                m[k] = v
        m["source"] = "history+cache" if "visit_count" in m else "cache"
    # ロットページ（/l/<ID>-<商品名スラッグ>）なら URL から ID と商品名を取り出す
    for m in merged.values():
        lm = LOT_RE.search(m["url"])
        if lm:
            m["lot_id"] = lm.group(1)
            m["slug_title"] = lm.group(2).replace("-", " ") if lm.group(2) else ""
    items = sorted(merged.values(), key=lambda x: x.get("last_visit") or x.get("cached_at") or "", reverse=True)

    out = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "keyword": keyword,
        "count": len(items),
        "items": items,
    }
    with open(os.path.join(args.out, "sold_data.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    lots = [i for i in items if i.get("lot_id")]
    lots_with_body = [i for i in lots if i.get("raw_file")]
    lot_dates = sorted((i.get("first_visit") or i.get("cached_at") or "")[:10] for i in lots if i.get("first_visit") or i.get("cached_at"))
    hosts = Counter(re.sub(r"^https?://([^/]+).*", r"\1", i["url"]) for i in items)
    oldest = min((i.get("first_visit") or i.get("cached_at") or "" for i in items if i.get("first_visit") or i.get("cached_at")), default="-")
    summary = [
        f"合計 {len(items)} URL（履歴 {len(history)} / キャッシュ本文あり {len(cache)}）",
        f"一番古いデータ: {oldest[:10]}",
        f"商品(ロット)ページ: {len(lots)} 件（うちキャッシュに本文あり {len(lots_with_body)} 件）",
        f"ロットの期間: {lot_dates[0] if lot_dates else '-'} 〜 {lot_dates[-1] if lot_dates else '-'}",
        f"SOLD/終了 表記ありのページ: {sum(1 for i in items if i.get('sold'))}",
        f"キャッシュ走査ファイル数: {stats['files']}  解読不可: {stats['undecodable']}  (brotli 未導入で読めず: {stats['brotli_missing']})",
        "ドメイン別: " + ", ".join(f"{h}={n}" for h, n in hosts.most_common(10)),
    ]
    with open(os.path.join(args.out, "summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(summary) + "\n")
    print("\n".join(summary))
    if stats["brotli_missing"]:
        print("\n→ `pip3 install brotli` してから再実行すると、さらに読めるページが増えます。")
    if lots:
        print("\n最近の商品ページ（例）:")
        for i in lots[:10]:
            print(f"  {(i.get('last_visit') or i.get('cached_at') or '')[:10]}  {i.get('title') or i.get('slug_title')}")
    print("\n出力:", os.path.join(args.out, "sold_data.json"))
    if not items:
        print("\n0 件でした。Chrome の別プロファイルや別ブラウザで見ていないか確認してください。")


if __name__ == "__main__":
    main()
