"""Reproduce the raw dataset: re-download every clip listed in the committed metadata.

    python scripts/download_data.py            # everything (~170 MB)
    python scripts/download_data.py --no-demand  # skip the 126 MB DEMAND metro-noise zip
    python scripts/download_data.py --only fs267700 fs96502

Sources (audio is not committed - see .gitignore):
  - Freesound clips listed in data/raw/_fs_ann_meta.json / _fs_noise_meta.json.
    Downloads the public HQ mp3 preview (no API key). Licences are per clip (CC0 / CC-BY / CC-BY-NC);
    CC-BY requires attributing the creator - the metadata JSON holds url + licence for that.
  - DEMAND TMETRO_16k (Zenodo record 1227121).
Skips files that already exist. Fragile by nature: it scrapes Freesound's page for the preview URL.
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SETS = {"_fs_ann_meta.json": "freesound_announcements", "_fs_noise_meta.json": "freesound_noise"}
DEMAND_URL = "https://zenodo.org/records/1227121/files/TMETRO_16k.zip?download=1"
UA = {"User-Agent": "trained-announcement-dataset-downloader"}


def get(url: str, timeout=120) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def freesound(meta_file: str, folder: str, only: set | None) -> tuple[int, list]:
    entries = json.loads((RAW / meta_file).read_text(encoding="utf-8"))
    out_dir = RAW / folder
    out_dir.mkdir(parents=True, exist_ok=True)
    done, failed = 0, []
    for m in entries:
        if only and m["id"] not in only:
            continue
        dest = out_dir / f'{m["id"]}.mp3'
        if dest.exists():
            continue
        try:
            page = get(m["url"]).decode("utf-8", "replace")
            pv = re.search(r'https://cdn\.freesound\.org/previews/[^"]*-hq\.mp3', page)
            if not pv:
                raise RuntimeError("preview URL not found on page")
            dest.write_bytes(get(pv.group(0)))
            done += 1
            print("ok  ", m["id"], m.get("title", ""))
        except Exception as e:  # keep going; report at end
            failed.append((m["id"], str(e)))
            print("FAIL", m["id"], e)
    return done, failed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-demand", action="store_true")
    ap.add_argument("--only", nargs="*", help="clip ids, e.g. fs267700")
    a = ap.parse_args()
    only = set(a.only) if a.only else None

    total, failed = 0, []
    for meta, folder in SETS.items():
        n, f = freesound(meta, folder, only)
        total, failed = total + n, failed + f

    demand = RAW / "demand_tmetro" / "TMETRO_16k.zip"
    if not a.no_demand and not only and not demand.exists():
        demand.parent.mkdir(parents=True, exist_ok=True)
        print("downloading DEMAND TMETRO_16k (126 MB)...")
        demand.write_bytes(get(DEMAND_URL, timeout=600))
        total += 1

    print(f"\n{total} new file(s); {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
