import json
from pathlib import Path

from arclight_core.protocol import models

FIXTURES = Path(__file__).resolve().parents[2] / "protocol" / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def test_arc_command_submit_validates():
    models.ArcCommand.model_validate(_load("arc-command-submit.json"))


def test_turn_completed_validates():
    models.TurnCompleted.model_validate(_load("turn-completed.json"))
