"""
High-level recall: search the session DB and optionally summarize the hits.

Two modes:
  1. Plain: print the top-N session excerpts.
  2. With summary: pipe the excerpts through `claude --print` to get a
     short narrative answer to the user's query.

The `claude --print` path uses Claude Code's existing OAuth session, so it
works without an Anthropic API key (handy for Claude Max users).
"""

from __future__ import annotations

import contextlib
import json
import logging
import subprocess
import tempfile
from typing import Optional

from . import config, db

log = logging.getLogger(__name__)

# The excerpts fed to the summarizer are arbitrary transcript text (pasted
# emails, web pages, tool output), so the call gets nothing to act with: no
# built-in tools, no MCP servers, no settings file (no hooks, no user
# plugins), no saved session and no slash commands. Same set as
# UNTRUSTED_CLAUDE_ARGS in src/oneshot/isolation.ts. The empty strings are flag
# values, not gaps.
UNTRUSTED_CLI_FLAGS = [
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--disable-slash-commands",
]


def summarize(query: str, hits: list[dict]) -> Optional[str]:
    """
    Produce a short summary of the search hits using `claude --print`.
    Returns None if the CLI is unavailable or the call fails.
    """
    cli = config.claude_cli_path()
    if not cli:
        log.info("claude CLI not found; skipping summary")
        return None

    if not hits:
        return None

    excerpts = []
    for h in hits:
        ts = (h.get("timestamp") or "?")[:16]
        sid = h.get("session_id", "")[:8]
        excerpts.append(f"--- Session {sid} ({ts}) ---\n{h.get('excerpt', '')}")

    prompt = (
        f'Here are excerpts from past Claude Code sessions relevant to the query: "{query}"\n\n'
        + "\n\n".join(excerpts)
        + "\n\nSummarize in 3-5 concise bullet points what was done or discussed "
          "in relation to this query. Be direct and factual."
    )

    try:
        with contextlib.ExitStack() as stack:
            cwd = config.summarizer_cwd()
            if cwd is None:
                # Empty cwd, so no project dir is ever in reach of the call.
                # A cleanup error (Windows file lock) must not replace the
                # result.
                cwd = stack.enter_context(
                    tempfile.TemporaryDirectory(
                        prefix="memory-search-summary-", ignore_cleanup_errors=True
                    )
                )
            result = subprocess.run(
                [cli, "--print", "--model", config.summarizer_model(),
                 *UNTRUSTED_CLI_FLAGS],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=config.summarizer_timeout_sec(),
                cwd=cwd,
            )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log.warning("claude --print failed: %s", e)
        return None

    if result.returncode != 0:
        log.warning("claude --print exit=%s stderr=%s",
                    result.returncode, result.stderr[:200])
        return None

    out = (result.stdout or "").strip()
    return out or None


def recall(
    query: str,
    *,
    top_k: int = 5,
    alpha: Optional[float] = None,
    do_summary: bool = True,
) -> dict:
    """
    Run a hybrid search and return a structured response with optional summary.

    Returns:
        {
            "query": str,
            "hits": [ {score, session_id, timestamp, turn_count, excerpt}, ... ],
            "summary": str | None,
        }
    """
    hits = db.search(query, top_k=top_k, alpha=alpha)
    summary = summarize(query, hits) if do_summary else None
    return {"query": query, "hits": hits, "summary": summary}


def format_for_humans(result: dict) -> str:
    """Render the recall response for terminal output."""
    lines: list[str] = []
    lines.append(f'🔍 Search: "{result["query"]}"')
    if not result["hits"]:
        lines.append("❌ No results in session history.")
        return "\n".join(lines)

    lines.append("")
    lines.append(f"✅ {len(result['hits'])} session(s) found:")
    lines.append("")
    for h in result["hits"]:
        ts = (h.get("timestamp") or "?")[:16]
        lines.append(
            f"  📅 {ts} | Score: {h['score']} | {h['turn_count']} turns"
        )
        excerpt = h.get("excerpt", "")
        lines.append(f"     {excerpt[:200]}{'...' if len(excerpt) > 200 else ''}")
        lines.append("")

    if result.get("summary"):
        lines.append("💬 Summary:")
        lines.append("-" * 40)
        lines.append(result["summary"])
    elif result["hits"]:
        # Be explicit so the user knows why there's no summary
        if not config.claude_cli_path():
            lines.append("(claude CLI not found — summary disabled)")
    return "\n".join(lines)


def format_as_json(result: dict) -> str:
    return json.dumps(result, ensure_ascii=False, indent=2)
