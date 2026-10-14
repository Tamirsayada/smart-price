"""Discovery: which chains are reachable from the runner, and which branches are near Netivot."""
import glob
import gzip
import os
import re
import sys
import zipfile

from il_supermarket_scarper import ScarpingTask
from il_supermarket_scarper.utils.files.file_types import FileTypesFilters

CHAINS = sys.argv[1].split(",")
NEAR = ["נתיבות", "אופקים", "שדרות", "באר שבע", "באר-שבע"]


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


task = ScarpingTask(
    enabled_scrapers=CHAINS,
    files_types=[FileTypesFilters.STORE_FILE.name],
    multiprocessing=len(CHAINS),
    output_configuration={"output_mode": "disk", "base_storage_path": "dumps"},
    status_configuration={"database_type": "json", "base_path": "status_logs"},
    timeout_in_seconds=900,
)
task.start(limit=1)
task.join()

for path in glob.glob("dumps/**/*", recursive=True):
    if os.path.isdir(path):
        continue
    print(f"\n### {path} ({os.path.getsize(path)} bytes)")
    text = read_any(path)
    print(text[:600].replace("\n", " "))
    blocks = re.split(r"<(?:Store|STORE|Branch)>", text)
    for b in blocks:
        if any(c in b for c in NEAR):
            print("  NEAR:", re.sub(r"\s+", " ", b)[:400])
