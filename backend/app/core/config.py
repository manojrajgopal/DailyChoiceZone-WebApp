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

    # ------------------------------------------------------------- payments
    # Which PaymentProvider implementation to use. "mock" moves no money.
    PAYMENT_PROVIDER: str = "mock"

    # Razorpay. Only used when PAYMENT_PROVIDER is "razorpay".
    #
    # The key **id** is publishable: Razorpay Checkout runs in the browser and
    # needs it, and it is served to the client by `GET /api/payments/config`.
    # The key **secret** and the webhook secret never leave this process — they
    # sign requests to the gateway and verify what comes back, so anything
    # holding them can take money. Neither has a NEXT_PUBLIC_ counterpart, and
    # neither may ever be added to one.
    RAZOR_KEY_ID: str = ""
    RAZOR_KEY_SECRET: str = ""

    # Set this to the signing secret from the Razorpay dashboard webhook page.
    # Without it the webhook endpoint refuses every delivery, because an
    # unverified webhook is an open endpoint for marking orders paid.
    RAZOR_WEBHOOK_SECRET: str = ""

    @property
    def razorpay_configured(self) -> bool:
        return bool(self.RAZOR_KEY_ID and self.RAZOR_KEY_SECRET)

    @property
    def razorpay_live(self) -> bool:
        """Live keys, which take real money. Read from the key's own prefix."""
        return self.RAZOR_KEY_ID.startswith("rzp_live_")

    # How long an unpaid prepaid order holds its stock.
    #
    # The order is created, its items are reserved, and the shopper has this
    # long to pay. After that the sweeper cancels it and releases the hold, and
    # a payment that arrives later is refunded rather than allowed to confirm
    # an order that no longer exists. Five minutes, per the store's own rule.
    PAYMENT_WINDOW_SECONDS: int = 300

    # Slack after the window before a hold is actually released.
    #
    # The window is when a shopper may *start* paying; a payment begun at 4:58
    # can take a minute to be confirmed by the bank. Cancelling at exactly
    # 5:00 would refund people who did everything right. So new payments are
    # refused at the window, and the stock is released — and anything arriving
    # later refunded — only once this has passed as well.
    PAYMENT_GRACE_SECONDS: int = 90

    # How often the sweeper looks for expired holds. The window is enforced
    # lazily as well — every verify, poll and session call checks it — so this
    # only bounds how long an abandoned order can sit before its stock returns.
    PAYMENT_SWEEP_SECONDS: int = 30

    # The most unpaid, stock-holding orders one customer may have open at once.
    #
    # Without a cap, holding stock is free: an account can place orders it
    # never means to pay for and keep a product "sold out" for everyone else,
    # five minutes at a time, indefinitely. Three leaves room for a genuine
    # retry after a declined card.
    MAX_UNPAID_ORDERS_PER_CUSTOMER: int = 3

    # The storefront's public origin. Payment Links send the shopper back here
    # after paying, so it must be where the site is actually served — and in
    # production it must be HTTPS.
    STOREFRONT_URL: str = "http://localhost:3000"

    # Where uploaded product photographs are written, relative to the backend
    # folder unless absolute. Served read-only at /uploads.
    UPLOAD_DIR: str = "uploads"

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

        # --- payments ------------------------------------------------------
        #
        # A production store must take real money through a real gateway,
        # verify what it is told, and never quietly fall back to something that
        # takes nothing. Each of these is a way that could happen.
        if self.PAYMENT_PROVIDER != "razorpay":
            problems.append(
                f"PAYMENT_PROVIDER is '{self.PAYMENT_PROVIDER}'. Production takes real "
                "payments, so it must be 'razorpay'."
            )
        else:
            if not self.razorpay_configured:
                problems.append("RAZOR_KEY_ID and RAZOR_KEY_SECRET must both be set.")
            elif not self.razorpay_live:
                problems.append(
                    "RAZOR_KEY_ID is a test key (rzp_test_…). Production needs the live "
                    "key (rzp_live_…) — test keys take no money, and orders would be "
                    "confirmed for payments that never happened."
                )
            if not self.RAZOR_WEBHOOK_SECRET:
                problems.append(
                    "RAZOR_WEBHOOK_SECRET is empty. Without it no webhook can be "
                    "trusted, and an order paid by someone who closes the tab is never "
                    "confirmed."
                )
        if not self.STOREFRONT_URL.startswith("https://"):
            problems.append("STOREFRONT_URL must be HTTPS in production.")

        return problems


@lru_cache
def get_settings() -> Settings:
    """Read the environment once; every caller shares the result."""
    return Settings()


settings = get_settings()
