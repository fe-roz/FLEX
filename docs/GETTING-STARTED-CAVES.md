# Getting your caves into FLEX

A walk-through for someone setting FLEX up for their own area: install it,
make a project, bring in cave surveys, place them, add surface features, share
with a friend, and (optionally) link a CalTopo map.

**Fastest route:** give an AI agent (Claude or similar) the note
[`AGENT-CONVERT-SURVEYS.md`](AGENT-CONVERT-SURVEYS.md) and your data. It can
install FLEX, convert your surveys, and build the whole project — caves placed,
surface features in folders, digs as leads, an estimated stream — as one file
you import with a click (step 2b).

> **Locations are sensitive.** Survey files with real coordinates, CalTopo maps
> and FLEX sync files all reveal where caves are. Share them only with people
> who should know. Nothing you load into FLEX leaves your computer unless you
> send it (a sync file, an export) — FLEX's own `user_files/` folder is never
> uploaded anywhere.

---

## 1. Install and run

You need [Node.js](https://nodejs.org) 18 or newer and git.

```
git clone https://github.com/fe-roz/FLEX.git
cd FLEX
npm install
copy Tokens.js.example Tokens.js      (macOS / Linux: cp Tokens.js.example Tokens.js)
node server.js
```

Open **http://localhost:8081/index.html** in Chrome or Edge.

- `Tokens.js` holds your own API keys. The Cesium ion token (free account at
  cesium.com) gives the 3D world terrain; without it FLEX still works on a flat
  globe.
- Exporting terrain for the offline viewer / FLEX Field needs Python with PDAL
  (see the main README). Not needed for anything below.
- Keep FLEX up to date with **🔄 Updates** in the top bar (or `git pull`).

## 2. Make a project

Top left, the **📁 button** shows which project is open ("No project" at
first). Click it → **＋ New** → name it after your area.

A project holds everything for one area — its caves (survey files and where
they sit on the map), point clouds, CalTopo map, surface features, documents,
notes and leads. **💾 Save** (and autosave every few seconds) keeps it up to
date. Switching project puts the current one away and loads the other; **No
project** is FLEX without any of this.

A project is local: it needs no CalTopo map and no account.

## 2b. Or import a whole project at once

If someone (or your agent, with `tools/make_flex_project.py`) built the project
for you, you get a `FLEX-sync-….zip`. In FLEX: **📁 → Sync files → ⇩ Import…**
→ pick it. The project opens with everything in it. Importing a newer version
of the same file later updates the project; nothing is duplicated.

## 3. Bring in a cave survey

**🕳 Cave → + Import PLT / Breakout / Walls**, then pick the file:

| You have | Give FLEX |
|---|---|
| Compass | the `.plt` (Compass makes it when you compile/plot the project) |
| Breakout | its `.json` export |
| Walls | its shapefile export — select **all** the files it writes |
| Survex `.3d`, Therion, TopoDroid, CaveWhere, a spreadsheet of shots… | convert to `.plt` first — see `AGENT-CONVERT-SURVEYS.md` |

The importer shows what it read (surveys, stations), then asks **where the cave
is**:

- **Anchor a station to the globe** (most survey files): choose a station —
  usually the entrance — and give its real position:
  - **📍 Screen center** (puts the station at the middle of the view) or
    **🌐 Cesium globe** (click the spot): fly to the entrance first; the
    height is read from the terrain, or
  - **✏ Manual entry**: latitude, longitude (decimal degrees, WGS84) and
    elevation in metres.
  - **Magnetic declination**: if the file's azimuths are magnetic and were
    *not* corrected when it was made, fill it in (**🧭 Auto-fetch** gets it for
    that place). Compass/Survex output is usually already corrected — leave it
    blank then.
- **Use file coordinates as-is**: only for files already in absolute UTM;
  set the zone.

**Load Survey** draws it. Use **⌖** in the cave list to fly to it.

### Getting the placement right

- The cave list's **🎯 Georectify** pins more stations to known positions
  (a second entrance, a GPS'd surface station, a radio-location) and bends the
  survey to fit. One good anchor plus one more pin fixes most rotation errors.
- **Heights:** by default caves follow the point clouds' height datum; the
  Georectify panel can switch a cave to "as in file".
- **🎨 Style** per cave: colours per survey, station dots and names, passage
  walls from LRUDs (Blocky / Smooth).
- **Colour by** at the top of the cave list: survey, elevation, depth below
  ground, passage difficulty.

### Save it into the project

With the project open, press **💾 Save**. The survey file itself and where you
placed it go into the project (📁 → *What this project loads* lists them).
Opening the project later loads them back exactly there.

A newer version of the survey? Open the cave's info in the cave list → **⟳ Replace
survey file…**: placement, pins and style stay; the next save puts the new
file in the project.

## 4. Surface features

**📍 Features → Project features** (needs an open project):

- **＋ Point / ＋ Line / ＋ Area**: click on the map; double-click or Enter to
  finish a line or area, Backspace removes the last point, Esc cancels.
- **＋ Folder**: folders can nest and have a colour; tick boxes show / hide.
- **⇪ Import**: GPX, KML or GeoJSON — becomes a folder named after the file,
  keeping its own folders.
- **⇩ Download**: a folder (or everything) as KML (keeps folders), GeoJSON or
  GPX — e.g. to import into CalTopo.
- In the list: **click** a feature to highlight it, **double-click** to fly
  there, **✏️** to edit (name, description, folder, colour) or delete. Clicking
  it on the map opens it too.
- Labels look like Cesium's own on the globe; with LiDAR loaded they are drawn
  on top so they show through the point cloud.

These are *your project's* features — "FLEX only, not in CalTopo".

## 4b. Leads

- **At a surface point** (a dig, a blowing hole): open the point (✏️) →
  **❓ Make it a lead…** — status, what it needs (sediment dig, bedrock dig,
  climb…), priority, air, size, notes. A **?** marks it on the map.
- **In the cave**: click a station → its card → **❓ Lead**.
- **📁 → Leads** lists them all (open / closed), click to fly there; **⇩ CSV**.
- Leads travel with the project to friends and to FLEX Field.

## 4c. Estimated passages (an underground stream…)

A line you believe follows something underground — an estimated stream, a
projected passage — can be shown as a cave: it then draws with the caves and
takes the cave colour modes (elevation, depth below ground…).
`tools/make_flex_project.py` turns a line (GeoJSON / KML / GPX) and its
elevation into one (step 2b); it appears as a cave named e.g. "Stream
(estimated)" with stations EST0, EST1…

## 5. CalTopo (optional)

**📁 Project → CalTopo map** (a project must be open):

- **Public map**: paste its address (`caltopo.com/m/XXXX`) and **Load**.
- **Private map**: add a **🔑 CalTopo key** first (it stays on your computer):
  - *Team account*: an admin creates a service account with **READ** access
    (Team Admin → Details) → credential ID, secret, team ID.
  - *Personal account* (unofficial): see the FLEX help text in the key dialog.
  - Then **Pick a map…** lists your maps.
- The map's folders appear under **Map overlay folders** with show / hide.
- FLEX only reads CalTopo; it never changes your map. Edit in CalTopo — FLEX
  refreshes every 30 s (adjustable).

### Linking a cave to its CalTopo entrance marker

1. 📁 → *What this project loads* → **Copy CalTopo tag** next to the cave. You
   get a line like `flex: cave=My Cave; station=A1`.
2. In CalTopo, paste that line into the description of the entrance marker.
3. In FLEX: 📍 Features → **Cave entrances** lists tagged markers → **Place the
   cave here**. FLEX puts that station on the marker (height from the terrain)
   and saves it in the project.

The cave name must match the cave in the project; the station must exist in
the survey.

## 6. Sharing with a friend

📁 → **Sync files**:

- **Make: changes since last** (or **Everything** the first time) writes a
  `FLEX-sync-….zip`: the project's caves (survey files + placement), features,
  notes, leads and documents.
- Send it however you like; your friend uses **⇩ Import…** in their FLEX. Both
  sides keep their own history; nothing is overwritten — edits to the same
  thing on two computers are shown side by side.
- Your CalTopo key is never in a sync file; each person adds their own.

## 7. Taking it underground

**📦 Export** bakes an area — terrain, imagery, caves — into a single offline
viewer (opens in any browser) or a map for the **FLEX Field** Android app. See
the main README.

---

### When something looks wrong

- *The cave is rotated or offset*: check declination (step 3), then pin a
  second station with 🎯 Georectify.
- *The cave floats above / sinks below the ground*: Georectify → Heights.
- *"Survey file not on this computer yet"*: you opened a project from a sync
  file that didn't include the cave — ask for an **Everything** sync file.
- *A private CalTopo map doesn't load*: check the 🔑 key (Change key…) and that
  your account / team can open the map on caltopo.com.
- *A cave or estimated stream sits tens of metres too high or low*: heights in
  FLEX are above the ellipsoid, not sea level (about 30 m different in much of
  the western US). Fix it with 🎯 Georectify, or ask whoever built the project
  to correct `elev_m`.
