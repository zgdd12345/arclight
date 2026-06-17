"""Generate pydantic v2 models from the protocol JSON Schema bundle.

Source of truth is @arclight/protocol (zod). This output is generated;
never hand-edit src/arclight_core/protocol/models.py.

Invocation (from packages/core-py):
    conda run -n arclight python scripts/gen_models.py

Flag notes:
- --use-title-as-name is intentionally OMITTED: the $defs entries in the
  schema carry no "title" fields, so that flag would not produce the correct
  $defs-key names (ArcCommand, ArcAck, …). Without it, datamodel-codegen
  derives class names from the $defs keys directly, which is what we want.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# packages/core-py/scripts/ -> packages/core-py/ -> packages/ -> <repo-root>
SCHEMA = HERE.parents[1] / "protocol" / "schema" / "arclight-protocol.schema.json"
OUT = HERE.parent / "src" / "arclight_core" / "protocol" / "models.py"


def main() -> int:
    if not SCHEMA.exists():
        # repo-root-relative fallback (monorepo layout)
        alt = HERE.parents[2] / "protocol" / "schema" / "arclight-protocol.schema.json"
        schema = alt if alt.exists() else SCHEMA
    else:
        schema = SCHEMA

    if not schema.exists():
        print(f"ERROR: schema not found at {schema}", file=sys.stderr)
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "datamodel-codegen",
        "--input", str(schema),
        "--input-file-type", "jsonschema",
        "--output", str(OUT),
        "--output-model-type", "pydantic_v2.BaseModel",
        "--target-python-version", "3.12",
    ]
    print(" ".join(cmd))
    return subprocess.call(cmd)


if __name__ == "__main__":
    sys.exit(main())
