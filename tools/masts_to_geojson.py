#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Býr til GeoJSON með möstrum úr CSV (Mastranúmer,x,y,KKS - ISN93/EPSG:3057).

    python tools/masts_to_geojson.py "<skra>.csv" [--out site/data/geojson/HH3_mostur.geojson]

Eiginleikinn "Mastranúmer" er valinn sjálfkrafa sem merkimiði á kortinu.
Ef site/data/photos.csv er til er mynd tengd við hvert mastur þegar skráarnafn
hennar er "HH3-<Mastranúmer>_NNN.jpg" (t.d. "HH3-61 BS_001.JPG" -> "61 BS"); sett
í eiginleikann "Mynd" og birtist sem hlekkur í sprettglugga mastursins.
Keyrðu svo:  python tools/build_site.py --lists-only
"""
import csv
import json
import re
import argparse
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"


def read_rows(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp1252"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text.splitlines()[0]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    return list(csv.DictReader(text.splitlines(), delimiter=delim))


PHOTO_RE = re.compile(r"^HH3-(.+?)_\d+\.jpe?g$", re.I)
LAYER_COLOR = "#ffb300"


def photo_index(path):
    idx = {}
    p = Path(path)
    if not p.exists():
        return idx
    with open(p, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            fn = row["filename"]
            m = PHOTO_RE.match(fn.split("/")[-1])
            if m:
                idx[m.group(1).strip().lower()] = fn
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("--photos", default=str(SITE / "data" / "photos.csv"))
    ap.add_argument("--out", default=str(SITE / "data" / "geojson" / "HH3_mostur.geojson"))
    args = ap.parse_args()

    rows = read_rows(args.csv)
    photos = photo_index(args.photos)
    linked = 0
    feats = []
    for r in rows:
        name = (r.get("Mastranúmer") or r.get("Mastranumer") or "").strip()
        try:
            x, y = float(r["x"].replace(",", ".")), float(r["y"].replace(",", "."))
        except (KeyError, ValueError):
            print(f"sleppi línu án hnita: {r}")
            continue
        props = {"Mastranúmer": name, "KKS": (r.get("KKS") or "").strip()}
        if name.lower() in photos:
            props["Mynd"] = photos[name.lower()]
            linked += 1
        feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Point", "coordinates": [x, y]},
        })
    fc = {
        "type": "FeatureCollection",
        "name": "HH3_mostur",
        "layerColor": LAYER_COLOR,
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::3057"}},
        "features": feats,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(fc, ensure_ascii=False), encoding="utf-8")
    print(f"{len(feats)} möstur ({linked} með mynd) -> {out}")


if __name__ == "__main__":
    main()
