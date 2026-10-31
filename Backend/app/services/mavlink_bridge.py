"""
MAVLink 2 bridge between ORION and the outside world (QGroundControl, ArduPilot SITL, real drones).

Output: every simulated drone is published as a real MAVLink vehicle over UDP (by default to
127.0.0.1:14550, where QGroundControl listens), with system id 100 + drone id. It sends what
the drone *reports*, so a spoofed drone shows up in QGroundControl at its false position.

Input: ORION listens on UDP (default 14560) for MAVLink vehicles, e.g. SITL, a telemetry radio,
or QGroundControl's MAVLink forwarding. Each vehicle joins the fleet as drone 200 + sysid with
source "MAVLINK" and goes through the same trust scoring. External vehicles are read-only:
ORION never sends them commands. Our own published drones (sysid 101-199) and ground stations
(MAV_TYPE_GCS, e.g. QGroundControl as sysid 255) are ignored, so forwarding can't loop.
"""
import asyncio
import logging
import math
import socket
import time
from typing import Any, Dict, List, Optional, Tuple

from pymavlink.dialects.v20 import common as mavlink2

from app.services.mavlink_parser import mavlink_parser

logger = logging.getLogger("orion.mavlink")

OUTPUT_SYSID_BASE = 100   # simulated drone N is published as sysid 100 + N
INPUT_DRONE_ID_BASE = 200  # external sysid S joins the fleet as drone 200 + S
STALE_AFTER_S = 5.0        # forget an external vehicle after this long without messages

# ArduCopter custom modes, so QGroundControl and SITL speak the same language (mavlink_parser
# maps them back the same way).
COPTER_MODE = {"GUIDED": 4, "LOITER": 5, "RTL": 6, "AUTO": 3, "CORRIDOR": 3, "ROUTE": 3, "LANDED": 9}


class _UdpWriter:
    """File-like sink for pymavlink: every packed message becomes one UDP datagram."""

    def __init__(self, sock: socket.socket, target: Tuple[str, int]):
        self.sock, self.target = sock, target
        self.sent = 0
        self.errors = 0

    def write(self, buf: bytes) -> None:
        try:
            self.sock.sendto(buf, self.target)
            self.sent += 1
        except OSError as e:
            self.errors += 1
            if self.errors == 1:
                logger.warning("MAVLink output to %s:%s failed: %s", *self.target, e)


class MAVLinkOutput:
    def __init__(self, host: str, port: int, enabled: bool = True):
        self.enabled = enabled
        self.target = (host, port)
        self._sock: Optional[socket.socket] = None
        self._writer: Optional[_UdpWriter] = None
        self._links: Dict[int, mavlink2.MAVLink] = {}
        self._boot = time.time()

    def _link(self, sysid: int) -> mavlink2.MAVLink:
        if self._sock is None:
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._writer = _UdpWriter(self._sock, self.target)
        if sysid not in self._links:
            # Each vehicle keeps its own MAVLink sequence numbers, as a real autopilot would.
            self._links[sysid] = mavlink2.MAVLink(self._writer, srcSystem=sysid, srcComponent=mavlink2.MAV_COMP_ID_AUTOPILOT1)
        return self._links[sysid]

    def publish(self, drones: List[Dict[str, Any]]) -> None:
        """Sends one burst of telemetry per drone (called every simulator tick)."""
        if not self.enabled:
            return
        boot_ms = int((time.time() - self._boot) * 1000) % 2**32
        for d in drones:
            try:
                self._publish_one(d, boot_ms)
            except Exception as e:  # never let a bad value stop the simulator loop
                logger.warning("MAVLink output for drone %s skipped: %s", d.get("drone_id"), e)

    def _publish_one(self, d: Dict[str, Any], boot_ms: int) -> None:
        mav = self._link(OUTPUT_SYSID_BASE + int(d["drone_id"]))
        armed = bool(d.get("is_armed", True))
        mode = d.get("flight_mode", "GUIDED")
        lat, lon = int(d["latitude"] * 1e7), int(d["longitude"] * 1e7)
        alt_mm = int(d.get("altitude", 0.0) * 1000)
        speed = float(d.get("ground_speed", 0.0))
        hdg = float(d.get("heading", 0.0)) % 360.0
        vx = int(speed * math.cos(math.radians(hdg)) * 100)  # cm/s north
        vy = int(speed * math.sin(math.radians(hdg)) * 100)  # cm/s east

        base_mode = mavlink2.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (mavlink2.MAV_MODE_FLAG_SAFETY_ARMED if armed else 0)
        mav.heartbeat_send(
            mavlink2.MAV_TYPE_QUADROTOR, mavlink2.MAV_AUTOPILOT_ARDUPILOTMEGA, base_mode,
            COPTER_MODE.get(mode, 4), mavlink2.MAV_STATE_ACTIVE if armed else mavlink2.MAV_STATE_STANDBY,
        )
        mav.global_position_int_send(boot_ms, lat, lon, alt_mm, alt_mm, vx, vy, 0, int(hdg * 100) % 36000)
        mav.gps_raw_int_send(
            boot_ms * 1000, int(d.get("fix_type", 3)), lat, lon, alt_mm,
            min(65535, int(float(d.get("eph", 1.0)) * 100)), 65535,
            min(65535, int(speed * 100)), int(hdg * 100) % 36000, int(d.get("satellites_visible", 12)),
        )
        mav.sys_status_send(
            0, 0, 0, 0, 15000, -1, int(max(0, min(100, d.get("battery_remaining", 100)))),
            min(10000, int(float(d.get("drop_rate_comm", 0.0)) * 100)), 0, 0, 0, 0, 0,
        )
        rssi = int(max(0, min(254, float(d.get("rssi", 100.0)) / 100.0 * 254)))
        mav.radio_status_send(rssi, rssi, 100, int(d.get("noise", 15)), int(d.get("noise", 15)), 0, 0)

    def status(self) -> Dict[str, Any]:
        w = self._writer
        return {
            "enabled": self.enabled,
            "target": f"{self.target[0]}:{self.target[1]}",
            "vehicles": sorted(self._links),
            "packets_sent": w.sent if w else 0,
            "errors": w.errors if w else 0,
        }


class MAVLinkInput(asyncio.DatagramProtocol):
    def __init__(self, host: str, port: int, enabled: bool = True):
        self.enabled = enabled
        self.bind = (host, port)
        self.listening = False
        self.packets = 0
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._parsers: Dict[Tuple[str, int], mavlink2.MAVLink] = {}
        self._vehicles: Dict[int, Dict[str, Any]] = {}

    # ---- lifecycle -------------------------------------------------------------------------

    async def start(self) -> None:
        if not self.enabled or self.listening:
            return
        try:
            loop = asyncio.get_running_loop()
            await loop.create_datagram_endpoint(lambda: self, local_addr=self.bind)
            logger.info("MAVLink input listening on udp://%s:%s", *self.bind)
        except OSError as e:
            logger.warning("MAVLink input could not bind udp://%s:%s (%s); continuing without it", *self.bind, e)

    def stop(self) -> None:
        if self._transport:
            self._transport.close()
        self._transport = None
        self.listening = False

    def connection_made(self, transport) -> None:  # asyncio callback
        self._transport = transport
        self.listening = True

    def datagram_received(self, data: bytes, addr) -> None:  # asyncio callback
        self.handle_datagram(data, addr)

    # ---- decoding --------------------------------------------------------------------------

    def handle_datagram(self, data: bytes, addr: Tuple[str, int], now: Optional[float] = None) -> None:
        self.packets += 1
        parser = self._parsers.setdefault(addr, mavlink2.MAVLink(None))
        try:
            msgs = parser.parse_buffer(data) or []
        except Exception:
            return  # corrupt datagram: drop it, the next one will resync
        for msg in msgs:
            self._apply(msg, addr, now if now is not None else time.time())

    def _apply(self, msg, addr, now: float) -> None:
        sysid = msg.get_srcSystem()
        kind = msg.get_type()
        if OUTPUT_SYSID_BASE < sysid < INPUT_DRONE_ID_BASE:
            return  # our own simulated drones coming back through forwarding
        v = self._vehicles.get(sysid)
        if kind == "HEARTBEAT":
            if msg.type == mavlink2.MAV_TYPE_GCS:
                return  # a ground station (QGroundControl, MAVProxy), not a vehicle
            v = v or self._vehicles.setdefault(sysid, {"sysid": sysid, "address": f"{addr[0]}:{addr[1]}"})
            v.update(mavlink_parser.parse_heartbeat(msg))
        elif v is None:
            return  # nothing to attach it to until the vehicle's first heartbeat
        elif kind == "GLOBAL_POSITION_INT":
            p = mavlink_parser.parse_global_position_int(msg)
            v.update(latitude=p["latitude"], longitude=p["longitude"], altitude=p["relative_altitude"],
                     ground_speed=math.hypot(p["vx"], p["vy"]), heading=p["heading"])
        elif kind == "GPS_RAW_INT":
            g = mavlink_parser.parse_gps_raw_int(msg)
            v.update(fix_type=g["fix_type"], satellites_visible=g["satellites_visible"], eph=g["eph"])
            v.setdefault("latitude", g["latitude"])
            v.setdefault("longitude", g["longitude"])
        elif kind == "SYS_STATUS":
            s = mavlink_parser.parse_sys_status(msg)
            v.update(drop_rate_comm=s["drop_rate_comm"])
            if s["battery_remaining"] >= 0:
                v["battery_remaining"] = float(s["battery_remaining"])
        elif kind == "RADIO_STATUS":
            r = mavlink_parser.parse_radio_status(msg)
            v.update(rssi=r["rssi"], noise=r["noise"])
        else:
            return
        v["last_seen"] = now

    def snapshot(self, now: Optional[float] = None) -> List[Dict[str, Any]]:
        """Telemetry for every live external vehicle with a position, in ORION's fleet format."""
        now = now if now is not None else time.time()
        for sysid in [s for s, v in self._vehicles.items() if now - v.get("last_seen", 0) > STALE_AFTER_S]:
            del self._vehicles[sysid]
        out = []
        for sysid, v in sorted(self._vehicles.items()):
            if "latitude" not in v:
                continue
            out.append({
                "drone_id": INPUT_DRONE_ID_BASE + sysid,
                "latitude": v["latitude"],
                "longitude": v["longitude"],
                "altitude": v.get("altitude", 0.0),
                "ground_speed": v.get("ground_speed", 0.0),
                "heading": v.get("heading", 0.0),
                "fix_type": v.get("fix_type", 3),
                "satellites_visible": v.get("satellites_visible", 0),
                "eph": v.get("eph", 99.99),
                "battery_remaining": v.get("battery_remaining", 100.0),
                "drop_rate_comm": v.get("drop_rate_comm", 0.0),
                "rssi": v.get("rssi", 100.0),
                "noise": v.get("noise", 0.0),
                "flight_mode": v.get("flight_mode", "GUIDED"),
                "is_armed": v.get("is_armed", True),
                "source": "MAVLINK",
                "mavlink_sysid": sysid,
                "mavlink_address": v["address"],
            })
        return out

    def status(self) -> Dict[str, Any]:
        now = time.time()
        return {
            "enabled": self.enabled,
            "bind": f"{self.bind[0]}:{self.bind[1]}",
            "listening": self.listening,
            "packets_received": self.packets,
            "vehicles": [
                {"sysid": s, "drone_id": INPUT_DRONE_ID_BASE + s, "address": v["address"], "last_seen_s": round(now - v.get("last_seen", now), 1)}
                for s, v in sorted(self._vehicles.items())
            ],
        }


def _build() -> Tuple[MAVLinkOutput, MAVLinkInput]:
    from app.core.config import settings
    return (
        MAVLinkOutput(settings.MAVLINK_OUT_HOST, settings.MAVLINK_OUT_PORT, settings.MAVLINK_OUT_ENABLED),
        MAVLinkInput(settings.MAVLINK_IN_HOST, settings.MAVLINK_IN_PORT, settings.MAVLINK_IN_ENABLED),
    )


mavlink_output, mavlink_input = _build()
