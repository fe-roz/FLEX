"""Verify the numeric core against synthetic clouds with known ground truth."""
import sys, time
import numpy as np
sys.path.insert(0, '/home/claude/flexwork')
import lidar_derive as L

rng = np.random.default_rng(42)
EXTENT = 400.0          # metres square
def truth_ground(x, y):
    """Known ground: a 25% grade running east, plus rolling relief."""
    return (1000.0 + 0.25 * x
            + 12.0 * np.sin(x / 55.0) * np.cos(y / 70.0)
            + 3.0 * np.sin(x / 13.0))

def make_cloud(n_ground=400_000, n_veg=250_000):
    # ── ground, class 2 ──────────────────────────────────────────────────────
    gx = rng.uniform(0, EXTENT, n_ground)
    gy = rng.uniform(0, EXTENT, n_ground)
    gz = truth_ground(gx, gy) + rng.normal(0, 0.03, n_ground)   # 3 cm ranging noise
    gc = np.full(n_ground, 2, dtype=np.uint8)

    # ── vegetation: thick brush only in the eastern half, y < 200 ────────────
    vx = rng.uniform(0, EXTENT, n_veg)
    vy = rng.uniform(0, EXTENT, n_veg)
    thick = (vx > 200) & (vy < 200)
    h = np.where(thick,
                 rng.uniform(0.35, 1.45, n_veg),      # understory, in-band
                 rng.uniform(3.0, 18.0, n_veg))       # canopy, above band
    vz = truth_ground(vx, vy) + h
    vc = np.where(h < 2.0, 3, 5).astype(np.uint8)     # low veg / high veg

    # ── A PIT. Returns 8 m below ground, which a classifier calls noise (7). ─
    npit = 4000
    pa = rng.uniform(0, 2 * np.pi, npit)
    pr = rng.uniform(0, 6.0, npit)
    px = 120 + pr * np.cos(pa)
    py = 300 + pr * np.sin(pa)
    pd = rng.uniform(2.0, 9.0, npit)
    pz = truth_ground(px, py) - pd
    pc = np.full(npit, 7, dtype=np.uint8)             # class 7 == "low noise"

    # ── Real garbage: multipath, hundreds of metres down ─────────────────────
    ngar = 300
    rx = rng.uniform(0, EXTENT, ngar)
    ry = rng.uniform(0, EXTENT, ngar)
    rz = truth_ground(rx, ry) - rng.uniform(300, 900, ngar)
    rc = np.full(ngar, 7, dtype=np.uint8)

    x = np.concatenate([gx, vx, px, rx])
    y = np.concatenate([gy, vy, py, ry])
    z = np.concatenate([gz, vz, pz, rz])
    c = np.concatenate([gc, vc, pc, rc])
    return x, y, z, c, dict(n_pit=npit, n_garbage=ngar)

x, y, z, cls, meta = make_cloud()
print(f"synthetic cloud: {len(x):,} points  "
      f"(pit={meta['n_pit']:,} class-7, garbage={meta['n_garbage']} class-7)")
print()

# ── 1. ground recovery vs cell size and statistic ───────────────────────────
print("1. Ground surface recovery  (error against analytic truth, metres)")
print("   cell  stat     direct%   mean|err|   p95|err|   max|err|   signed bias")
probe_x = rng.uniform(20, EXTENT - 20, 20000)
probe_y = rng.uniform(20, EXTENT - 20, 20000)
probe_t = truth_ground(probe_x, probe_y)
best = None
for cell in (1.0, 2.0, 4.0):
    for stat in ("median", "mean", "min"):
        g = L.grid_for_points(x, y, cell)
        if stat == "min":
            # the intuitive choice, measured so the slope bias is visible
            ncells = g.nx * g.ny
            flat = g.flat(x, y)
            zlo, zhi = L.plausible_ground_band(z, cls)
            isg = (cls == 2) & (z >= zlo) & (z <= zhi)
            gr = np.full(ncells, np.inf)
            np.minimum.at(gr, flat[isg], z[isg])
            gr[~np.isfinite(gr)] = np.nan
            gr = gr.reshape(g.shape).astype(np.float32)
            direct = np.isfinite(gr)
        else:
            gr, direct = L.build_ground_grid(x, y, z, cls, g, stat=stat)
        gr = L.fill_pyramid(gr)
        got = L.sample_bilinear(gr, g, probe_x, probe_y)
        signed = got - probe_t
        err = np.abs(signed)
        print(f"   {cell:4.1f}  {stat:7s} {direct.mean()*100:6.1f}%  "
              f"{err.mean():9.3f}  {np.percentile(err,95):9.3f}  {err.max():9.3f}"
              f"  {signed.mean():+9.3f}")
        if stat == "median" and cell == 2.0:
            best = (g, gr)
print()

# ── 2. HAG accuracy on the 2 m median grid ──────────────────────────────────
g, ground = best
hag = L.compute_hag(x, y, z, ground, g)
true_hag = z - truth_ground(x, y)
e = np.abs(hag - true_hag)
print(f"2. HAG error on 2 m median grid: mean {e.mean():.3f} m, "
      f"p95 {np.percentile(e,95):.3f} m")
print()

# ── 3. THE RULE: sub-ground returns must survive ────────────────────────────
pit_sel = (cls == 7) & (true_hag > -50)      # the real pit, not the multipath
keep = L.filter_by_hag(hag, low_cut=-20.0, high_cut=120.0)
print("3. Sub-ground returns survive the filter")
print(f"   pit points in cloud        : {pit_sel.sum():,}")
print(f"   pit points kept            : {(pit_sel & keep).sum():,}  "
      f"({(pit_sel & keep).sum()/pit_sel.sum()*100:.1f}%)")
gar_sel = (cls == 7) & (true_hag < -50)
print(f"   multipath garbage in cloud : {gar_sel.sum():,}")
print(f"   multipath garbage kept     : {(gar_sel & keep).sum():,}")
assert (pit_sel & keep).sum() / pit_sel.sum() > 0.99, "PIT POINTS WERE DROPPED"
assert (gar_sel & keep).sum() == 0, "garbage survived"
print("   OK - pit preserved, garbage removed")
print()

# ── 4. vegetation band fraction vs the planted truth ────────────────────────
frac, total = L.band_fraction(x, y, hag, g, 0.30, 1.50)
ys, xs = np.mgrid[0:g.ny, 0:g.nx]
cx = g.minx + (xs + 0.5) * g.cell
cy = g.maxy - (ys + 0.5) * g.cell
thick_cells = (cx > 210) & (cx < EXTENT - 10) & (cy < 190) & (cy > 10)
open_cells  = (cx > 10) & (cx < 190) & (cy > 210) & (cy < EXTENT - 10)
print("4. Vegetation band fraction (0.30-1.50 m)")
print(f"   thick-brush quadrant : {np.nanmean(frac[thick_cells]):.3f}")
print(f"   open quadrant        : {np.nanmean(frac[open_cells]):.3f}")
print(f"   separation           : {np.nanmean(frac[thick_cells])/max(np.nanmean(frac[open_cells]),1e-9):.1f}x")
print()

# ── 5. void detection ───────────────────────────────────────────────────────
depth, vcount = L.void_raster(x, y, hag, g, depth_threshold=-1.0, min_points=3)
found = np.isfinite(depth) & (vcount >= 3)
dist = np.hypot(cx - 120, cy - 300)
print("5. Void detection (a 6 m pit at x=120 y=300, 2-9 m deep)")
print(f"   cells flagged inside 10 m of the pit : {(found & (dist < 10)).sum()}")
print(f"   cells flagged elsewhere              : {(found & (dist > 25)).sum()}")
if (found & (dist < 10)).any():
    print(f"   deepest reading at the pit           : {np.nanmin(depth[found & (dist<10)]):.2f} m")
print()

# ── 6. performance at realistic scale ───────────────────────────────────────
print("6. Performance")
for n in (1_000_000, 4_000_000):
    bx = rng.uniform(0, EXTENT, n); by = rng.uniform(0, EXTENT, n)
    bz = truth_ground(bx, by) + rng.uniform(-1, 20, n)
    bc = np.where(rng.random(n) < 0.4, 2, 5).astype(np.uint8)
    t0 = time.time()
    gg = L.grid_for_points(bx, by, 2.0)
    gr, _ = L.build_ground_grid(bx, by, bz, bc, gg, stat="median")
    gr = L.fill_pyramid(gr)
    hh = L.compute_hag(bx, by, bz, gr, gg)
    L.band_fraction(bx, by, hh, gg, 0.3, 1.5)
    L.void_raster(bx, by, hh, gg)
    print(f"   {n:>9,} points -> full pass in {time.time()-t0:.2f} s")
