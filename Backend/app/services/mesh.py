"""
Simulated drone-to-drone mesh (peer-to-peer ranging).

Each drone exchanges beacons with the drones within radio range and measures the range to them
by radio time-of-flight (two-way ranging, as UWB radios do). That measurement doesn't depend on
GPS, so a spoofer can't fake it. Every pair checks whether the distance between the two
GPS-reported positions matches the radio-measured range.

Who is lying? Within each group of drones that can hear each other, the largest set of drones
that all agree with one another is trusted; anyone outside it is the outlier. If two sets are
equally large, nobody can tell who is right, and the drones are marked "disputed".

The result replaces the ground-station formation check in the "Peers" part of the trust score
whenever a drone has at least one neighbour in range.

Mirrored in Frontend/src/app/core/mesh.ts; keep the two in step.
"""
import random
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

MESH_RANGE_M = 1200.0     # radio range between drones
RANGE_NOISE_M = 5.0       # two-way ranging error
TOLERANCE_M = 60.0        # GPS vs radio disagreement still considered consistent ...
TOLERANCE_FRAC = 0.05     # ... plus this fraction of the range

LatLon = Tuple[float, float]


@dataclass
class MeshNode:
    drone_id: int
    true_pos: LatLon      # where the airframe really is (drives the radio measurement)
    reported_pos: LatLon  # what its GPS says
    online: bool = True   # landed or radio-jammed drones send no beacons


def compute_mesh(
    nodes: List[MeshNode],
    distance_m: Callable[[float, float, float, float], float],
    noise: Callable[[], float] = lambda: random.uniform(-RANGE_NOISE_M, RANGE_NOISE_M),
) -> Dict[int, Dict]:
    """
    Returns, per drone id: {"neighbors", "score" (0-100 or None without neighbours),
    "status" ("TRUSTED" | "OUTLIER" | "DISPUTED" | "ALONE"), "links": [...]}.
    """
    online = [n for n in nodes if n.online]
    links: Dict[int, List[Dict]] = {n.drone_id: [] for n in nodes}
    in_range: Dict[int, set] = {n.drone_id: set() for n in online}
    agree: Dict[int, set] = {n.drone_id: set() for n in online}

    for i, a in enumerate(online):
        for b in online[i + 1:]:
            true_d = distance_m(*a.true_pos, *b.true_pos)
            if true_d > MESH_RANGE_M:
                continue
            radio = max(0.0, true_d + noise())
            gps_d = distance_m(*a.reported_pos, *b.reported_pos)
            consistent = abs(gps_d - radio) <= TOLERANCE_M + TOLERANCE_FRAC * radio
            for me, peer in ((a, b), (b, a)):
                links[me.drone_id].append({
                    "peer_id": peer.drone_id,
                    "gps_distance_m": round(gps_d, 1),
                    "radio_range_m": round(radio, 1),
                    "consistent": consistent,
                })
            in_range[a.drone_id].add(b.drone_id)
            in_range[b.drone_id].add(a.drone_id)
            if consistent:
                agree[a.drone_id].add(b.drone_id)
                agree[b.drone_id].add(a.drone_id)

    status: Dict[int, str] = {n.drone_id: "ALONE" for n in nodes}
    seen: set = set()
    for start in in_range:
        if start in seen or not in_range[start]:
            continue
        # One radio island: every drone reachable through in-range hops.
        island, stack = set(), [start]
        while stack:
            cur = stack.pop()
            if cur in island:
                continue
            island.add(cur)
            stack.extend(in_range[cur] - island)
        seen |= island

        groups = _agreeing_groups(island, agree)
        sizes = sorted((len(g) for g in groups), reverse=True)
        if len(sizes) > 1 and sizes[0] == sizes[1]:
            for d in island:
                status[d] = "DISPUTED"
            continue
        largest = max(groups, key=len)
        for d in island:
            status[d] = "TRUSTED" if d in largest else "OUTLIER"

    result: Dict[int, Dict] = {}
    for n in nodes:
        d_links = links[n.drone_id]
        st = status[n.drone_id]
        if not d_links:
            score: Optional[float] = None
        elif st == "DISPUTED":
            score = 50.0
        else:
            # A trusted drone isn't blamed for disagreeing with an outlier; an outlier gets no such excuse.
            ok = sum(
                1 for l in d_links
                if l["consistent"] or (st == "TRUSTED" and status.get(l["peer_id"]) == "OUTLIER")
            )
            score = round(100.0 * ok / len(d_links), 1)
        result[n.drone_id] = {"neighbors": len(d_links), "score": score, "status": st, "links": d_links}
    return result


def _agreeing_groups(island: set, agree: Dict[int, set]) -> List[set]:
    """Largest sets of drones that all agree pairwise, found greedily (islands are a handful of drones)."""
    remaining = set(island)
    groups: List[set] = []
    while remaining:
        # Seed with the drone that agrees with the most others, then add anyone agreeing with all members.
        seed = max(sorted(remaining), key=lambda d: len(agree[d] & remaining))
        group = {seed}
        for cand in sorted(remaining - {seed}, key=lambda d: -len(agree[d] & remaining)):
            if all(cand in agree[m] for m in group):
                group.add(cand)
        groups.append(group)
        remaining -= group
    return groups


def describe(info: Optional[Dict]) -> Optional[str]:
    """One-line reason for the trust breakdown, or None when there's nothing to flag."""
    if not info or info["score"] is None:
        return None
    n = info["neighbors"]
    if info["status"] == "OUTLIER":
        bad = [l for l in info["links"] if not l["consistent"]]
        worst = max(bad, key=lambda l: abs(l["gps_distance_m"] - l["radio_range_m"]), default=None)
        gap = f" (D{worst['peer_id']}: GPS {worst['gps_distance_m']:.0f} m vs radio {worst['radio_range_m']:.0f} m)" if worst else ""
        return f"Mesh: {len(bad)}/{n} neighbours' radio ranges contradict its GPS position{gap}"
    if info["status"] == "DISPUTED":
        return f"Mesh: neighbours disagree and can't tell whose GPS is wrong ({n} in range)"
    return None
