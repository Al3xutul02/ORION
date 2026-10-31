import math
import time

from app.services import mesh
from app.services.mesh import MeshNode, compute_mesh
from app.services.trust_evaluator import DroneTrustEvaluator, haversine_distance_m

ORIGIN = (44.335, 23.830)
M_LAT = 111139.0
M_LON = M_LAT * math.cos(math.radians(ORIGIN[0]))


def at(east_m: float, north_m: float):
    return (ORIGIN[0] + north_m / M_LAT, ORIGIN[1] + east_m / M_LON)


# Four drones on a ~330 m patrol orbit, like Sector 4.
FORMATION = {1: at(330, 0), 2: at(0, 330), 3: at(-330, 0), 4: at(0, -330)}


def run(nodes):
    return compute_mesh(nodes, haversine_distance_m, noise=lambda: 0.0)


def honest(d_id, pos=None):
    p = pos or FORMATION[d_id]
    return MeshNode(d_id, p, p)


def spoofed(d_id, east_m, north_m):
    true = FORMATION[d_id]
    return MeshNode(d_id, true, (true[0] + north_m / M_LAT, true[1] + east_m / M_LON))


def test_honest_formation_is_fully_trusted():
    view = run([honest(i) for i in FORMATION])
    assert all(v["status"] == "TRUSTED" and v["score"] == 100.0 and v["neighbors"] == 3 for v in view.values())


def test_spoofed_drone_is_outvoted_and_honest_peers_are_not_blamed():
    view = run([honest(1), spoofed(2, 400, 300), honest(3), honest(4)])
    assert view[2]["status"] == "OUTLIER" and view[2]["score"] == 0.0
    assert all(view[i]["status"] == "TRUSTED" and view[i]["score"] == 100.0 for i in (1, 3, 4))
    assert "contradict its GPS position" in mesh.describe(view[2])


def test_small_spoof_is_caught_too():
    # 250 m: well under the old 1.2 km ground-station threshold.
    view = run([honest(1), spoofed(2, 250, 0), honest(3), honest(4)])
    assert view[2]["status"] == "OUTLIER"


def test_two_liars_with_different_offsets_still_lose_to_the_honest_pair():
    view = run([honest(1), spoofed(2, 400, 300), honest(3), spoofed(4, -450, -200)])
    assert view[1]["status"] == view[3]["status"] == "TRUSTED"
    assert view[2]["status"] == view[4]["status"] == "OUTLIER"


def test_two_drones_alone_cannot_tell_who_lies():
    view = run([honest(1), spoofed(2, 400, 300)])
    assert view[1]["status"] == view[2]["status"] == "DISPUTED"
    assert view[1]["score"] == view[2]["score"] == 50.0


def test_drone_out_of_radio_range_has_no_mesh_score():
    view = run([honest(1), MeshNode(9, at(5000, 5000), at(5000, 5000))])
    assert view[9]["status"] == "ALONE" and view[9]["score"] is None


def test_landed_drones_send_no_beacons():
    nodes = [honest(1), honest(2), honest(3), honest(4)]
    nodes[0].online = False
    view = run(nodes)
    assert view[1]["neighbors"] == 0 and all(view[i]["neighbors"] == 2 for i in (2, 3, 4))


def test_known_limit_identical_spoof_of_everyone_is_invisible_to_the_mesh():
    view = run([spoofed(i, 300, 300) for i in FORMATION])
    assert all(v["status"] == "TRUSTED" for v in view.values())


def test_mesh_result_replaces_the_ground_formation_check():
    ev = DroneTrustEvaluator()
    telem = {"latitude": ORIGIN[0], "longitude": ORIGIN[1], "ground_speed": 12.0}
    ev.drone_history[2] = {"lat": ORIGIN[0], "lon": ORIGIN[1], "alt": 120, "speed": 12, "timestamp": time.time() - 0.5, "uncertainty_radius": 0}
    score = ev.evaluate(2, telem, mesh_score=0.0, mesh_reason="Mesh: 3/3 neighbours' radio ranges contradict its GPS position")
    assert score.consensus_score == 0.0
    assert "Mesh: 3/3" in score.reason
