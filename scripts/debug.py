import glob, os
from il_supermarket_scarper import ScarpingTask
from il_supermarket_scarper.utils.files.file_types import FileTypesFilters
for chain in ["RAMI_LEVY", "SHUFERSAL"]:
    t = ScarpingTask(enabled_scrapers=[chain], files_types=[FileTypesFilters.PRICE_FULL_FILE.name], multiprocessing=1,
                     output_configuration={"output_mode": "disk", "base_storage_path": "dumps"},
                     status_configuration={"database_type": "json", "base_path": "dumps/status"})
    t.start(limit=3); t.join()
for f in glob.glob("dumps/**/*", recursive=True):
    if os.path.isfile(f): print("FILE", f, os.path.getsize(f))
