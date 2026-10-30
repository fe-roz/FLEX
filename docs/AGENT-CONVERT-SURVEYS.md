# For an AI agent: setting up FLEX with a caver's data

You are helping someone get their caves and surface data into **FLEX** (an
open-source browser app: CesiumJS globe + cave surveys + LiDAR, served by a
small Node server on their own computer). The goal: they open FLEX, choose
their project, and everything is there — caves placed, surface features in
folders, digs marked as leads, estimated passages shown with the caves.

You don't need to change FLEX. You convert their data, describe the project in
one JSON file, and run `tools/make_flex_project.py`, which writes a project
file FLEX imports with one click (or installs it directly).

The person-facing walk-through is `docs/GETTING-STARTED-CAVES.md`; point them
to it for anything they'll do by hand.

## Ground rules

- **Locations are sensitive.** Cavers guard cave positions. Never send
  coordinates, survey files or the project anywhere (web services, pastebins,
  public repos, issue reports, other people). Everything stays on their
  computer. Prefer survey files with **relative** coordinates (entrance at
  0,0,0); the entrance position goes only into the project JSON.
- **Don't invent data.** If a reading, a coordinate or an elevation is missing
  or unreadable, leave it out and tell them. Report loop misclosures; don't
  "fix" them.
- Station names are **case-sensitive** and must be unique within a cave
  (`A1` ≠ `a1`). If surveys reuse names for different stations, prefix them and
  say so.
- Keep their originals untouched; write everything new into one working folder
  (e.g. `flex-import/`).

## 1. Install and start FLEX

Needs git, Node.js 18+ and Python 3 (standard library only for the tools).

```
git clone https://github.com/fe-roz/FLEX.git
cd FLEX
npm install
copy Tokens.js.example Tokens.js        (macOS / Linux: cp …)
node server.js                          (leave it running)
```

They open http://localhost:8081/index.html in Chrome or Edge. `Tokens.js`
takes their own Cesium ion token (free at cesium.com) for 3D world terrain —
ask them to paste it in themselves; FLEX works without it on a flat globe.
Don't commit anything in the FLEX folder; `user_files/` (their data) is
gitignored.

## 2. Ask for / collect

- **Survey data** for each cave, in whatever form (step 3).
- For each cave: **which station is the entrance** and its **latitude,
  longitude (WGS84, decimal degrees)** and **elevation**. Without these the cave
  still imports and FLEX asks them to place it the first time.
- **Surface features**: GPX / KML / GeoJSON (CalTopo, Gaia, GPS exports). KMZ:
  unzip it and use its `doc.kml`.
- **Digs and other leads at the surface**: points (any of those formats), with
  whatever they know per point (description, type of dig, air, priority…).
- **Estimated underground passages / streams**: a line, and its elevation
  (one value, or per-vertex z).

## 3. Survey data → `.plt`

FLEX reads Compass `.plt`, Breakout `.json` and Walls shapefile exports; the
project tool needs `.plt`. Routes:

| They have | Do this |
|---|---|
| Compass project (`.mak`, `.dat`) | Compass compiles/plots it to a `.plt`. Or read the `.dat` shots into the CSV below |
| Survex `.svx` / `.3d` | `cavern file.svx` → `.3d`; `survexport --plt file.3d file.plt` (check `survexport --help`) |
| Therion | export the model to Survex/Compass if their version can, else shots → CSV |
| TopoDroid, CaveWhere, SexyTopo… | export Compass `.dat`, Survex `.svx` or a CSV of shots |
| Breakout `.json` / Walls shapefiles | they can import these in FLEX directly (🕳 Cave → + Import); for the project tool, a `.plt` is still needed |
| A spreadsheet / handwritten shots | the CSV below |
| Only a 3D model (OBJ, PLY, a rendering) | not survey data — no stations. Ask for the survey it came from |

### `tools/shots_to_plt.py` (CSV of shots → `.plt`)

```
survey,date,from,to,length,azimuth,inclination,back_azimuth,back_inclination,left,right,up,down,comment
A,1994-07-15,E1,A1,10.3,92,-4,,,1,2,3,0.5,
A,1994-07-15,A1,A2,8.1,15,30,,,2,2,2,2,
```

```
python tools/shots_to_plt.py cave.csv cave.plt --cave "Cave name" --units ft --decl 13.2 --origin E1
```

- `--units ft|m` of length and LRUD; output in feet (Compass convention).
- `--decl`: magnetic declination for the survey **date and place** (east +),
  added to every azimuth so the file is in true north; `0` if already
  corrected. Different trips, different declinations → correct the azimuths in
  the CSV first.
- Backsights are averaged in; LRUD belong to the row's **from** station;
  splays (`to` empty or `-`) are skipped; `--origin` (the entrance) is 0,0,0.
- It reports shots **not connected** to the origin (usually a station-name
  typo) and each loop's misclosure. Pass these on.

### Writing a `.plt` yourself

```
Z  minN maxN minE maxE minV maxV               bounding box (optional)
SCAVE NAME
NA  D 7 15 1994  Cmain line                     survey code A, date M D YYYY, comment
M  0.00  0.00  0.00  SE1  P 1.0 3.0 4.0 2.0     move: northing easting vertical (feet), station, LRUD
D  0.00  10.00 0.00  SA1  P 2.0 2.0 2.0 2.0     draw to the next station
X  minN maxN minE maxE minV maxV
```

`M` starts a traverse, each `D` draws from the previous point. `P` is
**left up down right** in feet; negative = not measured. Relative coordinates
need no `G` (UTM zone) / `O` (datum) lines.

## 4. Describe the project: `flex-project.json`

Put the files and this JSON in one folder (paths are relative to it):

```json
{
  "project": "Ridge area",
  "author": "Sam",
  "caves": [
    { "name": "Ridge Cave", "plt": "ridge.plt",
      "entrance": { "station": "E1", "lat": 45.12345, "lon": -100.56789, "elev_m": 1478 } }
  ],
  "features": [
    { "file": "surface.kml", "folder": "Surface" },
    { "file": "tracks.gpx",  "folder": "Approach tracks" }
  ],
  "leads": [
    { "file": "digs.geojson", "folder": "Digs", "types": ["Sediment dig"] }
  ],
  "estimated": [
    { "name": "Stream (estimated)", "file": "stream.geojson", "elev_m": 1380 }
  ]
}
```

- **caves**: one per `.plt`. `declination` only if the file's azimuths are
  still magnetic. No `entrance` → FLEX asks where it goes on first load.
- **features**: points, lines and areas become the project's own features;
  folders inside a KML (or a GeoJSON `folder` property like `"Ridge/Pits"`)
  are kept under the given folder.
- **leads**: every **point** becomes a surface point *and* a lead on it (a "?"
  in FLEX). Per-point properties used when present: `name`/`title`,
  `description`/`desc`, `status` (open, confirmed, unknown, surveyed, deadend,
  mopped, notalead), `types` (list or "a, b" — FLEX's list: Open survey,
  Mop-up, Bedrock dig, Sediment dig, Boulder choke, Free climb, Aid climb, Aid
  traverse, Rope drop / pit, Dive, Unknown; others are accepted), `priority`
  (1–5), `potential`, `air` (None, Blowing in, Blowing out, Strong in, Strong
  out), `water`, `w`/`h`/`seen` (metres), `gear`, `effort`, `found`.
  Section-level `types` / `status` are defaults.
- **estimated**: each line becomes a "cave" (one survey `EST`, stations
  `EST0…`) placed at its first vertex — so it draws and colours like the caves.
  Give `elev_m` (or z values on the line).
- **Heights**: FLEX's globe uses heights above the WGS84 **ellipsoid**, not sea
  level: `elev_m` = elevation above sea level + the local geoid height (≈ −30 m
  in much of the western US; EGM96/GEOID calculators give it). Within a few
  metres is fine; they can fine-tune with 🎯 Georectify.

## 5. Build it

```
python tools/make_flex_project.py flex-import/flex-project.json
```

writes `flex-import/FLEX-sync-ridge-area.zip`. They import it in FLEX:
**📁 (top left) → Sync files → ⇩ Import…** → the zip. The project opens.

Or install straight into their FLEX (no clicks; FLEX can be running):

```
python tools/make_flex_project.py flex-import/flex-project.json --install .
```

then they reload the page and pick the project with the **📁** button.

Re-running after changes and importing / installing again **updates** the same
project: records keep stable ids, so nothing is duplicated, and things they
added in FLEX stay. But every record in the JSON is written again with the
file's values, so edits they made in FLEX to *those* records (a lead's status,
a cave moved with Georectify) are replaced. After the first import, prefer a
JSON with only the new data, or ask before re-running.

The tool checks that each entrance station exists in its `.plt` and reports
what went in. Read the report back to them.

## 6. Check with them

- Each cave sits where it should: entrance on the entrance, passages heading
  the right way (if rotated: declination applied twice or not at all).
- 📍 Features → Project features: folders and points as expected;
  double-click a row to fly there.
- 📁 → Leads: the digs, each with a "?" on the map.
- The estimated stream at a plausible depth (cave colour "Depth" helps).

## 7. Optional: CalTopo

If they share a CalTopo map: 📁 → CalTopo map (a private map needs their own
🔑 key — they enter it; never handle it yourself). A cave can be tied to its
CalTopo entrance marker with a line `flex: cave=<cave name>; station=<entrance
station>` in the marker's description (guide, section 5).
