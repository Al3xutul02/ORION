/**
 * A* route planning around hazard zones (INTERFERENCE / THREAT circles).
 *
 * The theatre is projected onto a local metric grid. Cells within a safety margin of a hazard
 * are blocked; cells just outside it cost more, so routes keep their distance. A hazard the
 * drone (or the goal) is already inside can be crossed, at a higher cost, so the planner can
 * get it out. The grid path is then straightened into as few legs as possible.
 *
 * Mirrors Backend/app/services/pathfinder.py; keep the two in step.
 */

const M_PER_DEG_LAT = 111139;
const CELL_M = 75;
export const MARGIN_M = 120;
const SOFT_M = 300;
const PAD_M = 1500;
const MAX_CELLS_PER_SIDE = 260;

export interface Hazard {
  lat: number;
  lon: number;
  radiusM: number;
  name: string;
}

export interface PlannedRoute {
  /** [lat, lon] points, start first and goal last. */
  waypoints: [number, number][];
  lengthM: number;
  /** Hazards the straight line would have crossed. */
  avoided: string[];
}

function segmentPointDistance(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/** Binary min-heap keyed on f. */
class Heap {
  private items: { f: number; g: number; key: number }[] = [];

  get size() {
    return this.items.length;
  }

  push(item: { f: number; g: number; key: number }) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function planRoute(start: [number, number], goal: [number, number], hazards: Hazard[]): PlannedRoute | null {
  const lat0 = (start[0] + goal[0]) / 2, lon0 = (start[1] + goal[1]) / 2;
  const mLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
  const toXY = (lat: number, lon: number): [number, number] => [(lon - lon0) * mLon, (lat - lat0) * M_PER_DEG_LAT];
  const toLatLon = (x: number, y: number): [number, number] => [lat0 + y / M_PER_DEG_LAT, lon0 + x / mLon];

  const [sx, sy] = toXY(...start);
  const [gx, gy] = toXY(...goal);
  const circles = hazards.map(h => ({ ...h, xy: toXY(h.lat, h.lon) }));

  // Hazards around the start or goal are crossable, otherwise there'd be no way out (or in).
  const escape = new Set(
    circles
      .map((c, i) => ({ c, i }))
      .filter(({ c }) =>
        Math.hypot(sx - c.xy[0], sy - c.xy[1]) <= c.radiusM + MARGIN_M ||
        Math.hypot(gx - c.xy[0], gy - c.xy[1]) <= c.radiusM + MARGIN_M)
      .map(({ i }) => i),
  );

  const xs = [sx, gx, ...circles.flatMap(c => [c.xy[0] - c.radiusM, c.xy[0] + c.radiusM])];
  const ys = [sy, gy, ...circles.flatMap(c => [c.xy[1] - c.radiusM, c.xy[1] + c.radiusM])];
  const minX = Math.min(...xs) - PAD_M, maxX = Math.max(...xs) + PAD_M;
  const minY = Math.min(...ys) - PAD_M, maxY = Math.max(...ys) + PAD_M;
  const cell = Math.max(CELL_M, (maxX - minX) / MAX_CELLS_PER_SIDE, (maxY - minY) / MAX_CELLS_PER_SIDE);
  const cols = Math.floor((maxX - minX) / cell) + 1;
  const rows = Math.floor((maxY - minY) / cell) + 1;

  const centre = (c: number, r: number): [number, number] => [minX + c * cell, minY + r * cell];
  const toCell = (x: number, y: number): [number, number] => [Math.round((x - minX) / cell), Math.round((y - minY) / cell)];
  const keyOf = (c: number, r: number) => r * cols + c;

  const costCache = new Map<number, number | null>();
  const cellCost = (c: number, r: number): number | null => {
    const key = keyOf(c, r);
    const cached = costCache.get(key);
    if (cached !== undefined) return cached;
    const [x, y] = centre(c, r);
    let mult = 1;
    for (let i = 0; i < circles.length; i++) {
      const h = circles[i];
      const edge = Math.hypot(x - h.xy[0], y - h.xy[1]) - h.radiusM;
      if (escape.has(i)) {
        if (edge < 0) mult += 2; // leave the zone we're in as directly as possible
        continue;
      }
      if (edge < MARGIN_M) {
        costCache.set(key, null);
        return null;
      }
      if (edge < MARGIN_M + SOFT_M) mult += 1.5 * (1 - (edge - MARGIN_M) / SOFT_M);
    }
    costCache.set(key, mult);
    return mult;
  };

  const [sc, sr] = toCell(sx, sy);
  const [gc, gr] = toCell(gx, gy);
  const startKey = keyOf(sc, sr), goalKey = keyOf(gc, gr);
  const steps: [number, number, number][] = [];
  for (const dc of [-1, 0, 1]) for (const dr of [-1, 0, 1]) if (dc || dr) steps.push([dc, dr, Math.hypot(dc, dr) * cell]);

  const heap = new Heap();
  heap.push({ f: 0, g: 0, key: startKey });
  const bestG = new Map<number, number>([[startKey, 0]]);
  const cameFrom = new Map<number, number>();

  let found = false;
  while (heap.size) {
    const { g, key } = heap.pop();
    if (key === goalKey) {
      found = true;
      break;
    }
    if (g > (bestG.get(key) ?? Infinity)) continue;
    const c = key % cols, r = Math.floor(key / cols);
    for (const [dc, dr, len] of steps) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nk = keyOf(nc, nr);
      const mult = nk === startKey || nk === goalKey ? 1 : cellCost(nc, nr);
      if (mult === null) continue;
      const ng = g + len * mult;
      if (ng < (bestG.get(nk) ?? Infinity)) {
        bestG.set(nk, ng);
        cameFrom.set(nk, key);
        const [hx, hy] = centre(nc, nr);
        heap.push({ f: ng + Math.hypot(gx - hx, gy - hy), g: ng, key: nk });
      }
    }
  }
  if (!found) return null;

  const keys = [goalKey];
  while (keys[keys.length - 1] !== startKey) keys.push(cameFrom.get(keys[keys.length - 1])!);
  keys.reverse();
  const points: [number, number][] = [
    [sx, sy],
    ...keys.slice(1, -1).map(k => centre(k % cols, Math.floor(k / cols))),
    [gx, gy],
  ];

  const clear = (a: [number, number], b: [number, number]) =>
    circles.every((h, i) => escape.has(i) || segmentPointDistance(a[0], a[1], b[0], b[1], h.xy[0], h.xy[1]) > h.radiusM + MARGIN_M * 0.9);

  // String-pulling: from each kept point, jump to the farthest point still in clear line of sight.
  const smoothed: [number, number][] = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && !clear(points[i], points[j])) j--;
    smoothed.push(points[j]);
    i = j;
  }

  let lengthM = 0;
  for (let k = 1; k < smoothed.length; k++) lengthM += Math.hypot(smoothed[k][0] - smoothed[k - 1][0], smoothed[k][1] - smoothed[k - 1][1]);
  const avoided = [...new Set(
    circles
      .filter((h, idx) => !escape.has(idx) && segmentPointDistance(sx, sy, gx, gy, h.xy[0], h.xy[1]) <= h.radiusM)
      .map(h => h.name),
  )].sort();

  const waypoints = smoothed.map(([x, y]) => toLatLon(x, y));
  waypoints[0] = [...start];
  waypoints[waypoints.length - 1] = [...goal];
  return { waypoints, lengthM: Math.round(lengthM * 10) / 10, avoided };
}
