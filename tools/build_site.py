#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Býr til gögn vefsins (statísk) úr möppu með myndum.

    python tools/build_site.py "<mappa með völdum myndum>"
    python tools/build_site.py "<mappa>" --list valdar.txt      # bara myndir á listanum
    python tools/build_site.py "<mappa>" --copy-photos
    python tools/build_site.py --lists-only               # bara ný geojson-/dxf3d-skrá          # afritar líka frummyndirnar í photos/

Býr til:
    site/data/photos.csv          nafn;lat;lon;date;heading;category;mtime;pano
    thumbs/<sama slóð>.jpg   smámyndir (sprettgluggi á kortinu)
    data/geojson-list.json   listi yfir data/geojson/*.geojson (línur/möstur HH3)
    data/shapes-list.json    (tómt - frátekið)
    data/dxf3d-list.json     listi yfir data/dxf3d/*.dxf3d (3D-lag, valfrjálst)
    photos/<sama slóð>       frummyndir - AÐEINS með --copy-photos

Frummyndirnar (um 1 GB, 360° myndir eru um 35 MB hver) komast ekki í
Azure Static Web Apps (Free 250 MB / Standard 500 MB) né GitHub-repo (skrá
< 100 MB, repo helst < 1 GB). Sjálfgefið er því EKKI afritað í photos/ -
settu myndirnar í Azure Blob Storage og láttu site-config.js benda þangað
(photoBase). Með --copy-photos eru þær afritaðar í photos/ ef safnið er lítið.

Myndir sem eru þegar í data/photos.csv eru ekki lesnar aftur (hraðvirkt
þegar bætt er við); smámynd er endurgerð ef hún vantar.
Uppsetning (einu sinni):  pip install Pillow
"""
import sys
import csv
import json
import shutil
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from PIL import Image, ImageOps
except ImportError:
    print("Pillow vantar. Keyrðu fyrst:  pip install Pillow")
    sys.exit(1)

import build_index as bi

SITE = Path(__file__).resolve().parent.parent / "site"
VALID_EXT = {".jpg", ".jpeg"}


def read_list(path):
    names = set()
    for line in Path(path).read_text(encoding="utf-8-sig").splitlines():
        line = line.strip().replace("\\", "/")
        if line and not line.startswith("#"):
            names.add(line.lower())
    return names


def make_thumb(src, dst, size):
    if dst.exists():
        return "kept"
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im.draft("RGB", (size * 2, size * 2))  # hraðari JPEG-afkóðun
        im = ImageOps.exif_transpose(im)
        im.thumbnail((size, size), Image.LANCZOS)
        im.convert("RGB").save(dst, "JPEG", quality=80, optimize=True)
    return "made"


def write_lists(data_dir):
    gj = data_dir / "geojson"
    gj.mkdir(parents=True, exist_ok=True)
    names = sorted(p.name for p in gj.iterdir() if p.suffix.lower() in (".geojson", ".json"))
    (data_dir / "geojson-list.json").write_text(json.dumps({"files": names}, ensure_ascii=False), encoding="utf-8")
    (data_dir / "shapes-list.json").write_text(json.dumps({"items": []}), encoding="utf-8")
    d3 = data_dir / "dxf3d"
    files = []
    if d3.is_dir():
        for p in sorted(d3.glob("*.dxf3d")):
            st = p.stat()
            files.append({"name": p.name, "size": st.st_size, "mtime": int(st.st_mtime)})
    (data_dir / "dxf3d-list.json").write_text(json.dumps({"files": files}), encoding="utf-8")
    return names, files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", nargs="?")
    ap.add_argument("--lists-only", action="store_true", help="bara uppfæra geojson-/dxf3d-lista (engar myndir)")
    ap.add_argument("--list", help="textaskrá með skráarnöfnum (eitt á línu) - bara þessar myndir")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--thumb-size", type=int, default=640)
    ap.add_argument("--copy-photos", action="store_true", help="afrita frummyndir í photos/")
    args = ap.parse_args()

    if args.lists_only:
        geo, dxf = write_lists(SITE / "data")
        print(f"geojson-lög: {len(geo)}; 3D-skrár: {len(dxf)}")
        return 0
    if not args.folder:
        ap.error("vantar myndamöppu (eða --lists-only)")
    root = Path(args.folder)
    if not root.is_dir():
        print(f"Mappa fannst ekki: {root}")
        return 1
    wanted = read_list(args.list) if args.list else None

    files = [p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in VALID_EXT]
    if wanted is not None:
        files = [
            p for p in files
            if p.name.lower() in wanted or str(p.relative_to(root)).replace("\\", "/").lower() in wanted
        ]
    print(f"{len(files)} myndir valdar úr {root}")

    data_dir = SITE / "data"
    data_dir.mkdir(exist_ok=True)
    csv_path = data_dir / "photos.csv"
    existing = bi.load_existing(csv_path)

    rows, no_gps, errors = [], [], []
    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futs = {pool.submit(bi.process_file, p, root, existing, False): p for p in files}
        for i, fut in enumerate(as_completed(futs), 1):
            kind, payload = fut.result()
            p = futs[fut]
            if kind in ("reused", "ok"):
                rows.append(payload)
            elif kind == "no_gps":
                no_gps.append(p.name)
            else:
                errors.append(payload)
            if i % 50 == 0:
                print(f"  lesið {i}/{len(files)}")

    rows.sort(key=lambda r: r["filename"])
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=bi.FIELDNAMES, delimiter=";", extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)

    by_name = {str(p.relative_to(root)).replace("\\", "/"): p for p in files}
    made = kept = 0
    total_bytes = 0
    thumbs_dir = SITE / "thumbs"
    photos_dir = SITE / "photos"
    with ThreadPoolExecutor(max_workers=args.threads) as pool:
        futs = {}
        for r in rows:
            src = by_name.get(r["filename"])
            if not src:
                continue
            total_bytes += src.stat().st_size
            futs[pool.submit(make_thumb, src, thumbs_dir / r["filename"], args.thumb_size)] = src
            if args.copy_photos:
                dst = photos_dir / r["filename"]
                if not dst.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
        for fut in as_completed(futs):
            try:
                if fut.result() == "made":
                    made += 1
                else:
                    kept += 1
            except Exception as err:
                errors.append((futs[fut].name, f"smámynd: {err}"))

    geo, dxf = write_lists(data_dir)

    pano = sum(1 for r in rows if str(r.get("pano")) == "1")
    thumb_mb = sum(p.stat().st_size for p in thumbs_dir.rglob("*") if p.is_file()) / 1048576 if thumbs_dir.is_dir() else 0
    print()
    print(f"photos.csv: {len(rows)} myndir ({pano} 360°), smámyndir: {made} nýjar, {kept} fyrir")
    print(f"Frummyndir samtals: {total_bytes / 1073741824:.2f} GB; smámyndir í repo: {thumb_mb:.0f} MB")
    print(f"geojson-lög: {len(geo)}; 3D-skrár: {len(dxf)}")
    if no_gps:
        print(f"{len(no_gps)} myndir án GPS slepptar: {', '.join(no_gps[:5])}{' ...' if len(no_gps) > 5 else ''}")
    for name, err in errors:
        print(f"VILLA {name}: {err}")
    if not args.copy_photos:
        print("Frummyndir ekki afritaðar (sjá --copy-photos). Settu þær á staðinn sem photoBase í site-config.js bendir á.")
    elif total_bytes > 240 * 1048576:
        print("ATH: frummyndir > 240 MB - of stórt fyrir Azure Static Web Apps Free (250 MB).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
