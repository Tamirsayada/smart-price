"""Daily ingest: download price files from Israeli chains (price-transparency law),
aggregate per barcode and write sharded JSON for the static site (docs/data).

Per chain (config.json):
  local - branches near the store; full price + promo files. Their prices drive the recommendation.
  ref   - sample N more PriceFull files nationwide and keep the 2 largest catalogs,
          so products not sold near the store still get a (national) price.
"""
import datetime as dt
import glob
import gzip
import json
import os
import re
import shutil
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

from il_supermarket_scarper import ScarpingTask
from il_supermarket_scarper.utils.files.file_types import FileTypesFilters

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
OUT = os.path.join(ROOT, "docs", "data")
DUMPS = os.path.join(ROOT, "dumps")
REF_KEEP = 2
SHARD_DIGITS = 3


def log(*a):
    print(*a, flush=True)


def read_bytes(path):
    data = open(path, "rb").read()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    elif data[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            data = z.read(z.namelist()[0])
    return data


def parse_root(path):
    data = read_bytes(path)
    try:
        return ET.fromstring(data)
    except ET.ParseError:
        # some chains declare one encoding and ship another
        for enc in ("utf-8", "utf-16", "cp1255"):
            try:
                return ET.fromstring(data.decode(enc).encode("utf-8").replace(b'encoding="', b'x="', 1))
            except (UnicodeDecodeError, ET.ParseError):
                continue
        raise


def tag(el):
    return el.tag.lower() if isinstance(el.tag, str) else ""


def child(el, *names):
    lower = {tag(c): c for c in el}
    for n in names:
        c = lower.get(n.lower())
        if c is not None and c.text and c.text.strip():
            return c.text.strip()
    return ""


def norm_code(code):
    return re.sub(r"\D", "", code or "").lstrip("0")


def file_store_id(name):
    # PriceFull<chainId>-<subChain>-<storeId>-<date>-<time>  (a few chains omit the sub-chain)
    m = re.search(r"(?:pricefull|promofull)\d+-\d+-(\d+)-\d{8}", name, re.I) or \
        re.search(r"(?:pricefull|promofull)\d+-(\d+)-\d{8,12}", name, re.I)
    return int(m.group(1)) if m else None


def scrape(chain_key, files_types, regex=None, limit=None):
    task = ScarpingTask(
        enabled_scrapers=[chain_key],
        files_types=files_types,
        file_name_regex=regex,
        multiprocessing=1,
        output_configuration={"output_mode": "disk", "base_storage_path": DUMPS},
        status_configuration={"database_type": "json", "base_path": os.path.join(DUMPS, "status", chain_key)},
        timeout_in_seconds=60 * 12,
    )
    task.start(limit=limit)
    task.join()


def chain_files(folder):
    return [f for f in glob.glob(os.path.join(DUMPS, folder, "**", "*"), recursive=True) if os.path.isfile(f)]


def store_names(folder):
    names = {}
    for f in chain_files(folder):
        if "store" not in os.path.basename(f).lower():
            continue
        try:
            for el in parse_root(f).iter():
                if tag(el) in ("store", "branch"):
                    sid = child(el, "StoreId", "StoreID")
                    nm = child(el, "StoreName")
                    if sid.isdigit() and nm:
                        names[int(sid)] = re.sub(r"\s+", " ", nm)
        except Exception as e:
            log(f"   !! stores parse {f}: {e}")
    return names


def latest_per_store(files):
    best = {}
    for f in files:
        base = os.path.basename(f)
        low = base.lower()
        if "pricefull" not in low and "promofull" not in low:
            continue
        sid = file_store_id(base)
        if sid is None:
            continue
        key = (sid, "promo" if "promo" in low else "price")
        if key not in best or base > os.path.basename(best[key]):
            best[key] = f
    return best


def parse_prices(path):
    rows = []
    for el in parse_root(path).iter():
        if tag(el) not in ("item", "product"):
            continue
        code = norm_code(child(el, "ItemCode"))
        if not code or len(code) < 7:
            continue  # internal / weighed-item codes
        try:
            price = round(float(child(el, "ItemPrice")), 2)
        except ValueError:
            continue
        if price <= 0 or price > 5000:
            continue
        qty, unit = child(el, "Quantity"), child(el, "UnitQty", "UnitOfMeasure")
        if unit.lower() in ("לא ידוע", "unknown"):
            unit = ""
        if qty and "." in qty:
            qty = qty.rstrip("0").rstrip(".")
        u = f"{qty} {unit}".strip() if qty and qty not in ("0",) and unit else ""
        rows.append((code, price, child(el, "ItemName", "ItemNm", "ManufacturerItemDescription"),
                     child(el, "ManufacturerName"), u))
    return rows


def parse_promo_codes(path):
    codes = set()
    for el in parse_root(path).iter():
        if tag(el) == "itemcode" and el.text:
            codes.add(norm_code(el.text))
    return codes


def main():
    if os.path.isdir(DUMPS):
        shutil.rmtree(DUMPS)
    only = set(sys.argv[1].split(",")) if len(sys.argv) > 1 and sys.argv[1] else None

    stores_meta, chain_names = [], []
    items = {}                      # code -> {n, m, u, p: {storeIdx: price}, pr: set(chainIdx)}
    chains_ok = 0

    def add_rows(rows, si):
        for code, price, name, manu, u in rows:
            it = items.get(code)
            if it is None:
                it = items[code] = {"n": name, "m": manu, "u": u, "p": {}, "pr": set()}
            else:
                # names are often truncated differently per chain; keep the most informative one
                if len(name) > len(it["n"]):
                    it["n"] = name
                if not it["m"] and manu:
                    it["m"] = manu
                if not it["u"] and u:
                    it["u"] = u
            it["p"].setdefault(si, price)

    for ci, chain in enumerate(CONFIG["chains"]):
        chain_names.append(chain["name"])
        if only and chain["key"] not in only:
            continue
        key, folder, local = chain["key"], chain["folder"], chain.get("local", [])
        log(f"== {key}")
        try:
            scrape(key, [FileTypesFilters.STORE_FILE.name], limit=1)
            if local:
                ids = "|".join(str(i) for i in local)
                scrape(key, FileTypesFilters.all_full_files(), regex=rf"(?i)(pricefull|promofull)\d+-(\d+-)?0*({ids})-\d{{8}}")
            if chain.get("ref"):
                scrape(key, [FileTypesFilters.PRICE_FULL_FILE.name], regex=r"(?i)pricefull", limit=chain["ref"] + len(local))
        except Exception as e:  # one broken chain must not kill the whole run
            log(f"   !! download failed: {e}")

        names = store_names(folder)
        picked = latest_per_store(chain_files(folder))
        got = 0

        # local branches: prices then promos (promos only count for known items)
        local_idx = {}
        for sid in local:
            path = picked.get((sid, "price"))
            if not path:
                log(f"   local {sid}: no price file")
                continue
            try:
                rows = parse_prices(path)
            except Exception as e:
                log(f"   !! parse {path}: {e}")
                continue
            si = len(stores_meta)
            stores_meta.append({"c": ci, "n": names.get(sid, f"סניף {sid}"), "l": 1})
            local_idx[sid] = si
            add_rows(rows, si)
            got += len(rows)
            log(f"   local {sid} {names.get(sid, '')}: {len(rows)} items")
        for sid in local_idx:
            path = picked.get((sid, "promo"))
            if path:
                try:
                    for code in parse_promo_codes(path):
                        if code in items:
                            items[code]["pr"].add(ci)
                except Exception as e:
                    log(f"   !! promo {path}: {e}")

        # national reference branches: keep the biggest catalogs
        if chain.get("ref"):
            cands = []
            for (sid, kind), path in picked.items():
                if kind != "price" or sid in local_idx:
                    continue
                try:
                    rows = parse_prices(path)
                    cands.append((len(rows), sid, rows))
                except Exception as e:
                    log(f"   !! parse {path}: {e}")
            cands.sort(key=lambda x: -x[0])
            for n, sid, rows in cands[:REF_KEEP]:
                si = len(stores_meta)
                stores_meta.append({"c": ci, "n": names.get(sid, f"סניף {sid}"), "l": 0})
                add_rows(rows, si)
                got += n
                log(f"   ref {sid} {names.get(sid, '')}: {n} items")
        if got:
            chains_ok += 1
        shutil.rmtree(os.path.join(DUMPS, folder), ignore_errors=True)  # keep the runner disk small
        log(f"   total items so far: {len(items)}")

    if len(items) < 1000:
        log("!! too few items parsed, keeping previous data")
        sys.exit(1)

    shards = defaultdict(dict)
    for code, it in items.items():
        rec = {"n": it["n"], "p": [[si, p] for si, p in it["p"].items()]}
        if it["m"] and it["m"].lower() not in ("unknown", "לא ידוע"):
            rec["m"] = it["m"]
        if it["u"]:
            rec["u"] = it["u"]
        if it["pr"]:
            rec["pr"] = sorted(it["pr"])
        shards[code[-SHARD_DIGITS:].zfill(SHARD_DIGITS)][code] = rec

    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(os.path.join(OUT, "p"), exist_ok=True)
    for k, d in shards.items():
        with open(os.path.join(OUT, "p", f"{k}.json"), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=3)))
    local_chains = len({s["c"] for s in stores_meta if s["l"]})
    meta = {"updated": now.strftime("%d/%m/%Y %H:%M"), "chains": chain_names,
            "chains_total": max(local_chains, 1), "stores": stores_meta,
            "items": len(items), "shard_digits": SHARD_DIGITS}
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log(f"done: {len(items)} items, {len(stores_meta)} branches, {chains_ok} chains with data")


if __name__ == "__main__":
    main()
