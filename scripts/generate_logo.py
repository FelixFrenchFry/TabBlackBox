"""generate white-inset SVG logos, run node scripts/render-logo.mjs for PNGs"""

import math
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FRONT_WIDTH = 650
FRONT_HEIGHT = 620
ORIGINAL_DEPTH = (190, -165)
BORDER = 54
OUTER_RADIUS = 100
INNER_RADIUS = OUTER_RADIUS - BORDER


def fmt(value):
    return f"{value:.6f}".rstrip("0").rstrip(".")


def xy(p):
    return " ".join(fmt(v) for v in p)


def normalize_path(path, left, top, scale):
    """write actual 1024-canvas coordinates without an SVG transform wrapper"""
    def command(match):
        kind = match.group(1)
        values = [float(value) for value in match.group(2).split()]
        if kind == 'A':
            values[0] *= scale
            values[1] *= scale
            values[5] = (values[5] - left) * scale
            values[6] = (values[6] - top) * scale
        else:
            values[0] = (values[0] - left) * scale
            values[1] = (values[1] - top) * scale
        return f'{kind} {" ".join(fmt(value) for value in values)}\n    '
    return re.sub(r'([MLA])\s+([^MLAZ]+)', command, path)


def rounded_polygon(vertices, radii):
    """use circular fillets tangent to the adjoining edges, including concave corners"""
    corners = []
    extrema = []
    for i, (p, radius) in enumerate(zip(vertices, radii)):
        before, after = vertices[i - 1], vertices[(i + 1) % len(vertices)]
        previous_length = math.dist(before, p)
        next_length = math.dist(after, p)
        u = tuple((a - b) / previous_length for a, b in zip(before, p))
        v = tuple((a - b) / next_length for a, b in zip(after, p))
        angle = math.acos(max(-1, min(1, sum(a * b for a, b in zip(u, v)))))
        tangent = radius / math.tan(angle / 2)
        start = tuple(a + tangent * b for a, b in zip(p, u))
        end = tuple(a + tangent * b for a, b in zip(p, v))
        bisector = tuple(a + b for a, b in zip(u, v))
        scale = radius / math.sin(angle / 2) / math.hypot(*bisector)
        center = tuple(a + scale * b for a, b in zip(p, bisector))
        sweep = int(u[1] * v[0] - u[0] * v[1] > 0)
        a0 = math.atan2(start[1] - center[1], start[0] - center[0])
        a1 = math.atan2(end[1] - center[1], end[0] - center[0])
        extent = (a1 - a0) % math.tau if sweep else -((a0 - a1) % math.tau)
        extrema.extend([start, end])
        for cardinal in [0, math.pi / 2, math.pi, 3 * math.pi / 2]:
            distance = (cardinal - a0) % math.tau if sweep else (a0 - cardinal) % math.tau
            if distance <= abs(extent):
                extrema.append((center[0] + radius * math.cos(cardinal),
                                center[1] + radius * math.sin(cardinal)))
        corners.append((start, end, radius, sweep, tangent))

    for i, corner in enumerate(corners):
        next_corner = corners[(i + 1) % len(corners)]
        edge_length = math.dist(vertices[i], vertices[(i + 1) % len(vertices)])
        assert corner[4] + next_corner[4] < edge_length, "Corner arcs overlap"

    commands = [f"M {xy(corners[0][0])}"]
    for i, (start, end, radius, sweep, _) in enumerate(corners):
        if i:
            commands.append(f"L {xy(start)}")
        commands.append(f"A {fmt(radius)} {fmt(radius)} 0 0 {sweep} {xy(end)}")
    commands.append("Z")
    return "\n    ".join(commands), extrema



DEPTH_SCALE = 0.75
DEPTH = tuple(component * DEPTH_SCALE for component in ORIGINAL_DEPTH)
CORNER_OVERLAP = 4
# slightly tighter grey corners extend past the black at both junctions
DEPTH_RADII = [OUTER_RADIUS - CORNER_OVERLAP, OUTER_RADIUS,
               OUTER_RADIUS - CORNER_OVERLAP, OUTER_RADIUS]


def corner(before, vertex, after, radius):
    """return the start, end, and center of a circular corner fillet"""
    u = tuple((a - b) / math.dist(before, vertex) for a, b in zip(before, vertex))
    v = tuple((a - b) / math.dist(after, vertex) for a, b in zip(after, vertex))
    angle = math.acos(sum(a * b for a, b in zip(u, v)))
    tangent = radius / math.tan(angle / 2)
    start = tuple(a + tangent * b for a, b in zip(vertex, u))
    end = tuple(a + tangent * b for a, b in zip(vertex, v))
    bisector = tuple(a + b for a, b in zip(u, v))
    factor = radius / math.sin(angle / 2) / math.hypot(*bisector)
    center = tuple(a + factor * b for a, b in zip(vertex, bisector))
    return start, end, center


def extruded_outline(front):
    """join matching front and rear tangent points with straight depth edges

    carries a nearly matching rounded face backward along the depth vector
    instead of rounding a six-sided hull, the controlled corner-radius
    difference supplies the small overlap without grey shoulders
    """
    corners = [corner(front[i - 1], p, front[(i + 1) % 4], DEPTH_RADII[i]) for i, p in enumerate(front)]
    normal = (DEPTH[1] / math.hypot(*DEPTH), -DEPTH[0] / math.hypot(*DEPTH))
    top_left = tuple(corners[0][2][i] + DEPTH_RADII[0] * normal[i] for i in (0, 1))
    bottom_right = tuple(corners[2][2][i] - DEPTH_RADII[2] * normal[i] for i in (0, 1))
    back = lambda p: tuple(a + b for a, b in zip(p, DEPTH))
    arc = lambda p, index: f'A {DEPTH_RADII[index]} {DEPTH_RADII[index]} 0 0 1 {xy(p)}'
    commands = [f'M {xy(top_left)}', f'L {xy(back(top_left))}',
                arc(back(corners[0][1]), 0), f'L {xy(back(corners[1][0]))}',
                arc(back(corners[1][1]), 1), f'L {xy(back(corners[2][0]))}',
                arc(back(bottom_right), 2), f'L {xy(bottom_right)}',
                arc(corners[2][1], 2), f'L {xy(corners[3][0])}',
                arc(corners[3][1], 3), f'L {xy(corners[0][0])}', arc(top_left, 0), 'Z']
    assert abs(sum(a * b for a, b in zip(normal, DEPTH))) < 1e-9
    return '\n    '.join(commands)


def face_geometry(slope):
    point = lambda x, y: (x, y + slope * x)
    front = [point(0, 0), point(FRONT_WIDTH, 0),
             point(FRONT_WIDTH, FRONT_HEIGHT), point(0, FRONT_HEIGHT)]
    _, bounds = rounded_polygon(front, DEPTH_RADII)
    bounds += [(x + DEPTH[0], y + DEPTH[1]) for x, y in bounds[:]]
    left, top = (min(p[i] for p in bounds) for i in (0, 1))
    right, bottom = (max(p[i] for p in bounds) for i in (0, 1))
    return front, (left, top, right, bottom)


def inset_polygon(vertices, distance):
    """inset a convex face by a constant perpendicular distance on each edge"""
    area = sum(a[0] * b[1] - b[0] * a[1]
               for a, b in zip(vertices, vertices[1:] + vertices[:1]))
    direction = 1 if area > 0 else -1
    lines = []
    for a, b in zip(vertices, vertices[1:] + vertices[:1]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        normal = (-dy / length * direction, dx / length * direction)
        lines.append((normal, normal[0] * a[0] + normal[1] * a[1] + distance))
    result = []
    for i, (b, cb) in enumerate(lines):
        a, ca = lines[i - 1]
        determinant = a[0] * b[1] - b[0] * a[1]
        result.append(((ca * b[1] - cb * a[1]) / determinant,
                       (a[0] * cb - b[0] * ca) / determinant))
    return result


def main():
    # solve the shared face slope against the rounded outline bounds
    low, high = 0.088, 0.3
    for _ in range(50):
        slope = (low + high) / 2
        _, (left, top, right, bottom) = face_geometry(slope)
        if bottom - top < right - left:
            low = slope
        else:
            high = slope
    slope = (low + high) / 2
    front, (left, top, right, bottom) = face_geometry(slope)
    assert abs((right - left) - (bottom - top)) < 1e-6
    point = lambda x, y: (x, y + slope * x)
    black_frame, _ = rounded_polygon(front, [OUTER_RADIUS] * 4)
    shell = extruded_outline(front)
    inset = BORDER * math.sqrt(1 + slope ** 2)
    opening, _ = rounded_polygon(
        [point(BORDER, inset), point(FRONT_WIDTH - BORDER, inset),
         point(FRONT_WIDTH - BORDER, FRONT_HEIGHT - inset),
         point(BORDER, FRONT_HEIGHT - inset)], [INNER_RADIUS] * 4)
    bookmark, _ = rounded_polygon(
        [point(190, 145), point(460, 145), point(460, 480),
         point(325, 377), point(190, 480)], [22, 22, 10, 8, 10])
    width = height = max(right - left, bottom - top)
    x, y = (left + right - width) / 2, (top + bottom - height) / 2
    black_frame, shell, opening, bookmark = [normalize_path(path, x, y, 1024 / width)
                                            for path in (black_frame, shell, opening, bookmark)]
    view_box = '0 0 1024 1024'
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view_box}" fill="none">
  <title>TabBlackBox two-color logo</title>
  <desc>A black rounded frame with dark grey depth, a solid white opening, and a black bookmark. The frame is 25 percent thinner than the original. The canvas outside the silhouette is transparent.</desc>
  <defs>
    <pattern id="depth-colors" patternUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024" viewBox="{view_box}">
      <rect id="dark-grey-depth" width="1024" height="1024" fill="#646464"/>
      <path id="black-frame" fill="#0A0A0A" d="{black_frame}"/>
    </pattern>
  </defs>
  <path id="box" fill="url(#depth-colors)" d="{shell}"/>
  <path id="opening" fill="#FFFFFF" d="{opening}"/>
  <path id="bookmark" fill="#0A0A0A" d="{bookmark}"/>
</svg>
'''
    destination = ROOT / 'assets/logo/tabblackbox-stacked.svg'
    destination.write_text(svg, encoding='utf-8', newline='\n')
    orange = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view_box}" fill="none">
  <title>TabBlackBox orange logo</title>
  <desc>A uniform orange frame, depth, and bookmark with a solid white opening. The frame is 25 percent thinner than the original. The canvas outside the silhouette is transparent.</desc>
  <path id="box" fill="#F04600" d="{shell}"/>
  <path id="opening" fill="#FFFFFF" d="{opening}"/>
  <path id="bookmark" fill="#F04600" d="{bookmark}"/>
</svg>
'''
    (ROOT / 'assets/logo/tabblackbox-orange.svg').write_text(orange, encoding='utf-8', newline='\n')
    monochrome = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{view_box}" fill="none">
  <title>TabBlackBox logo</title>
  <desc>A black silhouette and bookmark with a solid white opening. The frame is 25 percent thinner than the original. The canvas outside the silhouette is transparent.</desc>
  <path id="box" fill="#0A0A0A" d="{shell}"/>
  <path id="opening" fill="#FFFFFF" d="{opening}"/>
  <path id="bookmark" fill="#0A0A0A" d="{bookmark}"/>
</svg>
'''
    (ROOT / 'assets/logo/tabblackbox.svg').write_text(monochrome, encoding='utf-8', newline='\n')
    back = lambda p: (p[0] + DEPTH[0], p[1] + DEPTH[1])
    faces = [
        [front[0], back(front[0]), back(front[1]), front[1]],
        [front[1], back(front[1]), back(front[2]), front[2]],
    ]
    panels = []
    for face in faces:
        # depth faces use a foreshortened inset to avoid a slit
        # half the inset leaves white faces with outlined edges
        path, _ = rounded_polygon(inset_polygon(face, BORDER / 2), [16] * 4)
        panels.append(normalize_path(path, x, y, 1024 / width))
    outlined = monochrome.replace('TabBlackBox logo', 'TabBlackBox outlined planes logo')
    outlined = outlined.replace('A black silhouette and bookmark with a solid white opening.',
                                'A black silhouette and bookmark with white inset panels on the front, top, and right faces.')
    outlined = outlined.replace('  <path id="opening"',
                                f'  <defs><mask id="outline-boundary" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">\n'
                                f'  <path fill="#FFFFFF" d="{shell}"/>\n'
                                f'  <path fill="none" stroke="#000000" stroke-width="{fmt(BORDER * 1024 / width)}" d="{shell}"/>\n'
                                '  </mask></defs>\n'
                                '  <g mask="url(#outline-boundary)">\n'
                                f'  <path id="top-opening" fill="#FFFFFF" d="{panels[0]}"/>\n'
                                f'  <path id="right-opening" fill="#FFFFFF" d="{panels[1]}"/>\n'
                                '  </g>\n'
                                '  <path id="opening"')
    (ROOT / 'assets/logo/tabblackbox-outlined.svg').write_text(outlined, encoding='utf-8', newline='\n')
    print(f'Extruded AABB: {right-left:.3f} x {bottom-top:.3f}; square viewBox: {view_box}')
    print(f'Face angle: {math.degrees(math.atan(slope)):.4f} degrees; grey corner radius reduction: {CORNER_OVERLAP} units')
    print(f'Frame thickness: {BORDER / width * 1024:.3f} normalized units, {BORDER / width * 16:.3f} px at 16 px')
    print(destination)


if __name__ == '__main__':
    main()
