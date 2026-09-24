"""Application settings, read once from the environment."""

from functools import lru_cache
from typing import Annotated, List

from pydantic import field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """
    Everything configurable, in one place.

    Nothing here has a secret as its default. `JWT_SECRET_KEY` ships with an
    obviously-fake value so a misconfigured deployment fails loudly at startup
    (see `validate_production`) rather than quietly signing tokens anybody can
    forge.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ------------------------------------------------------------- database
    DATABASE_HOST: str = "localhost"
    DATABASE_PORT: int = 3306
    DATABASE_USER: str = "root"
    DATABASE_PASSWORD: str = "root"
    DATABASE_NAME: str = "daily_choice_zone"

    # Log every statement. Useful while developing, deafening in production.
    DATABASE_ECHO: bool = False

    # ------------------------------------------------------------------ auth
    JWT_SECRET_KEY: str = "change-this-secret"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    # ----------------------------------------------------------------- app
    APP_NAME: str = "Daily Choice Zone API"
    API_PREFIX: str = "/api"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    # ---------------------------------------------------------------- cors
    # A list, never "*": credentials cannot be sent to a wildcard origin, and
    # an API that accepts any origin is one CSRF away from a bad day.
    #
    # `NoDecode` stops pydantic-settings trying to JSON-parse the value out of
    # the .env file, so the validator below can read the comma-separated form
    # that a .env file can actually express.
    CORS_ORIGINS: Annotated[List[str], NoDecode] = [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]

    # -------------------------------------------------------------- startup
    # Each step of the startup sequence can be turned off independently, so a
    # production deployment can run migrations from its own pipeline instead.
    AUTO_CREATE_DATABASE: bool = True
    AUTO_MIGRATE: bool = True
    AUTO_SEED: bool = True

    # ------------------------------------------------------------- payments
    # Which PaymentProvider implementation to use. "mock" moves no money.
    PAYMENT_PROVIDER: str = "mock"

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        """Accept a comma-separated string, because .env files cannot hold lists."""
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    # ------------------------------------------------------------------ urls
    @property
    def server_url(self) -> str:
        """DSN for the MySQL *server*, with no database selected.

        Needed to create the database before anything can connect to it.
        """
        return (
            f"mysql+pymysql://{self.DATABASE_USER}:{self.DATABASE_PASSWORD}"
            f"@{self.DATABASE_HOST}:{self.DATABASE_PORT}"
        )

    @property
    def database_url(self) -> str:
        return f"{self.server_url}/{self.DATABASE_NAME}?charset=utf8mb4"

    @property
    def is_production(self) -> bool:
        return self.ENVIRONMENT.lower() in {"production", "prod"}

    def validate_production(self) -> List[str]:
        """
        Settings that are fine in development and dangerous in production.

        Returned rather than raised so the caller decides what to do with them —
        `main` refuses to start on any of these when ENVIRONMENT is production.
        """
        problems: List[str] = []

        if self.JWT_SECRET_KEY == "change-this-secret":
            problems.append("JWT_SECRET_KEY is still the default — tokens would be forgeable.")
        if len(self.JWT_SECRET_KEY) < 32:
            problems.append("JWT_SECRET_KEY is shorter than 32 characters.")
        if self.DEBUG:
            problems.append("DEBUG is on, which leaks internals in error responses.")
        if "*" in self.CORS_ORIGINS:
            problems.append("CORS_ORIGINS contains a wildcard.")
        if self.AUTO_SEED:
            problems.append("AUTO_SEED is on — demo data would be written to a production database.")

        return problems


@lru_cache
def get_settings() -> Settings:
    """Read the environment once; every caller shares the result."""
    return Settings()


settings = get_settings()
