import logging
from typing import Generator
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from sqlalchemy.exc import OperationalError
from app.core.config import settings

logger = logging.getLogger("orion.database")

Base = declarative_base()

def get_engine():
    """
    Attempts to initialize MySQL engine as requested in the architecture specification.
    If MySQL credentials are not yet configured or connection fails,
    transparently falls back to SQLite so development & demo never stall.
    """
    if settings.DB_TYPE.lower() == "mysql":
        try:
            # First attempt to ensure database exists if root/admin connects
            raw_url = f"mysql+pymysql://{settings.MYSQL_USER}:{settings.MYSQL_PASSWORD}@{settings.MYSQL_HOST}:{settings.MYSQL_PORT}/"
            temp_engine = create_engine(raw_url, isolation_level="AUTOCOMMIT", pool_pre_ping=True)
            with temp_engine.connect() as conn:
                conn.execute(text(f"CREATE DATABASE IF NOT EXISTS `{settings.MYSQL_DATABASE}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"))
            temp_engine.dispose()

            engine = create_engine(
                settings.mysql_url,
                pool_pre_ping=True,
                pool_recycle=3600,
                echo=False
            )
            # Test connection
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            logger.info("Connected successfully to MySQL database: %s", settings.MYSQL_DATABASE)
            return engine
        except Exception as e:
            logger.warning(
                "Could not connect to MySQL (%s). Falling back to SQLite database at '%s'. Update .env with valid MySQL credentials.",
                str(e),
                settings.SQLITE_DB_PATH
            )
    
    # SQLite fallback
    engine = create_engine(
        settings.sqlite_url,
        connect_args={"check_same_thread": False},
        echo=False
    )
    logger.info("Using SQLite database at %s", settings.SQLITE_DB_PATH)
    return engine


engine = get_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator:
    """FastAPI dependency for database sessions."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
