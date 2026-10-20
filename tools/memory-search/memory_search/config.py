"""
Configuration for memory-search.

All paths and tunables are env-overridable so the tool works in any project,
not just the original author's `~/agent/` setup.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Optional


# --- Paths ---

def _default_claudeclaw_root() -> Path:
    """Resolve the ClaudeClaw root directory."""
    env = os.environ.get("CLAUDECLAW_ROOT")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".claude" / "claudeclaw"


def db_path() -> Path:
    """Path to the SQLite memory-search database."""
    env = os.environ.get("MEMORY_SEARCH_DB")
    if env:
        return Path(env).expanduser()
    return _default_claudeclaw_root() / "memory-search.db"


def sessions_dirs() -> list[Path]:
    """
    Directories to scan for session JSONL files.

    Default: scan all subdirs under ~/.claude/projects/ (Claude Code's
    default location). Override via MEMORY_SEARCH_SESSIONS_DIR (colon-separated).
    """
    env = os.environ.get("MEMORY_SEARCH_SESSIONS_DIR")
    if env:
        return [Path(p).expanduser() for p in env.split(":") if p.strip()]

    default = Path.home() / ".claude" / "projects"
    if default.exists():
        # Each project gets its own subdir under ~/.claude/projects/
        return [d for d in default.iterdir() if d.is_dir()]
    return []


# --- Embedding model ---

def embedding_model_name() -> str:
    """Sentence-transformer model name. Override with MEMORY_SEARCH_MODEL."""
    return os.environ.get("MEMORY_SEARCH_MODEL", "all-MiniLM-L6-v2")


def embedding_dim() -> int:
    """Embedding dimensionality. Used for sanity-checking persisted vectors."""
    return int(os.environ.get("MEMORY_SEARCH_DIM", "384"))


# --- Search defaults ---

def default_alpha() -> float:
    """
    Alpha blend for hybrid search.
    1.0 = pure semantic, 0.0 = pure FTS5, 0.5 = equal weight.
    """
    return float(os.environ.get("MEMORY_SEARCH_ALPHA", "0.5"))


def chunk_size() -> int:
    """Number of message turns per chunk. Bigger = more context per vector."""
    return int(os.environ.get("MEMORY_SEARCH_CHUNK_SIZE", "5"))


def message_max_chars() -> int:
    """Truncate individual messages at N chars before chunking."""
    return int(os.environ.get("MEMORY_SEARCH_MSG_MAX", "2000"))


def chunk_msg_excerpt_chars() -> int:
    """When concatenating messages into a chunk, truncate each at N chars."""
    return int(os.environ.get("MEMORY_SEARCH_CHUNK_EXCERPT", "400"))


# --- Summarizer ---

def claude_cli_path() -> Optional[str]:
    """
    Resolve the `claude` CLI binary.

    Priority:
      1. CLAUDECLAW_CLAUDE_BIN env var
      2. shutil.which('claude')
      3. None (caller should fall back to no-summary)
    """
    env = os.environ.get("CLAUDECLAW_CLAUDE_BIN")
    if env and Path(env).exists():
        return env
    return shutil.which("claude")


def summarizer_model() -> str:
    """Claude model used by the `claude --print` summarizer."""
    return os.environ.get("MEMORY_SEARCH_SUMMARY_MODEL", "claude-haiku-4-5")


def summarizer_timeout_sec() -> int:
    return int(os.environ.get("MEMORY_SEARCH_SUMMARY_TIMEOUT", "30"))


def summarizer_cwd() -> Optional[Path]:
    """Working dir for the summarizer subprocess (None = a fresh empty temp dir)."""
    env = os.environ.get("MEMORY_SEARCH_SUMMARY_CWD")
    return Path(env).expanduser() if env else None
