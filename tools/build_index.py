#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Byggir photos.csv fyrir EFLA netdrif - myndakort.

Fer í gegnum myndamöppuna (og allar undirmöppur), les GPS-EXIF úr hverri
.jpg/.jpeg mynd, og skrifar EINA CSV skrá (photos.csv) inn í sömu möppu:

    filename;lat;lon;date;heading;category;mtime;pano

"pano" er 1 fyrir 360° myndir (um 2:1 hlutfall, >= 3000 px breiðar) og 0 annars.
Eldri línur án "pano" fá gildið fyllt inn í næstu keyrslu með því að lesa bara
haus myndarinnar (hratt) - sleppa má því með --no-backfill-pano.

Vefsíðan sækir svo þessa einu skrá í stað þess að lesa EXIF úr hverri mynd
í vafranum - miklu hraðara fyrir stór söfn.

Vaxandi (incremental) uppfærsla: ef skráarnafn er nú þegar í photos.csv er
það treyst óbreytt og EKKERT lesið af netdrifinu fyrir það (hvorki stat né
EXIF) - bara ALVEG NÝ skráarnöfn eru sótt og lesin. Þetta er hraðvirkasta
leiðin þegar bara er verið að bæta við nýjum myndum (algengasta tilfellið).
Myndum sem er eytt af disknum er sjálfkrafa sleppt úr nýju skránni.

Ef mynd er ENDURVISTUÐ með SAMA skráarnafni (t.d. leiðrétt/endurtekin mynd)
uppgötvast breytingin EKKI sjálfkrafa í þessum hraðvirka ham, því skráar-
nafnið eitt og sér er notað - engin breytingardagsetning er athuguð. Notaðu
--verify-mtime til að fá öruggari (en hægari - ein netferð á HVERJA mynd,
líka óbreyttar) hegðun sem ber saman breytingardagsetningu hverrar skráar.

Samhliða lestur: hvert skráaropnun/lestur á netdrifi er í raun ein SMB-
"round trip" - á hægu drifi/VPN er þessi netbið sjálf (ekki EXIF-úrvinnslan)
það sem tekur tímann. Því er skránum dreift á nokkra þræði samtímis (sjá
--threads), sem getur margfaldað hraðann á netdrifi án þess að nokkuð
breytist í niðurstöðunni.

"category" er nafn EFSTU undirmöppu (miðað við myndamöppuna sjálfa), t.d.
ef myndin liggur í "<myndamappa>/Jarðkönnun/2024/img.jpg" verður flokkurinn
"Jarðkönnun". Skipulagðu safnið í möppur með þeim nöfnum sem þú vilt nota
sem flokka (t.d. "Jarðkönnun", "Drónamyndir", "Verkmyndir").

Uppsetning (einu sinni):
    pip install Pillow

Keyrsla:
    python build_index.py "Y:/.../Myndamappa"
    python build_index.py "Y:/.../Myndamappa" --threads 24
    python build_index.py "Y:/.../Myndamappa" --verify-mtime
(eða tvísmelltu á byggja-gagnagrunn.bat, sem notar sömu möppu og kortið)

Keyrðu þetta aftur (t.d. vikulega) þegar nýjum myndum hefur verið bætt við.
"""
import sys
import csv
import argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from PIL import Image, ExifTags
except ImportError:
    print("Pillow vantar. Keyrðu fyrst:  pip install Pillow")
    sys.exit(1)

VALID_EXT = {".jpg", ".jpeg"}
FIELDNAMES = ["filename", "lat", "lon", "date", "heading", "category", "mtime", "pano"]


def is_pano(width, height):
    """360° (equirectangular) mynd: um 2:1 hlutfall og nógu stór."""
    return width >= 3000 and height > 0 and abs(width / height - 2.0) < 0.05
DEFAULT_THREADS = 16


def read_tags(path):
    """Skilar samræmdu dict af IFD0 + Exif-subIFD tögum (nöfn, ekki tölur)."""
    img = Image.open(path)
    size = img.size
    exif = img.getexif()
    if not exif:
        return {}, {}, size
    tags = {}
    for tag_id, value in exif.items():
        tags[ExifTags.TAGS.get(tag_id, tag_id)] = value
    try:
        exif_sub = exif.get_ifd(ExifTags.IFD.Exif)
        for tag_id, value in exif_sub.items():
            tags[ExifTags.TAGS.get(tag_id, tag_id)] = value
    except Exception:
        pass
    gps_ifd = {}
    try:
        raw_gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
        for tag_id, value in raw_gps.items():
            gps_ifd[ExifTags.GPSTAGS.get(tag_id, tag_id)] = value
    except Exception:
        pass
    return tags, gps_ifd, size


def gps_to_decimal(gps):
    if "GPSLatitude" not in gps or "GPSLongitude" not in gps:
        return None, None

    def to_degrees(value):
        d, m, s = value
        return float(d) + float(m) / 60 + float(s) / 3600

    try:
        lat = to_degrees(gps["GPSLatitude"])
        if gps.get("GPSLatitudeRef") == "S":
            lat = -lat
        lon = to_degrees(gps["GPSLongitude"])
        if gps.get("GPSLongitudeRef") == "W":
            lon = -lon
        return lat, lon
    except Exception:
        return None, None


def get_date(tags):
    for key in ("DateTimeOriginal", "DateTimeDigitized", "DateTime"):
        val = tags.get(key)
        if val:
            try:
                d, t = str(val).split(" ")
                return f"{d.replace(':', '-')}T{t}"
            except Exception:
                return str(val)
    return ""


def get_heading(gps):
    val = gps.get("GPSImgDirection")
    if val is None:
        return ""
    try:
        return round(float(val), 1)
    except Exception:
        return ""


def load_existing(out_path):
    """Skilar {filename: row} úr núverandi photos.csv, ef hún er til."""
    existing = {}
    if not out_path.exists():
        return existing
    try:
        with open(out_path, "r", newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f, delimiter=";")
            for row in reader:
                if row.get("filename"):
                    existing[row["filename"]] = row
    except Exception as err:
        print(f"Gat ekki lesið eldri photos.csv ({err}) - byrja upp á nýtt.")
    return existing


def backfill_pano(path, prev):
    """Fyllir inn 'pano' fyrir eldri línu: bara haus myndarinnar er lesinn (hratt)."""
    row = dict(prev)
    try:
        with Image.open(path) as im:
            w, h = im.size
        row["pano"] = "1" if is_pano(w, h) else "0"
    except Exception:
        pass
    return row


def process_file(path, root, existing, verify_mtime, do_backfill=True):
    """Keyrt í vinnuþræði: endurnýtir eða les EXIF úr einni mynd.

    Sjálfgefið (verify_mtime=False) er skráarnafn eitt og sér notað til að
    ákveða endurnýtingu - EKKERT lesið af drifinu (hvorki stat né EXIF) fyrir
    skráarnöfn sem eru þegar í photos.csv. Með verify_mtime=True er auk þess
    stat() kallað og breytingardagsetning borin saman (öruggara, hægara).

    Skilar tuple (kind, payload) þar sem kind er "reused" | "ok" | "no_gps" | "error".
    """
    rel = path.relative_to(root)
    filename = str(rel).replace("\\", "/")
    prev = existing.get(filename)

    if prev and not verify_mtime:
        if do_backfill and prev.get("pano") in (None, ""):
            prev = backfill_pano(path, prev)
        return ("reused", prev)

    try:
        mtime = str(path.stat().st_mtime)
    except Exception as err:
        return ("error", (filename, str(err)))

    if prev and prev.get("mtime") == mtime:
        return ("reused", prev)

    try:
        tags, gps, size = read_tags(path)
        lat, lon = gps_to_decimal(gps)
    except Exception as err:
        return ("error", (filename, str(err)))

    if lat is None or lon is None:
        return ("no_gps", None)

    category = rel.parts[0] if len(rel.parts) > 1 else ""
    row = {
        "filename": filename,
        "lat": lat,
        "lon": lon,
        "date": get_date(tags),
        "heading": get_heading(gps),
        "category": category,
        "mtime": mtime,
        "pano": "1" if is_pano(*size) else "0",
    }
    return ("ok", row)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("folder")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS)
    parser.add_argument("--verify-mtime", action="store_true")
    parser.add_argument("--no-backfill-pano", action="store_true")
    try:
        args = parser.parse_args()
    except SystemExit:
        print('Notkun: python build_index.py "<mappa-með-myndum>" [--threads N] [--verify-mtime] [--no-backfill-pano]')
        sys.exit(1)

    root = Path(args.folder)
    if not root.is_dir():
        print(f"Finn ekki möppuna: {root}")
        sys.exit(1)

    out_path = root / "photos.csv"
    existing = load_existing(out_path)
    if existing:
        print(f"Fann {len(existing)} myndir í núverandi photos.csv - athuga hvað hefur breyst...")

    print(f"Skoða: {root}")
    paths = [
        p for p in sorted(root.rglob("*"))
        if p.suffix.lower() in VALID_EXT and p.name != "photos.csv"
    ]
    total = len(paths)
    mode = "athuga breytingardagsetningu á öllum" if args.verify_mtime else "treysta þekktum skráarnöfnum"
    print(f"Fann {total} myndir - vinn úr þeim með {args.threads} þráðum samtímis ({mode})...")

    rows = []
    reused = 0
    processed = 0
    skipped = 0
    done = 0

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        futures = {
            executor.submit(process_file, p, root, existing, args.verify_mtime, not args.no_backfill_pano): p
            for p in paths
        }
        for future in as_completed(futures):
            kind, payload = future.result()
            done += 1

            if kind == "reused":
                rows.append(payload)
                reused += 1
            elif kind == "ok":
                rows.append(payload)
                processed += 1
            elif kind == "no_gps":
                skipped += 1
            else:  # error
                filename, err = payload
                print(f"  Sleppti {filename}: {err}")
                skipped += 1

            if done % 200 == 0:
                print(f"  ... {done}/{total} skoðaðar ({processed} nýlesnar, {reused} óbreyttar)")

    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)

    print(
        f"\nLokið: {len(rows)} myndir í {out_path}\n"
        f"({processed} nýjar/breyttar - EXIF lesið, {reused} óbreyttar - endurnýttar, "
        f"{skipped} sleppt - engin GPS-gögn, af {total} skoðuðum skrám samtals)."
    )


if __name__ == "__main__":
    main()
