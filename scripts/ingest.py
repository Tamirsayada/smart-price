"""Daily ingest: download PriceFull + PromoFull for the branches near the store,
aggregate per barcode, and write sharded JSON for the static site (docs/data)."""
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


def iter_elements(path, wanted):
    """Yield (tag, element) for elements whose lowercase tag is in `wanted`. Tags differ in case between chains."""
    data = read_bytes(path)
    # Some chains ship UTF-16 or a BOM; ElementTree handles both when given bytes.
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        root = ET.fromstring(data.decode("utf-8", "ignore").encode("utf-8"))
    for el in root.iter():
        t = el.tag.lower() if isinstance(el.tag, str) else ""
        if t in wanted:
            yield t, el


def child(el, *names):
    lower = {c.tag.lower(): c for c in el}
    for n in names:
        c = lower.get(n.lower())
        if c is not None and c.text:
            return c.text.strip()
    return ""


def norm_code(code):
    return re.sub(r"\D", "", code or "").lstrip("0")


def store_from_filename(name):
    # PriceFull<chainId>-<subChain>-<storeId>-<date>-<time>
    m = re.search(r"(?:pricefull|promofull)\d+-\d+-(\d+)-", name, re.I)
    return int(m.group(1)) if m else None


def download(chain_key, store_ids):
    ids = "|".join(str(i) for i in store_ids)
    regex = rf"(?i)(pricefull|promofull)\d+-\d+-0*({ids})-"
    log(f"== {chain_key}: {regex}")
    task = ScarpingTask(
        enabled_scrapers=[chain_key],
        files_types=FileTypesFilters.all_full_files(),
        file_name_regex=regex,
        multiprocessing=1,
        output_configuration={"output_mode": "disk", "base_storage_path": DUMPS},
        status_configuration={"database_type": "json", "base_path": os.path.join(DUMPS, "status")},
        timeout_in_seconds=60 * 20,
    )
    task.start()
    task.join()


def latest_per_store(files):
    """Keep only the newest file per (store, kind). Filenames end with a timestamp so lexical max works."""
    best = {}
    for f in files:
        base = os.path.basename(f)
        sid = store_from_filename(base)
        if sid is None:
            continue
        kind = "promo" if "promo" in base.lower() else "price"
        key = (sid, kind)
        if key not in best or base > os.path.basename(best[key]):
            best[key] = f
    return best


def main():
    if os.path.isdir(DUMPS):
        shutil.rmtree(DUMPS)
    chains = CONFIG["chains"]
    only = sys.argv[1].split(",") if len(sys.argv) > 1 else None

    stores_meta = []          # [{c, n}]
    items = {}                # code -> {n, m, u, p: [[storeIdx, price]], pr: set(chainIdx)}
    chain_names = []
    chains_ok = 0

    for ci, chain in enumerate(chains):
        chain_names.append(chain["name"])
        if only and chain["key"] not in only:
            continue
        sid_to_idx = {}
        for s in chain["stores"]:
            sid_to_idx[s["id"]] = len(stores_meta)
            stores_meta.append({"c": ci, "n": s["name"]})
        try:
            download(chain["key"], [s["id"] for s in chain["stores"]])
        except Exception as e:  # one broken chain must not kill the whole run
            log(f"!! download failed for {chain['key']}: {e}")
            continue

        files = [f for f in glob.glob(os.path.join(DUMPS, "**", "*"), recursive=True)
                 if os.path.isfile(f) and re.search(r"(?i)(pricefull|promofull)", os.path.basename(f))]
        files = [f for f in files if chain["folder"].lower() in f.lower()]
        picked = latest_per_store(files)
        log(f"   files found: {len(files)}, picked: {sorted((k, os.path.basename(v)) for k, v in picked.items())}")
        got_any = False

        # prices first: promo rows are only counted for items already known
        for (sid, kind), path in sorted(picked.items(), key=lambda kv: kv[0][1]):
            if sid not in sid_to_idx:
                continue
            si = sid_to_idx[sid]
            n = 0
            try:
                if kind == "price":
                    for _, el in iter_elements(path, {"item", "product"}):
                        code = norm_code(child(el, "ItemCode"))
                        price = child(el, "ItemPrice")
                        if not code or len(code) < 7 or not price:
                            continue  # skip internal/weighted codes
                        try:
                            price = round(float(price), 2)
                        except ValueError:
                            continue
                        if price <= 0:
                            continue
                        it = items.get(code)
                        if it is None:
                            qty = child(el, "Quantity")
                            unit = child(el, "UnitQty", "UnitOfMeasure")
                            u = f"{qty.rstrip('0').rstrip('.') if '.' in qty else qty} {unit}".strip() if qty and qty not in ("0", "0.00") else ""
                            it = items[code] = {"n": child(el, "ItemName", "ItemNm"), "m": child(el, "ManufacturerName"),
                                                "u": u, "p": [], "pr": set()}
                        it["p"].append([si, price])
                        n += 1
                    got_any = got_any or n > 0
                else:
                    for _, promo in iter_elements(path, {"promotion", "sale"}):
                        for el in promo.iter():
                            if isinstance(el.tag, str) and el.tag.lower() == "itemcode" and el.text:
                                code = norm_code(el.text)
                                if code in items:
                                    items[code]["pr"].add(ci)
                                    n += 1
            except Exception as e:
                log(f"!! parse failed {path}: {e}")
            log(f"   {kind} store {sid}: {n} rows")
        if got_any:
            chains_ok += 1

    # collapse duplicate prices from the same store (keep first)
    shards = defaultdict(dict)
    for code, it in items.items():
        seen, prices = set(), []
        for si, p in it["p"]:
            if si not in seen:
                seen.add(si)
                prices.append([si, p])
        rec = {"n": it["n"], "p": prices}
        if it["m"] and it["m"].lower() not in ("unknown", "לא ידוע"):
            rec["m"] = it["m"]
        if it["u"]:
            rec["u"] = it["u"]
        if it["pr"]:
            rec["pr"] = sorted(it["pr"])
        shards[code[-2:].zfill(2)][code] = rec

    if not items:
        log("!! no items parsed, keeping previous data")
        sys.exit(1)

    if os.path.isdir(os.path.join(OUT, "p")):
        shutil.rmtree(os.path.join(OUT, "p"))
    os.makedirs(os.path.join(OUT, "p"), exist_ok=True)
    for k, d in shards.items():
        with open(os.path.join(OUT, "p", f"{k}.json"), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    now = dt.datetime.now(dt.timezone(dt.timedelta(hours=3)))
    meta = {"updated": now.strftime("%d/%m/%Y %H:%M"), "chains": chain_names,
            "chains_total": max(chains_ok, 1), "stores": stores_meta, "items": len(items)}
    with open(os.path.join(OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    log(f"done: {len(items)} items, {chains_ok} chains with data")


if __name__ == "__main__":
    main()
