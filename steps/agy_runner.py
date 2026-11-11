"""Helper wrapper around `agy -p --output-format json --json-schema`."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import jsonschema


class AgyExecutionError(RuntimeError):
    """Raised when `agy` headless execution fails or returns invalid structured output."""


def get_app_support_dir() -> Path:
    """Return ~/Library/Application Support/3DGenerator directory."""
    app_dir = Path.home() / "Library" / "Application Support" / "3DGenerator"
    app_dir.mkdir(parents=True, exist_ok=True)
    return app_dir


def load_app_config() -> dict[str, Any]:
    """Load config.json from Application Support if present."""
    config_file = get_app_support_dir() / "config.json"
    if config_file.is_file():
        try:
            with open(config_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data if isinstance(data, dict) else {}
        except Exception:
            return {}
    return {}


def save_app_config(updates: dict[str, Any]) -> dict[str, Any]:
    """Save updates to config.json."""
    cfg = load_app_config()
    cfg.update(updates)
    config_file = get_app_support_dir() / "config.json"
    with open(config_file, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return cfg


def find_agy_binary() -> str:
    """Locate the `agy` CLI binary using config, PATH, and standard user/system directories."""
    # 1. Configured custom path
    cfg = load_app_config()
    custom_path = cfg.get("agy_path")
    if custom_path and Path(custom_path).is_file():
        return str(Path(custom_path).resolve())

    # 2. PATH
    agy_path = shutil.which("agy")
    if agy_path:
        return agy_path

    # 3. Known installation candidate paths
    home = Path.home()
    candidates = [
        home / ".local" / "bin" / "agy",
        home / ".gemini" / "antigravity-cli" / "bin" / "agy",
        home / ".cargo" / "bin" / "agy",
        Path("/opt/homebrew/bin/agy"),
        Path("/usr/local/bin/agy"),
        Path("/usr/bin/agy"),
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate.resolve())

    raise AgyExecutionError(
        "Could not find `agy` binary in PATH, ~/.local/bin/agy, or ~/.gemini/antigravity-cli/bin/agy. "
        "Please install Antigravity CLI or set its location."
    )


def check_agy_status() -> dict[str, Any]:
    """Check whether `agy` is installed, resolvable, and functional."""
    try:
        binary = find_agy_binary()
        proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        version_str = (proc.stdout or proc.stderr or "").strip()
        return {
            "installed": proc.returncode == 0,
            "path": binary,
            "version": version_str,
            "error": None if proc.returncode == 0 else f"Exited with code {proc.returncode}: {version_str}",
        }
    except Exception as exc:
        return {
            "installed": False,
            "path": None,
            "version": None,
            "error": str(exc),
        }


def parse_agy_json_envelope(raw_stdout: str, schema: dict[str, Any] | None = None) -> dict[str, Any]:
    """Parse `agy --output-format json` stdout and extract `structured_output`.

    Args:
        raw_stdout: Raw stdout captured from `agy -p ... --output-format json`.
        schema: Optional JSON schema dictionary to validate the structured output against.

    Returns:
        Parsed and schema-validated dictionary payload.
    """
    text = raw_stdout.strip()
    if not text:
        raise AgyExecutionError("Empty stdout received from `agy`")

    # Find the JSON object in stdout (handles any stray log lines before the JSON envelope)
    envelope: dict[str, Any] | None = None
    try:
        envelope = json.loads(text)
    except json.JSONDecodeError:
        first_brace = text.find("{")
        last_brace = text.rfind("}")
        if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
            try:
                envelope = json.loads(text[first_brace : last_brace + 1])
            except json.JSONDecodeError as exc:
                raise AgyExecutionError(f"Failed to parse JSON envelope from agy stdout: {exc}\nRaw: {text[:500]}") from exc
        else:
            raise AgyExecutionError(f"No JSON object found in agy stdout: {text[:500]}")

    if not isinstance(envelope, dict):
        raise AgyExecutionError(f"Expected JSON object envelope from agy, got {type(envelope).__name__}")

    status = envelope.get("status")
    if status and status != "SUCCESS":
        err_msg = envelope.get("error") or envelope.get("response") or f"agy exited with status={status}"
        raise AgyExecutionError(f"agy failed with status={status}: {err_msg}")

    if "structured_output" in envelope and isinstance(envelope["structured_output"], dict):
        payload = envelope["structured_output"]
    elif "response" in envelope and isinstance(envelope["response"], str):
        resp_text = envelope["response"].strip()
        try:
            payload = json.loads(resp_text)
        except json.JSONDecodeError as exc:
            raise AgyExecutionError(
                f"agy envelope missing `structured_output` and `response` is not valid JSON: {resp_text[:500]}"
            ) from exc
    else:
        # In case raw_stdout was already the direct payload
        payload = envelope

    if not isinstance(payload, dict):
        raise AgyExecutionError(f"Expected structured_output to be a dict, got {type(payload).__name__}")

    if schema is not None:
        try:
            jsonschema.validate(instance=payload, schema=schema)
        except jsonschema.ValidationError as exc:
            raise AgyExecutionError(f"Structured output failed JSON schema validation: {exc.message}") from exc

    return payload


def run_agy_json(
    prompt: str,
    schema_path: Path,
    workspace_dir: Path | None = None,
    extra_dirs: list[Path] | None = None,
    timeout_sec: int = 300,
) -> dict[str, Any]:
    """Run `agy` in headless mode (`-p --output-format json --json-schema`) and return validated JSON.

    Args:
        prompt: The prompt string sent to `agy -p`.
        schema_path: Path to the `.schema.json` file.
        workspace_dir: Working directory for the `agy` invocation.
        extra_dirs: Additional directories to grant workspace access via `--add-dir`.
        timeout_sec: Subprocess timeout in seconds.

    Returns:
        Validated `structured_output` dictionary matching `schema_path`.
    """
    agy_bin = find_agy_binary()
    schema_path = schema_path.resolve()
    if not schema_path.is_file():
        raise FileNotFoundError(f"JSON schema file not found: {schema_path}")

    with open(schema_path, "r", encoding="utf-8") as f:
        schema = json.load(f)

    cmd = [
        agy_bin,
        "-p",
        prompt,
        "--output-format",
        "json",
        "--json-schema",
        str(schema_path),
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
    ]
    if extra_dirs:
        for d in extra_dirs:
            cmd.extend(["--add-dir", str(d.resolve())])

    cwd = str(workspace_dir.resolve()) if workspace_dir else None

    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise AgyExecutionError(f"agy timed out after {timeout_sec}s") from exc

    if proc.returncode != 0 and not proc.stdout.strip():
        raise AgyExecutionError(
            f"agy exited with code {proc.returncode}.\nStderr: {proc.stderr.strip()}"
        )

    return parse_agy_json_envelope(proc.stdout, schema=schema)
