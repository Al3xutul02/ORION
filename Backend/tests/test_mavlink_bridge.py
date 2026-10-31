import asyncio
import socket
import time

from pymavlink.dialects.v20 import common as mavlink2

from app.services.mavlink_bridge import MAVLinkInput, MAVLinkOutput, mavlink_input
from app.services.simulator import simulator

SPOOFED_D2 = {
    "drone_id": 2, "latitude": 44.3400, "longitude": 23.8350, "altitude": 120.0, "ground_speed": 12.0,
    "heading": 90.0, "fix_type": 2, "satellites_visible": 4, "eph": 4.2, "battery_remaining": 87.0,
    "drop_rate_comm": 0.5, "rssi": 95.0, "noise": 15.0, "flight_mode": "GUIDED", "is_armed": True,
}


class _Collect:
    def __init__(self):
        self.data = b""

    def write(self, buf):
        self.data += buf


def vehicle_bytes(sysid=1, lat=44.33, lon=23.82, mav_type=mavlink2.MAV_TYPE_QUADROTOR, battery=76):
    """What a real autopilot (e.g. ArduPilot SITL, sysid 1) would send."""
    sink = _Collect()
    mav = mavlink2.MAVLink(sink, srcSystem=sysid, srcComponent=1)
    mav.heartbeat_send(mav_type, mavlink2.MAV_AUTOPILOT_ARDUPILOTMEGA, mavlink2.MAV_MODE_FLAG_SAFETY_ARMED, 5, 4)
    mav.global_position_int_send(1000, int(lat * 1e7), int(lon * 1e7), 150000, 90000, 300, 400, 0, 9000)
    mav.gps_raw_int_send(1000000, 3, int(lat * 1e7), int(lon * 1e7), 150000, 90, 65535, 500, 9000, 14)
    mav.sys_status_send(0, 0, 0, 0, 15000, -1, battery, 120, 0, 0, 0, 0, 0)
    mav.radio_status_send(200, 200, 100, 20, 20, 0, 0)
    return sink.data


def test_output_publishes_real_mavlink_that_a_gcs_can_decode():
    rx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    rx.bind(("127.0.0.1", 0))
    rx.settimeout(2)
    out = MAVLinkOutput("127.0.0.1", rx.getsockname()[1])
    out.publish([SPOOFED_D2])

    parser = mavlink2.MAVLink(None)
    msgs = {}
    for _ in range(5):  # one datagram per message
        for m in parser.parse_buffer(rx.recv(2048)) or []:
            msgs[m.get_type()] = m
    rx.close()

    assert set(msgs) == {"HEARTBEAT", "GLOBAL_POSITION_INT", "GPS_RAW_INT", "SYS_STATUS", "RADIO_STATUS"}
    assert all(m.get_srcSystem() == 102 for m in msgs.values())  # drone 2 -> sysid 102
    hb = msgs["HEARTBEAT"]
    assert hb.type == mavlink2.MAV_TYPE_QUADROTOR and hb.base_mode & mavlink2.MAV_MODE_FLAG_SAFETY_ARMED
    # A GCS sees what the drone *reports*: the spoofed position and its degraded fix.
    assert msgs["GLOBAL_POSITION_INT"].lat == int(44.34 * 1e7)
    assert msgs["GPS_RAW_INT"].fix_type == 2 and msgs["GPS_RAW_INT"].satellites_visible == 4
    assert msgs["SYS_STATUS"].battery_remaining == 87
    assert out.status()["packets_sent"] == 5


def test_input_turns_a_mavlink_vehicle_into_a_fleet_drone():
    inp = MAVLinkInput("127.0.0.1", 0)
    inp.handle_datagram(vehicle_bytes(sysid=1), ("127.0.0.1", 5760), now=100.0)
    [d] = inp.snapshot(now=100.5)
    assert d["drone_id"] == 201 and d["source"] == "MAVLINK" and d["mavlink_sysid"] == 1
    assert abs(d["latitude"] - 44.33) < 1e-6 and d["altitude"] == 90.0
    assert d["flight_mode"] == "LOITER" and d["is_armed"]
    assert d["satellites_visible"] == 14 and d["battery_remaining"] == 76.0
    assert abs(d["ground_speed"] - 5.0) < 1e-6  # vx 3 m/s, vy 4 m/s


def test_input_ignores_its_own_echo_and_ground_stations_and_forgets_silent_vehicles():
    inp = MAVLinkInput("127.0.0.1", 0)
    inp.handle_datagram(vehicle_bytes(sysid=102), ("127.0.0.1", 1), now=10.0)  # our own drone coming back
    inp.handle_datagram(vehicle_bytes(sysid=255, mav_type=mavlink2.MAV_TYPE_GCS), ("127.0.0.1", 2), now=10.0)
    assert inp.snapshot(now=10.1) == []
    inp.handle_datagram(vehicle_bytes(sysid=3), ("127.0.0.1", 3), now=10.0)
    assert [d["drone_id"] for d in inp.snapshot(now=11.0)] == [203]
    assert inp.snapshot(now=20.0) == []  # nothing heard for 10 s


def test_input_listens_on_a_real_udp_port():
    async def scenario():
        inp = MAVLinkInput("127.0.0.1", 0)
        await inp.start()
        port = inp._transport.get_extra_info("sockname")[1]
        tx = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        tx.sendto(vehicle_bytes(sysid=7), ("127.0.0.1", port))
        tx.close()
        await asyncio.sleep(0.2)
        inp.stop()
        return inp.snapshot()
    [d] = asyncio.run(scenario())
    assert d["drone_id"] == 207


def test_external_vehicle_is_scored_in_the_live_loop_and_reported(client):
    captured = []
    client.post("/api/v1/simulation/start")
    mavlink_input.handle_datagram(vehicle_bytes(sysid=9), ("127.0.0.1", 9999))
    simulator.subscribe(captured.append)
    try:
        deadline = time.time() + 5
        while time.time() < deadline and not any(
            any(d["drone_id"] == 209 for d in u["drones"]) for u in captured
        ):
            mavlink_input.handle_datagram(vehicle_bytes(sysid=9), ("127.0.0.1", 9999))
            time.sleep(0.2)
    finally:
        simulator.unsubscribe(captured.append)
        status = client.get("/api/v1/mavlink/status").json()
        mavlink_input._vehicles.clear()  # shared singleton: don't leak vehicle 209 into other tests
    ext = next(d for u in captured for d in u["drones"] if d["drone_id"] == 209)
    assert ext["source"] == "MAVLINK" and 0 <= ext["trust_score"] <= 100
    assert any(d.get("source") == "SIM" for d in captured[-1]["drones"])

    assert status["output"]["packets_sent"] > 0
    assert any(v["sysid"] == 9 for v in status["input"]["vehicles"])
