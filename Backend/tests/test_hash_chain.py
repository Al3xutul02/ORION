import pytest
from app.core.security import calculate_event_hash, verify_hash_chain, GENESIS_HASH


def test_hash_chain_sequential_integrity():
    """Tests that a series of valid chained records verifies successfully."""
    records = []
    prev = GENESIS_HASH

    for i in range(5):
        ts = f"2026-10-30T14:0{i}:00Z"
        event = f"EVENT_{i}"
        details = f'{{"counter": {i}}}'
        curr = calculate_event_hash(
            prev_hash=prev,
            timestamp=ts,
            event_type=event,
            drone_id=i + 1,
            details=details,
            operator_id="SYSTEM"
        )
        records.append({
            "id": i + 1,
            "prev_hash": prev,
            "curr_hash": curr,
            "timestamp": ts,
            "event_type": event,
            "drone_id": i + 1,
            "details": details,
            "operator_id": "SYSTEM"
        })
        prev = curr

    is_valid, broken_idx, msg = verify_hash_chain(records)
    assert is_valid is True
    assert broken_idx is None
    assert "verified successfully" in msg


def test_hash_chain_tamper_detection():
    """Tests that altering an event's details is immediately detected as tampering."""
    records = []
    prev = GENESIS_HASH

    for i in range(4):
        ts = f"2026-10-30T14:0{i}:00Z"
        details = f'{{"message": "log {i}"}}'
        curr = calculate_event_hash(prev, ts, "LOG", i, details, "SYSTEM")
        records.append({
            "id": i + 1,
            "prev_hash": prev,
            "curr_hash": curr,
            "timestamp": ts,
            "event_type": "LOG",
            "drone_id": i,
            "details": details,
            "operator_id": "SYSTEM"
        })
        prev = curr

    # Tamper with record 2 details
    records[2]["details"] = '{"message": "TAMPERED DATA"}'

    is_valid, broken_idx, msg = verify_hash_chain(records)
    assert is_valid is False
    assert broken_idx == 2
    assert "Tampered record detected at index 2" in msg
