"""Discovery: per chain reachability, nearby branches, and catalog size of one PriceFull file."""
import glob, gzip, os, re, sys, zipfile
from il_supermarket_scarper import ScarpingTask
from il_supermarket_scarper.utils.files.file_types import FileTypesFilters

NEAR = ["נתיבות", "אופקים", "שדרות", "באר שבע", "באר-שבע", "קרית גת", "קריית גת", "אשקלון"]

def read_any(path):
    data = open(path, "rb").read()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    elif data[:2] == b"PK":
        with zipfile.ZipFile(path) as z:
            data = z.read(z.namelist()[0])
    for enc in ("utf-8", "utf-16", "cp1255"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            pass
    return data.decode("utf-8", "ignore")

chains = sys.argv[1].split(",")
for ft, lim in ((FileTypesFilters.STORE_FILE.name, 1), (FileTypesFilters.PRICE_FULL_FILE.name, 1)):
    t = ScarpingTask(enabled_scrapers=chains, files_types=[ft], multiprocessing=8,
                     output_configuration={"output_mode": "disk", "base_storage_path": "dumps"},
                     status_configuration={"database_type": "json", "base_path": "dumps/status"},
                     timeout_in_seconds=420)
    t.start(limit=lim); t.join()

for d in sorted(glob.glob("dumps/*")):
    if os.path.basename(d) == "status":
        continue
    files = [f for f in glob.glob(d + "/**/*", recursive=True) if os.path.isfile(f)]
    print(f"\n######## {os.path.basename(d)}: {len(files)} files")
    for f in files:
        txt = read_any(f)
        b = os.path.basename(f)
        if "store" in b.lower():
            stores = re.split(r"<(?:Store|STORE|Branch)>", txt)
            print(f"  stores file {b}: {len(stores)-1} stores")
            for s in stores:
                if any(c in s for c in NEAR):
                    sid = re.search(r"<StoreI[dD]>\s*(\d+)", s)
                    nm = re.search(r"<StoreName>([^<]*)", s)
                    city = re.search(r"<City>([^<]*)", s)
                    print(f"    NEAR id={sid.group(1) if sid else '?'} name={nm.group(1) if nm else '?'} city={city.group(1) if city else '?'}")
        else:
            n = len(re.findall(r"<ItemCode>", txt, re.I))
            print(f"  price file {b}: {n} items")
