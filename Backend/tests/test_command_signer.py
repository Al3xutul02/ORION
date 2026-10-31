import time
import pytest
from app.core.security import MAVLink2CommandSigner


def test_command_signing_and_verification():
    signer = MAVLink2CommandSigner(secret_key="test_secret_key")
    cmd = signer.sign_command(
        command_name="LOITER",
        drone_id=1,
        sequence=1,
        params={"radius": 50}
    )
    assert "signature" in cmd
    is_valid, msg = signer.verify_command(cmd)
    assert is_valid is True
    assert "ACCEPTED" in msg


def test_command_replay_rejection():
    signer = MAVLink2CommandSigner(secret_key="test_secret_key")
    cmd = signer.sign_command(
        command_name="LOITER",
        drone_id=2,
        sequence=1,
        params={"radius": 50}
    )
    # First submission: Valid
    is_valid, msg = signer.verify_command(cmd)
    assert is_valid is True

    # Replay identical command: Must be rejected
    is_valid_replay, msg_replay = signer.verify_command(cmd)
    assert is_valid_replay is False
    assert "Replay attack detected" in msg_replay


def test_expired_command_rejection():
    signer = MAVLink2CommandSigner(secret_key="test_secret_key", max_age_seconds=2.0)
    cmd = signer.sign_command(
        command_name="RTL",
        drone_id=3,
        sequence=1,
        params={},
        timestamp=time.time() - 10.0  # 10 seconds old
    )
    is_valid, msg = signer.verify_command(cmd)
    assert is_valid is False
    assert "Expired" in msg
