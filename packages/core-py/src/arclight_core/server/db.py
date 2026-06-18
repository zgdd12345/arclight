"""Shared SQLite connection helper for the Python core.

Parity with packages/core/src/db/client.ts PRAGMAs: foreign_keys ON (so
ON DELETE CASCADE fires — Python's sqlite3 defaults it OFF) and busy_timeout for
WAL contention. Per-connection settings only: never sets journal_mode (the TS
drizzle migration owns the persistent WAL mode) and never creates/migrates
schema. Python writes ONLY the tables it owns (one-writer-per-table).
"""
import sqlite3


def connect(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn
