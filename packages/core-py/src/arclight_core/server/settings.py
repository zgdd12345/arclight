"""Server settings, loaded from env in production or injected in tests."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str
    projects_root: str
    token: str
    dev_no_auth: bool


def from_env() -> Settings:
    return Settings(
        db_path=os.environ.get("ARCLIGHT_DB_PATH", ""),
        projects_root=os.environ.get("ARCLIGHT_PROJECTS_ROOT", ""),
        token=os.environ.get("ARCLIGHT_TOKEN", ""),
        dev_no_auth=os.environ.get("ARCLIGHT_DEV_NO_AUTH", "") == "1",
    )
