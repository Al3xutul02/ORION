from typing import List, Union
from pydantic import AnyHttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )

    PROJECT_NAME: str = "ORION Ground Control Station"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"
    
    # Server settings
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    ENVIRONMENT: str = "development"
    
    # CORS
    CORS_ORIGINS: Union[str, List[str]] = [
        "http://localhost:4200",
        "http://127.0.0.1:4200",
        "http://localhost:3000",
        "http://127.0.0.1:3000"
    ]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: Union[str, List[str]]) -> List[str]:
        if isinstance(v, str) and not v.startswith("["):
            return [i.strip() for i in v.split(",") if i.strip()]
        elif isinstance(v, list):
            return v
        return ["*"]

    # Database Settings
    DB_TYPE: str = "mysql"  # "mysql" or "sqlite"
    MYSQL_HOST: str = "localhost"
    MYSQL_PORT: int = 3306
    MYSQL_USER: str = "root"
    MYSQL_PASSWORD: str = ""
    MYSQL_DATABASE: str = "orion_gcs"
    SQLITE_DB_PATH: str = "./orion_gcs.db"

    @property
    def mysql_url(self) -> str:
        pwd = f":{self.MYSQL_PASSWORD}" if self.MYSQL_PASSWORD else ""
        return f"mysql+pymysql://{self.MYSQL_USER}{pwd}@{self.MYSQL_HOST}:{self.MYSQL_PORT}/{self.MYSQL_DATABASE}?charset=utf8mb4"

    @property
    def sqlite_url(self) -> str:
        return f"sqlite:///{self.SQLITE_DB_PATH}"

    # MAVLink 2 Security & Signing
    MAVLINK_SIGNING_KEY: str = "craiova_hackathon_orion_secret_key_2026"
    MAVLINK_SYSTEM_ID: int = 255
    MAVLINK_COMPONENT_ID: int = 1
    
    # Simulator Settings
    SIMULATION_DRONE_COUNT: int = 4
    SIMULATION_TICK_RATE_HZ: float = 2.0
    SIMULATION_DEMO_ENABLED: bool = True


settings = Settings()
