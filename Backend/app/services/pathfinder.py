"""
A* route planning around hazard zones (INTERFERENCE / THREAT circles).

The theatre is projected onto a local metric grid. Cells within a safety margin of a hazard
are blocked; cells just outside it cost more, so routes keep their distance. A hazard the
drone (or the goal) is already inside can be crossed, at a higher cost, so the planner can
get it out. The grid path is then straightened into as few legs as possible.

A hazard can also be "soft" (weather within the platform's limits): never blocked, it just
costs more to cross, so the route skirts it when that's cheap and goes through when it isn't.

Mirrored in Frontend/src/app/core/pathfinding.ts; keep the two in step.
"""
import heapq
import math
from typing import Dict, List, Optional, Sequence, Tuple

M_PER_DEG_LAT = 111139.0
CELL_M = 75.0          # grid resolution
MARGIN_M = 120.0       # never fly closer than this to a hazard's edge
SOFT_M = 300.0         # beyond the margin, flying this close still costs extra
SOFT_ZONE_COST = 2.0   # extra cost per metre inside a soft (weather) zone
PAD_M = 1500.0         # how far the grid extends beyond start, goal and hazards
MAX_CELLS_PER_SIDE = 260

# (lat, lon, radius_m, name) or (lat, lon, radius_m, name, soft)
Hazard = Tuple


class _Projection:
    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.m_lon = M_PER_DEG_LAT * math.cos(math.radians(lat0))

    def to_xy(self, lat: float, lon: float) -> Tuple[float, float]:
        return (lon - self.lon0) * self.m_lon, (lat - self.lat0) * M_PER_DEG_LAT

    def to_latlon(self, x: float, y: float) -> Tuple[float, float]:
        return self.lat0 + y / M_PER_DEG_LAT, self.lon0 + x / self.m_lon


def _segment_point_distance(ax, ay, bx, by, px, py) -> float:
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(ax + t * dx - px, ay + t * dy - py)


def plan_route(
    start: Tuple[float, float],
    goal: Tuple[float, float],
    hazards: Sequence[Hazard],
) -> Optional[Dict]:
    """
    Plans a route from start to goal ((lat, lon) tuples) around the hazards.
    Returns {"waypoints": [[lat, lon], ...] (start first, goal last), "length_m": float,
    "avoided": [hazard names]} or None when no safe route exists.
    """
    proj = _Projection((start[0] + goal[0]) / 2, (start[1] + goal[1]) / 2)
    sx, sy = proj.to_xy(*start)
    gx, gy = proj.to_xy(*goal)
    circles = [(*proj.to_xy(h[0], h[1]), h[2], h[3]) for h in hazards]
    soft = {i for i, h in enumerate(hazards) if len(h) > 4 and h[4]}

    # Hazards around the start or goal are crossable, otherwise there'd be no way out (or in).
    escape = {
        i for i, (cx, cy, r, _) in enumerate(circles)
        if i not in soft and (math.hypot(sx - cx, sy - cy) <= r + MARGIN_M or math.hypot(gx - cx, gy - cy) <= r + MARGIN_M)
    }

    xs = [sx, gx] + [c[0] - c[2] for c in circles] + [c[0] + c[2] for c in circles]
    ys = [sy, gy] + [c[1] - c[2] for c in circles] + [c[1] + c[2] for c in circles]
    min_x, max_x = min(xs) - PAD_M, max(xs) + PAD_M
    min_y, max_y = min(ys) - PAD_M, max(ys) + PAD_M
    cell = max(CELL_M, (max_x - min_x) / MAX_CELLS_PER_SIDE, (max_y - min_y) / MAX_CELLS_PER_SIDE)
    cols = int((max_x - min_x) / cell) + 1
    rows = int((max_y - min_y) / cell) + 1

    def centre(c: int, r: int) -> Tuple[float, float]:
        return min_x + c * cell, min_y + r * cell

    def to_cell(x: float, y: float) -> Tuple[int, int]:
        return round((x - min_x) / cell), round((y - min_y) / cell)

    cost_cache: Dict[Tuple[int, int], Optional[float]] = {}

    def cell_cost(c: int, r: int) -> Optional[float]:
        """Cost multiplier for entering a cell, or None when it is blocked."""
        key = (c, r)
        if key in cost_cache:
            return cost_cache[key]
        x, y = centre(c, r)
        mult = 1.0
        for i, (cx, cy, rad, _) in enumerate(circles):
            edge = math.hypot(x - cx, y - cy) - rad
            if i in soft:
                if edge < 0:
                    mult += SOFT_ZONE_COST
                continue
            if i in escape:
                if edge < 0:
                    mult += 2.0  # leave the zone we're in as directly as possible
                continue
            if edge < MARGIN_M:
                cost_cache[key] = None
                return None
            if edge < MARGIN_M + SOFT_M:
                mult += 1.5 * (1 - (edge - MARGIN_M) / SOFT_M)
        cost_cache[key] = mult
        return mult

    start_c, goal_c = to_cell(sx, sy), to_cell(gx, gy)
    open_heap: List[Tuple[float, float, Tuple[int, int]]] = [(0.0, 0.0, start_c)]
    came_from: Dict[Tuple[int, int], Tuple[int, int]] = {}
    best_g = {start_c: 0.0}
    steps = [(dc, dr, math.hypot(dc, dr) * cell) for dc in (-1, 0, 1) for dr in (-1, 0, 1) if dc or dr]

    found = False
    while open_heap:
        _, g, cur = heapq.heappop(open_heap)
        if cur == goal_c:
            found = True
            break
        if g > best_g.get(cur, math.inf):
            continue
        for dc, dr, length in steps:
            nxt = (cur[0] + dc, cur[1] + dr)
            if not (0 <= nxt[0] < cols and 0 <= nxt[1] < rows):
                continue
            mult = 1.0 if nxt in (start_c, goal_c) else cell_cost(*nxt)
            if mult is None:
                continue
            ng = g + length * mult
            if ng < best_g.get(nxt, math.inf):
                best_g[nxt] = ng
                came_from[nxt] = cur
                hx, hy = centre(*nxt)
                heapq.heappush(open_heap, (ng + math.hypot(gx - hx, gy - hy), ng, nxt))

    if not found:
        return None

    cells = [goal_c]
    while cells[-1] != start_c:
        cells.append(came_from[cells[-1]])
    cells.reverse()
    points = [(sx, sy)] + [centre(*c) for c in cells[1:-1]] + [(gx, gy)]

    def inside(pt: Tuple[float, float], i: int) -> bool:
        cx, cy, rad, _ = circles[i]
        return math.hypot(pt[0] - cx, pt[1] - cy) <= rad

    def clear(a: Tuple[float, float], b: Tuple[float, float]) -> bool:
        for i, (cx, cy, rad, _) in enumerate(circles):
            if i in escape:
                continue
            if i in soft:
                # Shortcuts may not cut into soft weather the grid route chose to go around.
                if not (inside(a, i) or inside(b, i)) and _segment_point_distance(*a, *b, cx, cy) <= rad:
                    return False
                continue
            if _segment_point_distance(*a, *b, cx, cy) <= rad + MARGIN_M * 0.9:
                return False
        return True

    # String-pulling: from each kept point, jump to the farthest point still in clear line of sight.
    smoothed = [points[0]]
    i = 0
    while i < len(points) - 1:
        j = len(points) - 1
        while j > i + 1 and not clear(points[i], points[j]):
            j -= 1
        smoothed.append(points[j])
        i = j

    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(smoothed, smoothed[1:]))
    avoided = sorted({
        name for i, (cx, cy, rad, name) in enumerate(circles)
        if i not in escape and _segment_point_distance(sx, sy, gx, gy, cx, cy) <= rad
    })
    return {
        "waypoints": [list(proj.to_latlon(x, y)) for x, y in smoothed],
        "length_m": round(length, 1),
        "avoided": avoided,
    }
