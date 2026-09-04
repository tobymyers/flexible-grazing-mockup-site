# Pipeline notes — riparian exclusion data bundles

Written by the pipeline agent. Last updated 2 Sep 2026 (evening), after Toby's
review of the deployed mockup. Built by `06 gis data/pipeline.py` per SPEC.md
section 4, with the Toby-approved tree-canopy amendment to the selection rule
and the corridor-hole fix described below.

## Results at a glance

| Region | Mesic segments (raw -> deduped) | Filtered (checksum) | Final exclusion | vs checksum | Bundle size |
|---|---|---|---|---|---|
| red-canyon | 9264 raw -> 9063 deduped (201 dupes) | 4013 segments / 4,863 ac (checksum ~4013 / ~4,863) | 5,576 ac in 664 parts | +14.7% | 849 KB |
| bear-lake | 6154 raw -> 5907 deduped (247 dupes) | 1250 segments / 4,841 ac (checksum ~1250 / ~4,841) | 4,991 ac in 394 parts | +3.1% | 473 KB |

Both inside the +/-15% acceptance band (SPEC section 8) and well under the
1.5 MB per-region budget. EPSG:4326, 6-decimal coordinates, 0 invalid
geometries.

## Water gaps: none shipped (changed 2 Sep 2026 pm)

Toby places ALL water gaps by hand in the app. `water_gaps.geojson` is an
empty FeatureCollection in both regions, and the exclusion polygons ship
CONTINUOUS — no pre-punched 30 m gap holes. The old gap-picking code
(`pick_water_gaps` / `gap_geoms`) stays in `pipeline.py`, cleanly disabled,
in case defaults are ever wanted again.

## The corridor holes Toby found: root cause and fix

**What Toby saw** (Red Canyon): straight diagonal edges cutting across the
Little Popo Agie near (-108.617, 42.741), with the river channel and its
gravel bars NOT excluded; and uncovered stretches of green creek bottom
along the ranch HQ reach (-108.628 to -108.632, 42.66-42.68).

**Root cause — three stacked problems:**
1. The Mesic Analysis Platform valley-bottom data MASKS PERSISTENT OPEN
   WATER. The river surface itself never appears in any mesic segment, so a
   pipeline built only on filtered mesic segments always has a hole where
   the actual water is. (Verified: the channel at the flagged spot is a
   46 ac NWI "R3UBG" riverine polygon; the nearest mesic segment there is a
   gravel-bar cell with Veg_Pct 38.5 that correctly fails the rule.)
2. The first build clipped NWI wetland supplements to a 10 m fringe of the
   filtered segments. That stopped riverine polygons from bridging channel
   holes, and the clip boundary + flat-capped 30 m water-gap corridors
   produced the unnatural straight diagonal edges. (The diagonal edge in the
   screenshot was the water gap 1 subtraction corridor — now gone entirely.)
3. Road carve-outs could cut straight across the river ribbon where a TIGER
   track crosses the creek, re-severing the corridor.

**The fix (current rule):**
- NWI RIVERINE-system wetlands supplement the corridor. Strict intersection
  with the filtered mesic union is required; single polygons over 50 ac are
  dropped unless they are R2/R3 river surfaces; everything is clipped to a
  10 m band around the corridor, which the approved 20 m morphological
  closing then knits shut.
- EXCEPTION that answers Toby's screenshot: R2/R3 river-surface polygons
  within 50 m of the region's main named creeks (Red Canyon Creek + Little
  Popo Agie River; Big Creek + Fish Haven Creek) come in WHOLE — the open
  water and its gravel bars are the very thing the exclusion protects.
  Small riverine slivers (<= 5 ac, e.g. gravel bars) touching those river
  surfaces ride along. Measured cost: ~50 ac at Red Canyon.
- 3DHP river-surface waterbody polygons (layer 60, type "River" only, < 300
  ac, strict intersection, same 10 m band) fill channel holes too. Lake-type
  waterbodies stay OUT (traps #15/#16).
- Road carve-outs never cut the river surface or its 15 m bank ribbon: a
  road crossing the water is a bridge or ford, and whether cows may cross
  there is a manual water-gap decision in the app, not an automatic hole.
- Emergent and forested/shrub wetlands are no longer unioned in at all —
  measured, they added hundreds of acres with zero channel-bridging value.

**Why the tightening:** the first attempt at this fix (whole wetlands under
50 ac + 60 m band) blew the acreage gate to +42% at Red Canyon. The levers
used to pull it back inside +/-15%: riverine-only supplements, strict
intersection (not near-miss), the 50 ac single-polygon cap, and the 10 m
band clip (measured at Red Canyon: band 10 -> +14.5%, band 15 -> +15.3%,
band 20 -> +16.0% before carve-outs).

**Verified continuity (on the shipped files, cross-lines through each flagged
coordinate, holes checked inside the covered span):**
- Little Popo Agie at (-108.617, 42.741): east-west and north-south lines
  both CONTINUOUS (no interior hole); the 46 ac channel polygon is ~96%
  inside the exclusion (the rest is outside the corridor's reach).
- HQ reach at (-108.630, 42.670): both cross-lines CONTINUOUS; 96% of the
  creek line through Toby's stated window (-108.632..-108.628, 42.66-42.68)
  is covered, with one 54 m stretch open where the surrounding mesic
  segments genuinely fail the approved selection rule (Veg+Tree just under
  60. The rule was NOT weakened; widening it is Toby's call).
- Bear Lake: exclusion overlap with the USFWS refuge = 0.0 ac (the pipeline
  subtracted 9.7 ac of refuge overlap after smoothing); overlap with Bear
  Lake open water = 0.0 ac (6.1 ac of closing bleed over the shoreline was
  subtracted). Any waterbody of 300 ac or more (Bear Lake ~70,000 ac, Mud
  Lake marsh ~3,500 ac) is subtracted outright and can never enter the
  exclusion.

## Other judgment calls (unchanged from the first build)

1. **Ownership skips the "Private or Unknown" SMA layer** (persistent
   HTTP 502 server-side; the app draws private land with no fill anyway).
   Shipped owner classes: BLM, USFS, USFWS (Bear Lake only), State.
2. **Spec-named allotments pulled by ID.** Three Creeks (UT00024), Laketown
   (UT04011) and Montpelier Canyon-1 (ID14139) do not touch the working
   bbox; they are fetched by ST_ALLOT code and shipped whole. All spec-named
   allotments verified present in both bundles.
3. **Paddock polygons** are simple rotated rectangles around a ~2.2 km
   stretch of the main creek, buffered 500 m — now anchored on the midpoint
   of the longest main-creek run inside the exclusion (they used to anchor
   on default water gap 1, which no longer exists). Hand-adjust freely.
4. **Exclusion feature tags**: each exclusion part carries the dominant
   `strm_type` and area-weighted mean `veg_pct` of its mesic segments.

## Road carve-outs — NEED TOBY'S VISUAL CONFIRMATION (trap #11)

Rule: 5 m half-width (10 m total), subtracted only where a road centerline
intersects the exclusion — but never across the river surface or its 15 m
bank ribbon (see fix above). TIGER lines drift 10-50 m, so every carve-out
must be eyeballed against imagery before the demo. "NO" in the creek column
= no mapped creek line within 30 m — check those first (classic TIGER
phantom tracks).

Red Canyon: 129 carve-outs, 114 near a creek line.
Bear Lake: 131 carve-outs, 103 near a creek line.

### Red Canyon carve-outs
| # | Road | Length in zone (m) | Crosses a creek line? | Lon | Lat |
|---|---|---|---|---|---|
| 1 | (unnamed track) | 301 | yes | -108.77817 | 42.7035 |
| 2 | (unnamed track) | 99 | yes | -108.6328 | 42.7519 |
| 3 | Sinks Canyon Rd | 19 | NO | -108.78115 | 42.77137 |
| 4 | (unnamed track) | 87 | yes | -108.54952 | 42.64755 |
| 5 | (unnamed track) | 12 | NO | -108.64903 | 42.7599 |
| 6 | (unnamed track) | 107 | yes | -108.65237 | 42.60407 |
| 7 | Willow Creek Rd | 664 | yes | -108.68172 | 42.73423 |
| 8 | Indian Trl | 421 | yes | -108.76388 | 42.62808 |
| 9 | (unnamed track) | 481 | NO | -108.69666 | 42.55916 |
| 10 | N Rock Creek Rd | 6 | yes | -108.76282 | 42.54569 |
| 11 | (unnamed track) | 573 | yes | -108.6867 | 42.55824 |
| 12 | (unnamed track) | 103 | yes | -108.64551 | 42.58651 |
| 13 | (unnamed track) | 80 | yes | -108.68009 | 42.73499 |
| 14 | (unnamed track) | 179 | yes | -108.67976 | 42.59889 |
| 15 | (unnamed track) | 179 | yes | -108.72689 | 42.60822 |
| 16 | (unnamed track) | 32 | yes | -108.75977 | 42.52633 |
| 17 | (unnamed track) | 23 | yes | -108.71274 | 42.58153 |
| 18 | (unnamed track) | 178 | yes | -108.76443 | 42.52388 |
| 19 | (unnamed track) | 64 | yes | -108.71541 | 42.61006 |
| 20 | (unnamed track) | 20 | yes | -108.54242 | 42.65747 |
| 21 | (unnamed track) | 134 | yes | -108.76169 | 42.60908 |
| 22 | (unnamed track) | 108 | yes | -108.71449 | 42.71405 |
| 23 | (unnamed track) | 86 | yes | -108.6498 | 42.53469 |
| 24 | (unnamed track) | 577 | yes | -108.64196 | 42.55141 |
| 25 | (unnamed track) | 116 | yes | -108.5913 | 42.52034 |
| 26 | (unnamed track) | 185 | yes | -108.73108 | 42.71418 |
| 27 | (unnamed track) | 144 | yes | -108.68828 | 42.54804 |
| 28 | (unnamed track) | 23 | yes | -108.64496 | 42.7157 |
| 29 | (unnamed track) | 144 | yes | -108.64291 | 42.7141 |
| 30 | Pass Creek Rd | 91 | yes | -108.76084 | 42.61001 |
| 31 | (unnamed track) | 82 | yes | -108.67376 | 42.60935 |
| 32 | Three Points Rd | 258 | NO | -108.64014 | 42.73178 |
| 33 | (unnamed track) | 130 | yes | -108.71907 | 42.70955 |
| 34 | (unnamed track) | 92 | yes | -108.6262 | 42.75748 |
| 35 | Harvey Morgan Ln | 99 | NO | -108.65853 | 42.76377 |
| 36 | (unnamed track) | 1170 | yes | -108.54921 | 42.52777 |
| 37 | (unnamed track) | 12 | NO | -108.68944 | 42.55972 |
| 38 | (unnamed track) | 296 | yes | -108.56709 | 42.68834 |
| 39 | (unnamed track) | 93 | yes | -108.54516 | 42.69297 |
| 40 | (unnamed track) | 120 | yes | -108.64799 | 42.76133 |
| 41 | (unnamed track) | 81 | yes | -108.67372 | 42.57976 |
| 42 | (unnamed track) | 72 | NO | -108.62813 | 42.73078 |
| 43 | (unnamed track) | 33 | NO | -108.68934 | 42.55986 |
| 44 | Pass Creek Rd | 90 | yes | -108.76025 | 42.60952 |
| 45 | (unnamed track) | 61 | yes | -108.58724 | 42.62131 |
| 46 | (unnamed track) | 23 | yes | -108.69907 | 42.53317 |
| 47 | (unnamed track) | 220 | yes | -108.67436 | 42.59538 |
| 48 | (unnamed track) | 66 | yes | -108.71402 | 42.56011 |
| 49 | Hollow Rd | 59 | yes | -108.76306 | 42.5455 |
| 50 | (unnamed track) | 49 | yes | -108.61676 | 42.74439 |
| 51 | (unnamed track) | 66 | yes | -108.72058 | 42.64959 |
| 52 | (unnamed track) | 7 | NO | -108.66812 | 42.68638 |
| 53 | Calvert Ln | 259 | yes | -108.65341 | 42.72877 |
| 54 | (unnamed track) | 26 | yes | -108.7148 | 42.5321 |
| 55 | Forest Rd 352 | 421 | yes | -108.76388 | 42.62808 |
| 56 | (unnamed track) | 486 | yes | -108.62745 | 42.72521 |
| 57 | (unnamed track) | 36 | yes | -108.70594 | 42.51988 |
| 58 | (unnamed track) | 317 | yes | -108.67347 | 42.58816 |
| 59 | (unnamed track) | 519 | yes | -108.54821 | 42.65111 |
| 60 | (unnamed track) | 7 | NO | -108.6896 | 42.55902 |
| 61 | (unnamed track) | 93 | yes | -108.72103 | 42.6402 |
| 62 | Wolf Trl | 43 | yes | -108.7751 | 42.68229 |
| 63 | (unnamed track) | 251 | yes | -108.70355 | 42.72551 |
| 64 | (unnamed track) | 99 | NO | -108.64864 | 42.75923 |
| 65 | Field Station Rd | 301 | yes | -108.77513 | 42.77524 |
| 66 | (unnamed track) | 194 | yes | -108.61708 | 42.74033 |
| 67 | Atlantic City Rd | 27 | yes | -108.72139 | 42.52508 |
| 68 | (unnamed track) | 205 | yes | -108.63109 | 42.62965 |
| 69 | Dallas Dome Rd | 58 | yes | -108.63055 | 42.73449 |
| 70 | (unnamed track) | 585 | yes | -108.66467 | 42.66789 |
| 71 | (unnamed track) | 401 | yes | -108.54714 | 42.64221 |
| 72 | (unnamed track) | 195 | yes | -108.58268 | 42.52277 |
| 73 | (unnamed track) | 347 | yes | -108.63855 | 42.58762 |
| 74 | Peaks Rd | 946 | yes | -108.76941 | 42.67615 |
| 75 | (unnamed track) | 408 | yes | -108.59761 | 42.65234 |
| 76 | (unnamed track) | 108 | yes | -108.77833 | 42.56026 |
| 77 | Fort Stambaugh Loop | 548 | yes | -108.67102 | 42.52129 |
| 78 | (unnamed track) | 405 | yes | -108.55757 | 42.66706 |
| 79 | (unnamed track) | 191 | yes | -108.55146 | 42.579 |
| 80 | (unnamed track) | 369 | yes | -108.5523 | 42.67418 |
| 81 | (unnamed track) | 104 | yes | -108.71999 | 42.6205 |
| 82 | (unnamed track) | 123 | yes | -108.62083 | 42.61265 |
| 83 | (unnamed track) | 332 | yes | -108.69023 | 42.53897 |
| 84 | (unnamed track) | 286 | yes | -108.7692 | 42.52903 |
| 85 | (unnamed track) | 32 | yes | -108.60755 | 42.64615 |
| 86 | (unnamed track) | 200 | yes | -108.63836 | 42.77763 |
| 87 | Rock Creek Canal Rd | 40 | yes | -108.76257 | 42.54561 |
| 88 | Limestone Ln | 97 | yes | -108.71958 | 42.55742 |
| 89 | (unnamed track) | 53 | yes | -108.64663 | 42.58315 |
| 90 | (unnamed track) | 65 | yes | -108.63835 | 42.59402 |
| 91 | (unnamed track) | 49 | yes | -108.68679 | 42.73329 |
| 92 | (unnamed track) | 90 | yes | -108.63701 | 42.73308 |
| 93 | (unnamed track) | 58 | yes | -108.70995 | 42.65053 |
| 94 | (unnamed track) | 275 | yes | -108.70803 | 42.65122 |
| 95 | Speyer Dr | 175 | NO | -108.64973 | 42.75816 |
| 96 | (unnamed track) | 196 | yes | -108.67309 | 42.59036 |
| 97 | (unnamed track) | 186 | yes | -108.60914 | 42.55133 |
| 98 | (unnamed track) | 198 | yes | -108.70789 | 42.57409 |
| 99 | (unnamed track) | 242 | yes | -108.72209 | 42.61474 |
| 100 | Surveyor Rd | 166 | yes | -108.66891 | 42.75977 |
| 101 | (unnamed track) | 531 | yes | -108.62257 | 42.52305 |
| 102 | (unnamed track) | 455 | yes | -108.55976 | 42.69356 |
| 103 | Field Station Rd | 56 | yes | -108.77482 | 42.77684 |
| 104 | (unnamed track) | 105 | yes | -108.55833 | 42.67935 |
| 105 | (unnamed track) | 187 | yes | -108.58363 | 42.57374 |
| 106 | (unnamed track) | 98 | yes | -108.71856 | 42.61359 |
| 107 | (unnamed track) | 153 | NO | -108.6385 | 42.77028 |
| 108 | (unnamed track) | 72 | yes | -108.59601 | 42.65422 |
| 109 | (unnamed track) | 84 | yes | -108.66042 | 42.53756 |
| 110 | (unnamed track) | 70 | yes | -108.54241 | 42.66508 |
| 111 | (unnamed track) | 379 | yes | -108.57628 | 42.58181 |
| 112 | (unnamed track) | 83 | yes | -108.59736 | 42.55514 |
| 113 | Canal Rd | 40 | yes | -108.7616 | 42.5396 |
| 114 | (unnamed track) | 14 | yes | -108.58714 | 42.66308 |
| 115 | (unnamed track) | 288 | yes | -108.63422 | 42.75285 |
| 116 | (unnamed track) | 135 | yes | -108.69734 | 42.61203 |
| 117 | (unnamed track) | 49 | yes | -108.61855 | 42.64498 |
| 118 | Dallas Dome Rd | 71 | yes | -108.61655 | 42.74125 |
| 119 | (unnamed track) | 71 | yes | -108.61679 | 42.73888 |
| 120 | (unnamed track) | 146 | yes | -108.67482 | 42.59331 |
| 121 | South Pass | 49 | yes | -108.72343 | 42.52723 |
| 122 | (unnamed track) | 114 | yes | -108.76837 | 42.52791 |
| 123 | Red Canyon Rd | 543 | yes | -108.64969 | 42.66935 |
| 124 | Carpenter Rd | 43 | yes | -108.68239 | 42.77904 |
| 125 | (unnamed track) | 38 | NO | -108.64853 | 42.55858 |
| 126 | (unnamed track) | 49 | yes | -108.67061 | 42.60907 |
| 127 | Peaks Rd | 352 | yes | -108.69103 | 42.69908 |
| 128 | (unnamed track) | 13 | yes | -108.68777 | 42.56455 |
| 129 | (unnamed track) | 78 | NO | -108.68947 | 42.55936 |

### Bear Lake carve-outs
| # | Road | Length in zone (m) | Crosses a creek line? | Lon | Lat |
|---|---|---|---|---|---|
| 1 | SIXMILE RD | 382 | yes | -111.19182 | 41.85254 |
| 2 | (unnamed) | 26 | yes | -111.19394 | 41.85244 |
| 3 | (unnamed) | 55 | yes | -111.1945 | 41.85307 |
| 4 | (unnamed) | 100 | NO | -111.29723 | 41.8508 |
| 5 | (unnamed) | 84 | yes | -111.19401 | 41.85271 |
| 6 | (unnamed) | 83 | NO | -111.19355 | 41.85298 |
| 7 | CISCO RD | 51 | NO | -111.29928 | 41.85015 |
| 8 | (unnamed) | 125 | yes | -111.2677 | 41.86608 |
| 9 | (unnamed) | 53 | yes | -111.15308 | 41.87197 |
| 10 | (unnamed) | 42 | yes | -111.1534 | 41.87231 |
| 11 | (unnamed) | 358 | yes | -111.15292 | 41.87584 |
| 12 | (unnamed) | 77 | NO | -111.37612 | 41.85661 |
| 13 | MEADOWVILLE RD | 114 | NO | -111.37005 | 41.85826 |
| 14 | MEADOWVILLE RD | 243 | NO | -111.37779 | 41.86221 |
| 15 | (unnamed) | 28 | NO | -111.37661 | 41.86146 |
| 16 | MEADOWVILLE RD | 13 | yes | -111.39066 | 41.85326 |
| 17 | (unnamed) | 634 | yes | -111.15485 | 41.88432 |
| 18 | (unnamed) | 22 | yes | -111.17748 | 41.89488 |
| 19 | ROUNDYS | 206 | yes | -111.19234 | 41.92145 |
| 20 | ROUNDYS | 50 | yes | -111.19177 | 41.92143 |
| 21 | (unnamed) | 1916 | yes | -111.20969 | 41.9073 |
| 22 | SOUTH EDEN RD | 534 | yes | -111.20061 | 41.9213 |
| 23 | (unnamed) | 118 | yes | -111.25142 | 41.93187 |
| 24 | SOUTH EDEN RD | 1480 | yes | -111.26002 | 41.92357 |
| 25 | (unnamed) | 194 | yes | -111.253 | 41.93757 |
| 26 | (unnamed) | 55 | yes | -111.24828 | 41.93849 |
| 27 | (unnamed) | 25 | yes | -111.2487 | 41.9384 |
| 28 | (unnamed) | 6 | yes | -111.24861 | 41.93852 |
| 29 | (unnamed) | 614 | yes | -111.22992 | 41.94118 |
| 30 | (unnamed) | 67 | yes | -111.22048 | 41.94432 |
| 31 | (unnamed) | 12 | yes | -111.22088 | 41.94447 |
| 32 | (unnamed) | 255 | yes | -111.18028 | 41.95143 |
| 33 | (unnamed) | 287 | yes | -111.1509 | 41.98375 |
| 34 | (unnamed) | 86 | yes | -111.20688 | 41.96263 |
| 35 | NORTH EDEN RD | 279 | yes | -111.23695 | 41.9837 |
| 36 | (unnamed) | 1459 | yes | -111.15327 | 41.96637 |
| 37 | (unnamed) | 375 | yes | -111.15059 | 41.97887 |
| 38 | (unnamed) | 361 | yes | -111.18245 | 41.97771 |
| 39 | (unnamed) | 172 | yes | -111.15667 | 41.99158 |
| 40 | MEADOWVILLE RD | 560 | yes | -111.39597 | 41.85178 |
| 41 | COOKS RD | 5 | yes | -111.39424 | 41.85355 |
| 42 | VALLEY VIEW DR | 33 | yes | -111.40749 | 41.90695 |
| 43 | SWEETWATER PKWY | 38 | yes | -111.40935 | 41.9138 |
| 44 | HODGES CANYON RD | 52 | yes | -111.40791 | 41.91487 |
| 45 | COOKS RD | 67 | yes | -111.40914 | 41.86363 |
| 46 | (unnamed) | 1255 | yes | -111.41439 | 41.86986 |
| 47 | (unnamed) | 67 | yes | -111.43869 | 41.87697 |
| 48 | (unnamed) | 46 | yes | -111.4399 | 41.88006 |
| 49 | (unnamed) | 31 | yes | -111.43834 | 41.8924 |
| 50 | RICHARDSON | 327 | yes | -111.44509 | 41.89432 |
| 51 | SWEETWATER PKWY | 28 | yes | -111.4154 | 41.88961 |
| 52 | PANORAMA DR | 14 | yes | -111.41867 | 41.88906 |
| 53 | (unnamed) | 275 | yes | -111.42592 | 41.90966 |
| 54 | (unnamed) | 349 | yes | -111.4344 | 41.91471 |
| 55 | LAKEVIEW DR | 33 | yes | -111.43167 | 41.92756 |
| 56 | HILLSIDE DR | 33 | yes | -111.43021 | 41.92847 |
| 57 | LOGAN RD | 88 | yes | -111.43464 | 41.92916 |
| 58 | HODGES CANYON RD | 882 | yes | -111.41763 | 41.91232 |
| 59 | (unnamed) | 393 | yes | -111.41601 | 41.94883 |
| 60 | GARDEN CITY CANYON | 21 | yes | -111.44111 | 41.93727 |
| 61 | CEDAR RIDGE DR | 44 | yes | -111.43869 | 41.93763 |
| 62 | CEDAR RIDGE DR | 21 | yes | -111.43189 | 41.94047 |
| 63 | (unnamed) | 58 | yes | -111.43352 | 41.95897 |
| 64 | (unnamed) | 24 | yes | -111.42868 | 41.95916 |
| 65 | (unnamed) | 104 | yes | -111.43891 | 41.96057 |
| 66 | (unnamed) | 118 | yes | -111.43889 | 41.96128 |
| 67 | GEORGIA LN | 37 | yes | -111.42505 | 41.98392 |
| 68 | BEAR LAKE BLVD | 231 | yes | -111.41069 | 41.98541 |
| 69 | FLORENCE WAY | 6 | yes | -111.4084 | 41.98445 |
| 70 | 660 W | 21 | yes | -111.40813 | 41.98516 |
| 71 | 2140 N | 87 | NO | -111.40965 | 41.98572 |
| 72 | LAKOTA SUB | 95 | NO | -111.41042 | 41.98593 |
| 73 | 730 W | 101 | NO | -111.41029 | 41.98604 |
| 74 | CODU DR | 150 | NO | -111.41136 | 41.98443 |
| 75 | SWAN CREEK RD | 153 | NO | -111.41165 | 41.98547 |
| 76 | SWAN CREEK RD | 304 | yes | -111.42202 | 41.98593 |
| 77 | PATRICIA DR | 135 | yes | -111.42486 | 41.98413 |
| 78 | SWAN CREEK SPRING RD | 71 | yes | -111.42486 | 41.98463 |
| 79 | SWAN CREEK SPRING RD | 68 | yes | -111.42719 | 41.98494 |
| 80 | (unnamed) | 26 | yes | -111.42519 | 41.99493 |
| 81 | Hickock | 26 | yes | -111.43117 | 42.00391 |
| 82 | Holiday Dr | 30 | yes | -111.42788 | 42.00418 |
| 83 | (unnamed track) | 56 | yes | -111.43319 | 42.01142 |
| 84 | Kestral | 23 | yes | -111.43319 | 42.01634 |
| 85 | Fish Haven Rd | 198 | yes | -111.41345 | 42.03799 |
| 86 | Mtn Way | 31 | yes | -111.42131 | 42.02548 |
| 87 | (unnamed track) | 66 | yes | -111.40725 | 42.0612 |
| 88 | Jericho Loop | 289 | yes | -111.40701 | 42.12119 |
| 89 | (unnamed track) | 7 | yes | -111.40825 | 42.12188 |
| 90 | Jacobs Canyon Rd | 355 | yes | -111.40743 | 42.09776 |
| 91 | (unnamed track) | 199 | NO | -111.39549 | 42.13735 |
| 92 | (unnamed track) | 1411 | yes | -111.41149 | 42.14248 |
| 93 | Fish Haven Canyon Rd | 953 | yes | -111.43579 | 42.04229 |
| 94 | (unnamed track) | 16 | yes | -111.4423 | 42.07184 |
| 95 | Jacobs Canyon Rd | 233 | yes | -111.4442 | 42.07165 |
| 96 | Green Canyon Rd | 1340 | yes | -111.43308 | 42.10619 |
| 97 | Minnetonka Cave Rd | 744 | yes | -111.44385 | 42.1144 |
| 98 | St Charles Creek Rd | 744 | yes | -111.44385 | 42.1144 |
| 99 | (unnamed track) | 86 | yes | -111.44977 | 42.11174 |
| 100 | (unnamed track) | 274 | NO | -111.39902 | 42.14929 |
| 101 | (unnamed track) | 238 | yes | -111.44694 | 42.11291 |
| 102 | Dry Canyon Rd | 1512 | yes | -111.44048 | 42.12977 |
| 103 | Worm Creek Rd | 37 | yes | -111.44033 | 42.14995 |
| 104 | (unnamed track) | 6 | yes | -111.23469 | 42.021 |
| 105 | Choke Cherry Rd | 214 | yes | -111.23666 | 42.02015 |
| 106 | (unnamed track) | 12 | yes | -111.23561 | 42.02087 |
| 107 | (unnamed track) | 84 | yes | -111.3952 | 42.03463 |
| 108 | (unnamed track) | 48 | yes | -111.39584 | 42.03533 |
| 109 | 100 E | 92 | NO | -111.38592 | 42.11531 |
| 110 | Transtrum Rd | 831 | NO | -111.37816 | 42.11367 |
| 111 | N Beach Rd | 1127 | yes | -111.38202 | 42.12337 |
| 112 | 300 N | 376 | NO | -111.38934 | 42.11774 |
| 113 | 100 W | 959 | yes | -111.39161 | 42.12162 |
| 114 | 200 N | 176 | NO | -111.38736 | 42.11571 |
| 115 | Lifton Rd | 73 | NO | -111.39115 | 42.12332 |
| 116 | (unnamed track) | 307 | NO | -111.3912 | 42.13591 |
| 117 | (unnamed track) | 90 | NO | -111.3923 | 42.13699 |
| 118 | (unnamed track) | 167 | NO | -111.39086 | 42.13688 |
| 119 | (unnamed track) | 756 | yes | -111.39025 | 42.14048 |
| 120 | Eastshore Rd | 96 | yes | -111.25659 | 42.09373 |
| 121 | (unnamed track) | 52 | yes | -111.16122 | 42.01926 |
| 122 | Poverty Flats Rd | 10 | yes | -111.15005 | 42.0605 |
| 123 | (unnamed track) | 96 | NO | -111.26209 | 42.09286 |
| 124 | Indian Creek Rd | 621 | yes | -111.24376 | 42.09486 |
| 125 | (unnamed track) | 380 | yes | -111.38782 | 42.1361 |
| 126 | (unnamed track) | 98 | NO | -111.38985 | 42.13642 |
| 127 | (unnamed track) | 128 | NO | -111.38736 | 42.13686 |
| 128 | (unnamed track) | 142 | NO | -111.389 | 42.13687 |
| 129 | (unnamed track) | 452 | NO | -111.38735 | 42.13781 |
| 130 | Michaelson Rd | 1363 | yes | -111.38406 | 42.1477 |
| 131 | Powerline Rd | 29 | NO | -111.36629 | 42.13929 |

## Rebuilding

`cd "06 gis data" && <venv>/bin/python pipeline.py [red-canyon|bear-lake]`
(raw pulls cached in `06 gis data/derived/cache/`; delete a cache file to
force a re-pull).
