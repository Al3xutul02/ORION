import logging
from typing import Dict, Any, Optional
from pymavlink.dialects.v20 import common as mavlink2

logger = logging.getLogger("orion.mavlink")


class MAVLinkParser:
    """
    Parses and serializes MAVLink 2 messages for ORION Ground Control Station:
    - HEARTBEAT
    - GPS_RAW_INT
    - GLOBAL_POSITION_INT
    - SYS_STATUS
    - RADIO_STATUS
    - COMMAND_LONG
    """
    def __init__(self, system_id: int = 255, component_id: int = 1):
        self.mav = mavlink2.MAVLink(None, srcSystem=system_id, srcComponent=component_id)

    def parse_heartbeat(self, msg: mavlink2.MAVLink_heartbeat_message) -> Dict[str, Any]:
        flight_mode = "GUIDED"
        if msg.custom_mode == 3:
            flight_mode = "AUTO"
        elif msg.custom_mode == 6:
            flight_mode = "RTL"
        elif msg.custom_mode == 5:
            flight_mode = "LOITER"

        is_armed = bool(msg.base_mode & mavlink2.MAV_MODE_FLAG_SAFETY_ARMED)
        return {
            "type": "HEARTBEAT",
            "flight_mode": flight_mode,
            "is_armed": is_armed,
            "system_status": msg.system_status
        }

    def parse_gps_raw_int(self, msg: mavlink2.MAVLink_gps_raw_int_message) -> Dict[str, Any]:
        return {
            "type": "GPS_RAW_INT",
            "fix_type": msg.fix_type,
            "latitude": msg.lat / 1e7,
            "longitude": msg.lon / 1e7,
            "altitude": msg.alt / 1e3,
            "eph": msg.eph / 100.0,  # convert cm to meters HDOP
            "satellites_visible": msg.satellites_visible
        }

    def parse_global_position_int(self, msg: mavlink2.MAVLink_global_position_int_message) -> Dict[str, Any]:
        return {
            "type": "GLOBAL_POSITION_INT",
            "latitude": msg.lat / 1e7,
            "longitude": msg.lon / 1e7,
            "altitude": msg.alt / 1e3,
            "relative_altitude": msg.relative_alt / 1e3,
            "vx": msg.vx / 100.0,
            "vy": msg.vy / 100.0,
            "vz": msg.vz / 100.0,
            "heading": msg.hdg / 100.0
        }

    def parse_sys_status(self, msg: mavlink2.MAVLink_sys_status_message) -> Dict[str, Any]:
        return {
            "type": "SYS_STATUS",
            "drop_rate_comm": msg.drop_rate_comm / 100.0,  # percentage
            "battery_remaining": msg.battery_remaining
        }

    def parse_radio_status(self, msg: mavlink2.MAVLink_radio_status_message) -> Dict[str, Any]:
        return {
            "type": "RADIO_STATUS",
            "rssi": (msg.rssi / 255.0) * 100.0,  # normalize to 0..100%
            "noise": msg.noise
        }

    def create_command_long_bytes(
        self,
        target_system: int,
        target_component: int,
        command_id: int,
        param1: float = 0.0,
        param2: float = 0.0,
        param3: float = 0.0,
        param4: float = 0.0,
        param5: float = 0.0,
        param6: float = 0.0,
        param7: float = 0.0
    ) -> bytes:
        """
        Builds a binary MAVLink 2 COMMAND_LONG packet (e.g. RTL, LOITER).
        """
        msg = self.mav.command_long_encode(
            target_system=target_system,
            target_component=target_component,
            command=command_id,
            confirmation=0,
            param1=param1,
            param2=param2,
            param3=param3,
            param4=param4,
            param5=param5,
            param6=param6,
            param7=param7
        )
        return msg.pack(self.mav)


mavlink_parser = MAVLinkParser()
