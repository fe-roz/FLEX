#!/usr/bin/env python3
"""Survey shots (CSV) -> Compass .plt that FLEX imports.

For survey data that isn't already Compass / Breakout / Walls: a table of
shots, one per row. Standard library only.

    python tools/shots_to_plt.py shots.csv out.plt --cave "My Cave" \
        [--units ft|m] [--decl 13.2] [--origin A1]

CSV columns (header row required; names are case-insensitive, extra columns
are ignored; empty cells allowed):

    survey      survey/trip code, e.g. A (rows with the same code form one survey)
    date        YYYY-MM-DD (optional)
    from, to    station names (case-sensitive; must be unique across the cave)
    length      tape length
    azimuth     degrees, compass (magnetic unless --decl 0 and already true)
    inclination degrees, + up / - down (clino)
    back_azimuth, back_inclination   optional backsights (averaged in)
    left, right, up, down            optional passage dimensions AT THE FROM STATION
    comment     optional

Units: --units ft (default) or m for length and LRUD. The .plt is written in
feet, as Compass does.
Declination: --decl is added to every azimuth (east positive) so the file is
in true north. Leave it at 0 if the azimuths are already corrected.
Origin: --origin puts that station at 0,0,0 (default: the first row's
"from"). The file then holds only relative positions — no real coordinates;
FLEX places the cave when you import it (anchor a station to the globe).

Shots with an empty "to" (or "-") are splays and are skipped.
Prints a short report: stations, shots, shots not connected to the origin,
loop closures.
"""
import argparse, csv, math, sys, collections

FT = 0.3048


def num(v):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def reading(r):
    """One azimuth / inclination per shot, foresight and backsight averaged."""
    az, baz = num(r.get('azimuth')), num(r.get('back_azimuth'))
    inc, binc = num(r.get('inclination')), num(r.get('back_inclination'))
    A = None
    if az is not None and baz is not None:
        b = (baz + 180) % 360
        A = math.degrees(math.atan2(math.sin(math.radians(az)) + math.sin(math.radians(b)),
                                    math.cos(math.radians(az)) + math.cos(math.radians(b)))) % 360
    elif az is not None:
        A = az
    elif baz is not None:
        A = (baz + 180) % 360
    if inc is not None and binc is not None:
        I = (inc - binc) / 2
    elif inc is not None:
        I = inc
    elif binc is not None:
        I = -binc
    else:
        I = 0.0
    return A, I


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('csv'); ap.add_argument('out')
    ap.add_argument('--cave', required=True)
    ap.add_argument('--units', choices=['ft', 'm'], default='ft')
    ap.add_argument('--decl', type=float, default=0.0)
    ap.add_argument('--origin')
    a = ap.parse_args()
    k = 1.0 if a.units == 'ft' else 1 / FT          # to feet

    with open(a.csv, newline='', encoding='utf-8-sig') as fh:
        rows = [{(kk or '').strip().lower(): (v or '').strip() for kk, v in r.items()} for r in csv.DictReader(fh)]
    shots, lrud, survey_of, meta = [], {}, {}, collections.OrderedDict()
    for i, r in enumerate(rows, 2):
        f, t = r.get('from', ''), r.get('to', '')
        sv = r.get('survey', '') or 'A'
        meta.setdefault(sv, r.get('date', ''))
        dims = [num(r.get(x)) for x in ('left', 'up', 'down', 'right')]
        if f and any(d is not None for d in dims) and f not in lrud:
            lrud[f] = [d * k if d is not None else -9.9 for d in dims]
        if not f or not t or t == '-':
            continue
        L = num(r.get('length'))
        A, I = reading(r)
        if L is None or L <= 0:
            print(f'row {i}: {f}-{t} has no length; skipped', file=sys.stderr); continue
        if A is None and abs(I) < 89.5:
            print(f'row {i}: {f}-{t} has no azimuth; skipped', file=sys.stderr); continue
        shots.append(dict(f=f, t=t, L=L * k, A=((A or 0) + a.decl) % 360, I=I, sv=sv, c=r.get('comment', '')))
        survey_of.setdefault(t, sv); survey_of.setdefault(f, sv)
    if not shots:
        sys.exit('no usable shots')

    def vec(s, sign):
        hz = s['L'] * math.cos(math.radians(s['I']))
        return (sign * hz * math.cos(math.radians(s['A'])),          # north
                sign * hz * math.sin(math.radians(s['A'])),          # east
                sign * s['L'] * math.sin(math.radians(s['I'])))      # up

    origin = a.origin or shots[0]['f']
    pos = {origin: (0.0, 0.0, 0.0)}
    done, closures, moved = set(), [], True
    while moved:
        moved = False
        for j, s in enumerate(shots):
            if j in done:
                continue
            F, T = pos.get(s['f']), pos.get(s['t'])
            if F and T:
                c = tuple(F[x] + vec(s, 1)[x] for x in range(3))
                closures.append((s['f'], s['t'], math.dist(c, T)))
            elif F:
                pos[s['t']] = tuple(F[x] + vec(s, 1)[x] for x in range(3))
            elif T:
                pos[s['f']] = tuple(T[x] + vec(s, -1)[x] for x in range(3))
            else:
                continue
            done.add(j); moved = True
    loose = [s for j, s in enumerate(shots) if j not in done]

    def P(name):
        l = lrud.get(name, [-9.9] * 4)
        return 'P\t' + '\t'.join(f'{x:.2f}' for x in l)

    def pt(cmd, name):
        n, e, v = pos[name]
        return f'{cmd}\t{n:.2f}\t{e:.2f}\t{v:.2f}\tS{name}\t{P(name)}'

    ns = [p[0] for p in pos.values()]; es = [p[1] for p in pos.values()]; vs = [p[2] for p in pos.values()]
    box = f'{min(ns):.2f}\t{max(ns):.2f}\t{min(es):.2f}\t{max(es):.2f}\t{min(vs):.2f}\t{max(vs):.2f}'
    out = [f'Z\t{box}', f'S{a.cave.upper()}']
    for sv, date in meta.items():
        mine = [s for j, s in enumerate(shots) if j in done and s['sv'] == sv]
        if not mine:
            continue
        y, m, d = (date.split('-') + ['', '', ''])[:3] if date else ('', '', '')
        out.append(f'N{sv}\tD {int(m) if m else 1} {int(d) if d else 1} {int(y) if y else 2000}\tC{sv}')
        last = None
        for s in mine:
            if s['f'] != last:
                out.append(pt('M', s['f']))
            out.append(pt('D', s['t']))
            last = s['t']
    out.append(f'X\t{box}')
    with open(a.out, 'w', newline='\r\n') as fh:
        fh.write('\n'.join(out) + '\n')

    print(f'{len(pos)} stations, {len(done)} shots written to {a.out} (origin {origin} at 0,0,0; feet, true north with decl {a.decl:+.2f})')
    if loose:
        print(f'{len(loose)} shot(s) not connected to {origin} — not written: ' + ', '.join(f"{s['f']}-{s['t']}" for s in loose[:10]))
    for f, t, err in closures:
        print(f'loop closes at {f}-{t}: misclosure {err:.2f} ft')


if __name__ == '__main__':
    main()
