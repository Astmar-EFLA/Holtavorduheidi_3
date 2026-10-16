# Landsnet myndavefsjá – HH3 (Holtavörðuheiðarlína 3)

Vefútgáfa af `efla-netdisk-map` fyrir Landsnet: valdar myndir (þ.m.t. 360°) á korti
með línum og möstrum. Eingöngu statísk síða sem keyrir í Azure Static Web Apps með
innskráningu. Staðbundna útgáfan (`efla-netdisk-map`) er óbreytt og sér repo.

## Uppbygging

```
site/                      <- það sem er birt (app_location í workflow)
  index.html app.js style.css site-config.js
  staticwebapp.config.json innskráning (hlutverkið "reader")
  data/photos.csv          búin til af build_site.py
  data/geojson/*.geojson   línur/möstur HH3 (settu skrárnar hér)
  data/dxf3d/*.dxf3d       3D-lag (BÍÐUM - tómt þar til ákveðið)
  thumbs/                  smámyndir (búnar til)
  photos/                  frummyndir - aðeins ef þær eru í síðunni (sjá "Myndir")
tools/
  build_site.py            býr til data/ og thumbs/ úr myndamöppu
  build_index.py           EXIF-hjálparföll (notað af build_site.py)
.github/workflows/         sjálfvirk útgáfa á Azure við push á main
```

## Uppfæra myndirnar

1. Settu valdar myndir í eina möppu (t.d. afrit af völdum myndum úr `360-Myndir`),
   eða skrifaðu lista yfir skráarnöfn í `valdar.txt` (eitt á línu).
2. `pip install Pillow` (einu sinni), svo:
   ```
   python tools/build_site.py "<mappa>" [--list valdar.txt]
   ```
3. Settu GeoJSON-skrár fyrir HH3 (línur og möstur, ISN93/EPSG:3057 eða WGS84) í
   `site/data/geojson/` og keyrðu skriftuna aftur (hún uppfærir listann).
4. `git add -A && git commit && git push`  -> GitHub Action birtir síðuna.

Prófun á tölvunni: `python -m http.server 8117 -d site` og opna http://localhost:8117
(innskráning virkar ekki staðbundið; hún er bara í Azure).

## Myndir (1 GB komast ekki í síðuna)

| Staður | Mörk |
|---|---|
| Azure Static Web Apps | Free 250 MB, Standard 500 MB í heild |
| GitHub repo | skrá < 100 MB, repo helst < 1 GB |

Frummyndirnar (360° myndir eru ~35 MB hver) fara því í **Azure Blob Storage** og
`site/site-config.js` (`photoBase`) bendir þangað. Smámyndir og gögn (nokkur MB)
eru áfram í repo. Ef safnið reynist lítið má nota `--copy-photos` og taka
`site/photos/` út úr `.gitignore`.

Blob-aðgangur þarf að vera lokaður (ekki opinn fyrir alla) - sjá opna spurningu í
`PLAN-vefutgafa.md` (IT).

## Prófun með Cloudflare R2 (hugmyndaprófun)

Aðeins til að prófa hugmyndina á meðan beðið er eftir Azure Blob frá IT. R2 er
þriðji aðili - settu bara myndir þangað sem má fara þangað, og eyddu bucket þegar
prófun lýkur. Opin r2.dev-slóð er aðgengileg ÖLLUM sem þekkja hana.

1. Cloudflare > R2 > Create bucket (t.d. `hh3-myndir`).
2. Settings > CORS policy: límdu inn `tools/r2-cors.json` (settu inn rétta slóð vefsins;
   `http://localhost:8117` er fyrir prófun á tölvunni).
3. Settings > Public access: kveiktu á r2.dev-slóðinni (aðeins próf) - eða tengdu eigið lén.
4. Settu myndirnar inn með SÖMU skráarnöfnum/möppuskipan og í `photos.csv`
   (dashboard > Upload, eða `rclone`/`wrangler` með þínum eigin lyklum - ekki setja
   lykla í repo).
5. Settu slóðina í `site/site-config.js`:
   `photoBase: 'https://pub-xxxxxxxx.r2.dev/'` (endar á `/`).
6. `python -m http.server 8117 -d site` og opnaðu http://localhost:8117.

Skoðarinn setur `crossOrigin='anonymous'` á myndirnar; án CORS-hausa frá bucket
birtist 360° myndin ekki (WebGL) og útflutningur virkar ekki.

## Innskráning

`staticwebapp.config.json` krefst hlutverksins `reader` á allar slóðir. Notendur
eru boðnir í Azure-gáttinni (Static Web App > Role management > Invite, hlutverk
`reader`) - bara boðnir komast inn. Aðrir innskráningarveitendur en Microsoft
(aad) eru lokaðir.

## Útgáfa (IT)

1. IT stofnar Static Web App og tengir við þetta GitHub-repo (`main`, `app_location: site`).
2. Token fer í GitHub-secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.
3. Bjóða notendum (hlutverk `reader`).
