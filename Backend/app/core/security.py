import hashlib
import hmac
import json
import time
from typing import Any, Dict, List, Optional, Tuple
from app.core.config import settings

GENESIS_HASH = "0" * 64


def calculate_event_hash(
    prev_hash: str,
    timestamp: str,
    event_type: str,
    drone_id: Optional[int],
    details: str,
    operator_id: Optional[str] = "SYSTEM"
) -> str:
    """
    Computes a cryptographic SHA-256 hash for an event in the tamper-evident AAR log.
    Every event entry links strictly to the preceding entry's hash.
    """
    payload = {
        "prev_hash": prev_hash,
        "timestamp": timestamp,
        "event_type": event_type,
        "drone_id": drone_id,
        "details": details,
        "operator_id": operator_id or "SYSTEM"
    }
    canonical_str = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical_str.encode("utf-8")).hexdigest()


def verify_hash_chain(records: List[Dict[str, Any]]) -> Tuple[bool, Optional[int], str]:
    """
    Validates the cryptographic integrity of the AAR hash chain.
    Returns (is_valid, broken_at_index, message).
    """
    if not records:
        return True, None, "Hash chain is empty. Valid by default."

    expected_prev = GENESIS_HASH

    for idx, rec in enumerate(records):
        prev_hash = rec.get("prev_hash")
        curr_hash = rec.get("curr_hash")
        timestamp = str(rec.get("timestamp"))
        event_type = str(rec.get("event_type"))
        drone_id = rec.get("drone_id")
        details = str(rec.get("details"))
        operator_id = rec.get("operator_id")

        if prev_hash != expected_prev:
            return (
                False,
                idx,
                f"Broken chain at index {idx} (ID: {rec.get('id')}): "
                f"prev_hash '{prev_hash}' does not match expected '{expected_prev}'"
            )

        calculated = calculate_event_hash(
            prev_hash=prev_hash,
            timestamp=timestamp,
            event_type=event_type,
            drone_id=drone_id,
            details=details,
            operator_id=operator_id
        )

        if calculated != curr_hash:
            return (
                False,
                idx,
                f"Tampered record detected at index {idx} (ID: {rec.get('id')}): "
                f"hash '{curr_hash}' != calculated '{calculated}'"
            )

        expected_prev = curr_hash

    return True, None, f"Hash chain verified successfully ({len(records)} entries intact)."


class MAVLink2CommandSigner:
    """
    Manages MAVLink 2 cryptographic command signing and anti-replay verification.
    Rejects unsigned, expired, or retransmitted (replay) commands.
    """
    def __init__(self, secret_key: Optional[str] = None, max_age_seconds: float = 5.0):
        self.secret_key = (secret_key or settings.MAVLINK_SIGNING_KEY).encode("utf-8")
        self.max_age_seconds = max_age_seconds
        # Seen signatures/sequence set to detect replays
        self._seen_signatures: set[str] = set()
        self._last_sequences: Dict[int, int] = {}  # drone_id -> monotonic sequence

    def sign_command(self, command_name: str, drone_id: int, sequence: int, params: Dict[str, Any], timestamp: Optional[float] = None) -> Dict[str, Any]:
        """
        Signs an outgoing MAVLink 2 command with an HMAC-SHA256 signature.
        """
        ts = timestamp if timestamp is not None else time.time()
        canonical = json.dumps(
            {
                "command": command_name,
                "drone_id": drone_id,
                "sequence": sequence,
                "params": params,
                "timestamp": round(ts, 3)
            },
            sort_keys=True
        )
        sig = hmac.new(self.secret_key, canonical.encode("utf-8"), hashlib.sha256).hexdigest()
        return {
            "command": command_name,
            "drone_id": drone_id,
            "sequence": sequence,
            "params": params,
            "timestamp": round(ts, 3),
            "signature": sig
        }

    def verify_command(self, command_data: Dict[str, Any]) -> Tuple[bool, str]:
        """
        Validates MAVLink 2 command authenticity, expiration window, and replay protection.
        """
        signature = command_data.get("signature")
        if not signature:
            return False, "REJECTED: Unsigned MAVLink 2 command"

        cmd_ts = command_data.get("timestamp", 0)
        current_time = time.time()
        age = abs(current_time - cmd_ts)

        # 1. Freshness check
        if age > self.max_age_seconds:
            return False, f"REJECTED: Expired command (age: {age:.2f}s > {self.max_age_seconds}s)"

        # 2. Replay check (exact signature seen before)
        if signature in self._seen_signatures:
            return False, "REJECTED: Replay attack detected (signature already processed)"

        # 3. Monotonic sequence verification per drone
        drone_id = command_data.get("drone_id", 0)
        seq = command_data.get("sequence", 0)
        last_seq = self._last_sequences.get(drone_id, -1)
        if seq <= last_seq:
            return False, f"REJECTED: Replay/Out-of-order sequence (received {seq} <= last {last_seq})"

        # 4. Cryptographic HMAC verification
        canonical = json.dumps(
            {
                "command": command_data.get("command"),
                "drone_id": drone_id,
                "sequence": seq,
                "params": command_data.get("params", {}),
                "timestamp": round(cmd_ts, 3)
            },
            sort_keys=True
        )
        expected_sig = hmac.new(self.secret_key, canonical.encode("utf-8"), hashlib.sha256).hexdigest()

        if not hmac.compare_digest(signature, expected_sig):
            return False, "REJECTED: Invalid cryptographic signature"

        # Mark as accepted
        self._seen_signatures.add(signature)
        self._last_sequences[drone_id] = seq
        return True, "ACCEPTED: Cryptographically verified MAVLink 2 command"


command_signer = MAVLink2CommandSigner()
