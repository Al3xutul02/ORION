import sys
import os

# Add parent directory to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from app.core.database import Base, engine, SessionLocal
from app.models.audit import AuditLog
from app.services.aar_service import aar_service
from app.services.theatre_rules import theatre_rules
from app.models.zone import TacticalZone
import json


def main():
    print(">>> Initializing ORION database tables...")
    Base.metadata.create_all(bind=engine)
    print(">>> Tables created successfully.")

    with SessionLocal() as db:
        # Check tactical zones
        zone_count = db.query(TacticalZone).count()
        if zone_count == 0:
            print(">>> Seeding predefined tactical zones...")
            for z in theatre_rules.zones:
                zone_model = TacticalZone(
                    name=z["name"],
                    zone_type=z["zone_type"],
                    geometry_type=z["geometry_type"],
                    coordinates_json=json.dumps(z.get("center") or z.get("waypoints")),
                    is_active=z.get("is_active", True),
                    detected_by=z.get("detected_by", "PRECONFIGURED")
                )
                db.add(zone_model)
            db.commit()
            print(">>> Tactical zones seeded.")

        # Check AAR genesis
        log_count = db.query(AuditLog).count()
        if log_count == 0:
            print(">>> Creating initial cryptographic AAR genesis entry...")
            aar_service.log_event(
                db=db,
                event_type="SYSTEM_INITIALIZED",
                drone_id=None,
                details={"status": "DATABASE_INITIALIZED", "description": "Genesis block for ORION Post-Action Report"},
                operator_id="SYSTEM"
            )
            print(">>> AAR genesis block created.")

    print(">>> Initialization complete!")


if __name__ == "__main__":
    main()
