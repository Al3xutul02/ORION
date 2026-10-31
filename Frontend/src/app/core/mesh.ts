/**
 * Simulated drone-to-drone mesh (peer-to-peer ranging).
 *
 * Each drone exchanges beacons with the drones within radio range and measures the range to them
 * by radio time-of-flight (two-way ranging), which doesn't depend on GPS. Every pair checks whether
 * the distance between the two GPS-reported positions matches the radio-measured range. Within
 * each group of drones that can hear each other, the largest set that all agree is trusted and
 * anyone outside it is the outlier; equal-sized sets mean nobody can tell ("disputed").
 *
 * Mirrors Backend/app/services/mesh.py; keep the two in step.
 */
import { MeshLink, MeshView } from './models';

export const MESH_RANGE_M = 1200;
const RANGE_NOISE_M = 5;
const TOLERANCE_M = 60;
const TOLERANCE_FRAC = 0.05;

export interface MeshNode {
  droneId: number;
  /** Where the airframe really is: drives the radio measurement. */
  truePos: [number, number];
  /** What its GPS says. */
  reportedPos: [number, number];
  /** Landed or radio-jammed drones send no beacons. */
  online: boolean;
}

type Distance = (lat1: number, lon1: number, lat2: number, lon2: number) => number;

export function computeMesh(
  nodes: MeshNode[],
  distanceM: Distance,
  noise: (a: number, b: number) => number = () => (Math.random() * 2 - 1) * RANGE_NOISE_M,
): Map<number, MeshView> {
  const online = nodes.filter(n => n.online);
  const links = new Map<number, MeshLink[]>(nodes.map(n => [n.droneId, []]));
  const inRange = new Map<number, Set<number>>(online.map(n => [n.droneId, new Set()]));
  const agree = new Map<number, Set<number>>(online.map(n => [n.droneId, new Set()]));

  for (let i = 0; i < online.length; i++) {
    for (let j = i + 1; j < online.length; j++) {
      const a = online[i], b = online[j];
      const trueD = distanceM(...a.truePos, ...b.truePos);
      if (trueD > MESH_RANGE_M) continue;
      const radio = Math.max(0, trueD + noise(a.droneId, b.droneId));
      const gpsD = distanceM(...a.reportedPos, ...b.reportedPos);
      const consistent = Math.abs(gpsD - radio) <= TOLERANCE_M + TOLERANCE_FRAC * radio;
      for (const [me, peer] of [[a, b], [b, a]] as const) {
        links.get(me.droneId)!.push({
          peer_id: peer.droneId,
          gps_distance_m: Math.round(gpsD * 10) / 10,
          radio_range_m: Math.round(radio * 10) / 10,
          consistent,
        });
      }
      inRange.get(a.droneId)!.add(b.droneId);
      inRange.get(b.droneId)!.add(a.droneId);
      if (consistent) {
        agree.get(a.droneId)!.add(b.droneId);
        agree.get(b.droneId)!.add(a.droneId);
      }
    }
  }

  const status = new Map<number, MeshView['status']>(nodes.map(n => [n.droneId, 'ALONE']));
  const seen = new Set<number>();
  for (const [start, peers] of inRange) {
    if (seen.has(start) || !peers.size) continue;
    // One radio island: every drone reachable through in-range hops.
    const island = new Set<number>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (island.has(cur)) continue;
      island.add(cur);
      for (const p of inRange.get(cur)!) if (!island.has(p)) stack.push(p);
    }
    island.forEach(d => seen.add(d));

    const groups = agreeingGroups(island, agree);
    const sizes = groups.map(g => g.size).sort((x, y) => y - x);
    if (sizes.length > 1 && sizes[0] === sizes[1]) {
      island.forEach(d => status.set(d, 'DISPUTED'));
      continue;
    }
    const largest = groups.reduce((best, g) => (g.size > best.size ? g : best));
    island.forEach(d => status.set(d, largest.has(d) ? 'TRUSTED' : 'OUTLIER'));
  }

  const result = new Map<number, MeshView>();
  for (const n of nodes) {
    const ls = links.get(n.droneId)!;
    const st = status.get(n.droneId)!;
    let score: number | null;
    if (!ls.length) score = null;
    else if (st === 'DISPUTED') score = 50;
    else {
      // A trusted drone isn't blamed for disagreeing with an outlier; an outlier gets no such excuse.
      const ok = ls.filter(l => l.consistent || (st === 'TRUSTED' && status.get(l.peer_id) === 'OUTLIER')).length;
      score = Math.round((1000 * ok) / ls.length) / 10;
    }
    result.set(n.droneId, { neighbors: ls.length, score, status: st, links: ls });
  }
  return result;
}

/** Largest sets of drones that all agree pairwise, found greedily (islands are a handful of drones). */
function agreeingGroups(island: Set<number>, agree: Map<number, Set<number>>): Set<number>[] {
  const remaining = new Set(island);
  const groups: Set<number>[] = [];
  const agreeing = (d: number) => [...agree.get(d)!].filter(x => remaining.has(x)).length;
  while (remaining.size) {
    const ordered = [...remaining].sort((x, y) => agreeing(y) - agreeing(x) || x - y);
    const group = new Set([ordered[0]]);
    for (const cand of ordered.slice(1)) {
      if ([...group].every(m => agree.get(cand)!.has(m))) group.add(cand);
    }
    groups.push(group);
    group.forEach(d => remaining.delete(d));
  }
  return groups;
}

/** One-line reason for the trust breakdown, or null when there's nothing to flag. */
export function describeMesh(view: MeshView | undefined): string | null {
  if (!view || view.score === null) return null;
  if (view.status === 'OUTLIER') {
    const bad = view.links.filter(l => !l.consistent);
    const worst = [...bad].sort((a, b) =>
      Math.abs(b.gps_distance_m - b.radio_range_m) - Math.abs(a.gps_distance_m - a.radio_range_m))[0];
    const gap = worst ? ` (D${worst.peer_id}: GPS ${Math.round(worst.gps_distance_m)} m vs radio ${Math.round(worst.radio_range_m)} m)` : '';
    return `Mesh: ${bad.length}/${view.neighbors} neighbours' radio ranges contradict its GPS position${gap}`;
  }
  if (view.status === 'DISPUTED') return `Mesh: neighbours disagree and can't tell whose GPS is wrong (${view.neighbors} in range)`;
  return null;
}
