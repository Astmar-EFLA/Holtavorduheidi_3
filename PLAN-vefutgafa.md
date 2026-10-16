# Vefútgáfa fyrir Landsnet – staða og opnar spurningar (2026-10-16)

## Ákveðið
- Sér repo (afrit af efla-netdisk-map, engin tenging við local-útgáfuna). Nafn: Landsnet-myndavefsja (tillaga).
- Bara HH3 og valdar myndir; 360° myndir verða að vera skoðanlegar (3D/DXF-lag bíður).
- Hýsing: GitHub (einkarepo) + Azure Static Web Apps með innskráningu (IT).
- Frummyndir ekki minnkaðar -> geymdar utan síðunnar (Azure Blob), smámyndir í repo.

## Opnar spurningar
1. **Blob Storage:** hver stofnar hann og hvernig er aðgangur lokaður? Tveir kostir:
   a) Blob með SAS-tóken í `photoBase` (tóken sjáanlegt innskráðum notendum, rennur út, þarf að endurnýja),
   b) lítil Azure Function (SWA "managed API", `/api/img/<nafn>`) sem les úr lokuðu Blob með managed identity;
      varin af sömu innskráningu. Hreinni lausn; þarf smá kóða (ekki gert enn).
2. **GeoJSON fyrir HH3:** LN_linur/LN_mostur (staðbundnu) innihalda ekki HH3. Þarf skrá frá Landsneti/EFLU
   (línur + möstur, helst með turn-heiti). Þangað til sýnir kortið bara myndirnar.
3. **Hvaða myndir:** mappa/listi yfir myndirnar sem eiga að birtast (`tools/build_site.py --list`).
4. **Innskráning:** hlutverkið `reader` með boði (Free/Standard). Ef Landsnet vill nota eigin Entra-tenant þarf
   Standard + eigin aad-skráningu.
5. **Bakgrunnskort:** Esri og OSM eru ókeypis og opin. EFLU WMS (loftmyndasafn) er ekki með (lykilorðsvarið).
6. **Utanaðkomandi skriftur:** Leaflet/three.js/exifr o.fl. koma af unpkg/jsdelivr/cdnjs. Ef Landsnet-net lokar
   á þau: afrita í `site/vendor/` (ekki gert).

## Næst (eftir svör)
- [ ] GeoJSON HH3 í `site/data/geojson/`
- [ ] Útfæra myndir úr Blob (kostur a eða b)
- [ ] Stofna GitHub-repo (einkarepo, user pushar), IT stofnar Static Web App
- [ ] 3D/DXF-lag (bíður)
