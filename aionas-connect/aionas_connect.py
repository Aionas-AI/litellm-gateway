#!/usr/bin/env python3
"""Enroll a personal provider key and connect supported coding clients to Aionas."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import platform
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable


SUPPORTED_CLIENTS = ("claude-code", "codex", "openclaw", "cursor")
KEYCHAIN_SERVICE = "io.aionas.litellm-gateway"


def config_root() -> Path:
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "aionas-connect"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "aionas-connect"


def bin_root() -> Path:
    return Path.home() / ".local" / "bin"


def atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def scan_clients(which: Callable[[str], str | None] = shutil.which) -> dict[str, dict[str, Any]]:
    cursor_paths = [
        Path("/Applications/Cursor.app"),
        Path.home() / "Applications" / "Cursor.app",
        Path.home() / ".local" / "share" / "applications" / "cursor.desktop",
    ]
    commands = {
        "claude-code": "claude",
        "codex": "codex",
        "openclaw": "openclaw",
        "cursor": "cursor",
    }
    result: dict[str, dict[str, Any]] = {}
    for client, command in commands.items():
        executable = which(command)
        installed = executable is not None
        if client == "cursor" and not installed:
            installed = any(path.exists() for path in cursor_paths)
        result[client] = {
            "installed": installed,
            "executable": executable,
            "automation": "guided" if client == "cursor" else "supported",
        }
    return result


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def request_json(url: str, method: str, payload: dict[str, Any] | None, token: str) -> dict[str, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        message = f"server returned HTTP {error.code}"
        try:
            parsed = json.loads(error.read().decode("utf-8"))
            if isinstance(parsed.get("error"), str):
                message = parsed["error"]
        except (ValueError, UnicodeDecodeError):
            pass
        raise RuntimeError(message) from error
    except urllib.error.URLError as error:
        raise RuntimeError("could not reach the Aionas control plane") from error


class SecretStore:
    def __init__(self, root: Path):
        self.root = root
        self.backend = self._select_backend()

    @staticmethod
    def _select_backend() -> str:
        if platform.system() == "Darwin" and shutil.which("security"):
            return "macos-keychain"
        if shutil.which("secret-tool"):
            return "secret-service"
        return "file"

    def put(self, account: str, secret: str) -> None:
        if self.backend == "macos-keychain":
            result = subprocess.run(
                ["security", "add-generic-password", "-U", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"],
                input=f"{secret}\n",
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode == 0:
                return
            self.backend = "file"
        elif self.backend == "secret-service":
            result = subprocess.run(
                ["secret-tool", "store", "--label", "Aionas LiteLLM key", "service", KEYCHAIN_SERVICE, "account", account],
                input=secret,
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode == 0:
                return
            self.backend = "file"

        secrets_file = self.root / "secrets.json"
        values = read_json(secrets_file, {})
        values[account] = secret
        atomic_write(secrets_file, json.dumps(values, indent=2) + "\n")

    def get(self, account: str) -> str:
        if self.backend == "macos-keychain":
            result = subprocess.run(
                ["security", "find-generic-password", "-w", "-a", account, "-s", KEYCHAIN_SERVICE],
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode == 0:
                return result.stdout.rstrip("\n")
        elif self.backend == "secret-service":
            result = subprocess.run(
                ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", account],
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode == 0:
                return result.stdout.rstrip("\n")
        values = read_json(self.root / "secrets.json", {})
        secret = values.get(account)
        if not isinstance(secret, str):
            raise RuntimeError(f"no stored key for {account}")
        return secret

    def helper(self, account: str) -> Path:
        helper = self.root / "helpers" / f"{account}.sh"
        if self.backend == "macos-keychain":
            command = ["/usr/bin/security", "find-generic-password", "-w", "-a", account, "-s", KEYCHAIN_SERVICE]
            body = "#!/bin/sh\nexec " + " ".join(shlex.quote(part) for part in command) + "\n"
        elif self.backend == "secret-service":
            command = ["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", account]
            body = "#!/bin/sh\nexec " + " ".join(shlex.quote(part) for part in command) + "\n"
        else:
            script = (
                "import json,sys; data=json.load(open(sys.argv[1], encoding='utf-8')); "
                "value=data.get(sys.argv[2]); "
                "sys.stdout.write(value if isinstance(value,str) else '')"
            )
            command = [sys.executable, "-c", script, str(self.root / "secrets.json"), account]
            body = "#!/bin/sh\nexec " + " ".join(shlex.quote(part) for part in command) + "\n"
        atomic_write(helper, body, 0o700)
        return helper


def device_id(root: Path) -> str:
    path = root / "device-id"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    value = secrets.token_hex(12)
    atomic_write(path, value + "\n")
    return value


def normalize_gateway_url(value: str) -> str:
    return value.rstrip("/")


def openai_base_url(gateway: str) -> str:
    gateway = normalize_gateway_url(gateway)
    return gateway if gateway.endswith("/v1") else f"{gateway}/v1"


def anthropic_base_url(gateway: str) -> str:
    gateway = normalize_gateway_url(gateway)
    return gateway[:-3] if gateway.endswith("/v1") else gateway


def configure_claude(root: Path, helper: Path, gateway: str, model: str) -> list[Path]:
    del root
    wrapper = bin_root() / "claude-aionas"
    body = "\n".join(
        [
            "#!/bin/sh",
            "set -eu",
            f"export ANTHROPIC_BASE_URL={shlex.quote(anthropic_base_url(gateway))}",
            f"export ANTHROPIC_MODEL={shlex.quote(model)}",
            f"export ANTHROPIC_AUTH_TOKEN=\"$({shlex.quote(str(helper))})\"",
            'exec claude "$@"',
            "",
        ]
    )
    atomic_write(wrapper, body, 0o700)
    return [wrapper]


def configure_codex(root: Path, helper: Path, gateway: str, model: str) -> list[Path]:
    codex_home = root / "codex-home"
    config = codex_home / "config.toml"
    content = "\n".join(
        [
            f'model = "{model}"',
            'model_provider = "aionas"',
            "",
            "[model_providers.aionas]",
            'name = "Aionas LiteLLM"',
            f'base_url = "{openai_base_url(gateway)}"',
            'wire_api = "responses"',
            "",
            "[model_providers.aionas.auth]",
            f"command = {json.dumps(str(helper))}",
            "args = []",
            "refresh_interval_ms = 0",
            "",
        ]
    )
    atomic_write(config, content)
    wrapper = bin_root() / "codex-aionas"
    body = "\n".join(
        [
            "#!/bin/sh",
            "set -eu",
            f"export CODEX_HOME={shlex.quote(str(codex_home))}",
            'exec codex "$@"',
            "",
        ]
    )
    atomic_write(wrapper, body, 0o700)
    return [config, wrapper]


def merge_openclaw_config(current: dict[str, Any], gateway: str, model: str) -> dict[str, Any]:
    models = current.setdefault("models", {})
    models["mode"] = "merge"
    providers = models.setdefault("providers", {})
    providers["litellm"] = {
        "baseUrl": openai_base_url(gateway),
        "apiKey": "${LITELLM_API_KEY}",
        "api": "openai-completions",
        "models": [
            {
                "id": model,
                "name": f"{model} (Aionas)",
                "reasoning": True,
                "input": ["text", "image"],
                "contextWindow": 200000,
                "maxTokens": 64000,
            }
        ],
    }
    agents = current.setdefault("agents", {})
    defaults = agents.setdefault("defaults", {})
    defaults["model"] = {"primary": f"litellm/{model}"}
    return current


def configure_openclaw(root: Path, helper: Path, gateway: str, model: str) -> tuple[list[Path], dict[str, str]]:
    config = Path.home() / ".openclaw" / "openclaw.json"
    backup = ""
    if config.exists():
        backup_path = root / "backups" / f"openclaw-{secrets.token_hex(5)}.json"
        backup_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(config, backup_path)
        backup = str(backup_path)
    current = read_json(config, {})
    atomic_write(config, json.dumps(merge_openclaw_config(current, gateway, model), indent=2) + "\n")
    wrapper = bin_root() / "openclaw-aionas"
    body = "\n".join(
        [
            "#!/bin/sh",
            "set -eu",
            f"export LITELLM_API_KEY=\"$({shlex.quote(str(helper))})\"",
            'exec openclaw "$@"',
            "",
        ]
    )
    atomic_write(wrapper, body, 0o700)
    return [config, wrapper], {str(config): backup}


def load_state(root: Path) -> dict[str, Any]:
    return read_json(root / "state.json", {"profiles": {}})


def save_state(root: Path, state: dict[str, Any]) -> None:
    atomic_write(root / "state.json", json.dumps(state, indent=2) + "\n")


def selected_clients(args: argparse.Namespace, scan: dict[str, dict[str, Any]]) -> list[str]:
    if args.clients:
        values = [value.strip() for value in args.clients.split(",") if value.strip()]
    else:
        defaults = [name for name, details in scan.items() if details["installed"]]
        if not sys.stdin.isatty():
            values = defaults
        else:
            entered = input(f"Clients [{','.join(defaults)}]: ").strip()
            values = [value.strip() for value in (entered.split(",") if entered else defaults)]
    unknown = sorted(set(values) - set(SUPPORTED_CLIENTS))
    if unknown:
        raise RuntimeError(f"unsupported clients: {', '.join(unknown)}")
    if not values:
        raise RuntimeError("no clients selected")
    return list(dict.fromkeys(values))


def secret_input(env_name: str, prompt: str, file_path: str | None = None) -> str:
    if file_path:
        return Path(file_path).read_text(encoding="utf-8").strip()
    value = os.environ.get(env_name)
    if value:
        return value
    if not sys.stdin.isatty():
        raise RuntimeError(f"set {env_name} or provide a token file in non-interactive mode")
    return getpass.getpass(prompt)


def command_scan(args: argparse.Namespace) -> int:
    detected = scan_clients()
    if args.json:
        print(json.dumps(detected, indent=2))
    else:
        for client, details in detected.items():
            status = "found" if details["installed"] else "not found"
            print(f"{client:12} {status:10} {details['automation']}")
    return 0


def command_plan(_args: argparse.Namespace) -> int:
    detected = scan_clients()
    actions = {
        "claude-code": "create claude-aionas wrapper (Anthropic Messages API)",
        "codex": "create isolated CODEX_HOME and codex-aionas wrapper (Responses API)",
        "openclaw": "backup and merge ~/.openclaw/openclaw.json",
        "cursor": "show guided OpenAI base URL setup; no private-settings edits",
    }
    for client, details in detected.items():
        marker = "✓" if details["installed"] else "-"
        print(f"{marker} {client}: {actions[client]}")
    print("No files or credentials were changed.")
    return 0


def command_setup(args: argparse.Namespace) -> int:
    root = config_root()
    detected = scan_clients()
    clients = selected_clients(args, detected)
    enrollment_token = secret_input("AIONAS_ENROLLMENT_TOKEN", "Enrollment token: ", args.token_file)
    provider_key = secret_input("AIONAS_PROVIDER_API_KEY", f"{args.provider} API key: ")
    payload = {
        "credentialId": args.credential_id,
        "provider": args.provider,
        "model": args.model,
        "modelAlias": args.model_alias,
        "apiKey": provider_key,
        "deviceId": device_id(root),
        "clients": [
            {
                "clientId": client,
                "duration": args.duration,
                **({"maxBudget": args.max_budget} if args.max_budget is not None else {}),
            }
            for client in clients
        ],
    }
    response = request_json(
        f"{args.control_plane.rstrip('/')}/enrollments",
        "POST",
        payload,
        enrollment_token,
    )
    gateway = str(response["gatewayBaseUrl"])
    model = str(response["modelAlias"])
    profile = args.profile
    store = SecretStore(root)
    generated: list[str] = []
    backups: dict[str, str] = {}

    by_client = {item["clientId"]: item for item in response.get("clients", [])}
    for client in clients:
        item = by_client.get(client)
        if not isinstance(item, dict) or not isinstance(item.get("virtualKey"), str):
            raise RuntimeError(f"server did not return a key for {client}")
        account = f"{profile}:{client}"
        store.put(account, item["virtualKey"])
        helper = store.helper(account)
        generated.append(str(helper))
        if client == "claude-code":
            generated.extend(str(path) for path in configure_claude(root, helper, gateway, model))
        elif client == "codex":
            generated.extend(str(path) for path in configure_codex(root, helper, gateway, model))
        elif client == "openclaw":
            paths, client_backups = configure_openclaw(root, helper, gateway, model)
            generated.extend(str(path) for path in paths)
            backups.update(client_backups)
        else:
            print(f"Cursor: set OpenAI Base URL to {openai_base_url(gateway)} and reveal the stored key with {helper}")

    state = load_state(root)
    state.setdefault("profiles", {})[profile] = {
        "gateway": gateway,
        "model": model,
        "clients": clients,
        "secretBackend": store.backend,
        "generated": generated,
        "backups": backups,
    }
    save_state(root, state)
    print(f"Configured profile '{profile}' for: {', '.join(clients)}")
    print(f"Model: {model}")
    print("Launch wrappers from ~/.local/bin (for example: claude-aionas or codex-aionas).")
    return 0


def command_verify(args: argparse.Namespace) -> int:
    root = config_root()
    state = load_state(root)
    profile = state.get("profiles", {}).get(args.profile)
    if not isinstance(profile, dict):
        raise RuntimeError(f"unknown profile: {args.profile}")
    store = SecretStore(root)
    failures = 0
    for client in profile.get("clients", []):
        key = store.get(f"{args.profile}:{client}")
        try:
            request_json(f"{openai_base_url(profile['gateway'])}/models", "GET", None, key)
            print(f"✓ {client}: gateway authentication succeeded")
        except RuntimeError as error:
            failures += 1
            print(f"✗ {client}: {error}", file=sys.stderr)
    return 1 if failures else 0


def command_undo(args: argparse.Namespace) -> int:
    root = config_root()
    state = load_state(root)
    profile = state.get("profiles", {}).get(args.profile)
    if not isinstance(profile, dict):
        raise RuntimeError(f"unknown profile: {args.profile}")
    backups = profile.get("backups", {})
    for target, backup in backups.items():
        target_path = Path(target)
        if backup:
            shutil.copy2(backup, target_path)
        elif target_path.exists():
            target_path.unlink()
    backup_targets = set(backups)
    for value in profile.get("generated", []):
        path = Path(value)
        if str(path) not in backup_targets and path.exists() and path.is_file():
            path.unlink()
    del state["profiles"][args.profile]
    save_state(root, state)
    print("Local configuration restored. Server-side virtual keys were not revoked.")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(prog="aionas-connect")
    subparsers = result.add_subparsers(dest="command", required=True)

    scan = subparsers.add_parser("scan", help="detect supported clients without changing anything")
    scan.add_argument("--json", action="store_true")
    scan.set_defaults(handler=command_scan)

    plan = subparsers.add_parser("plan", help="show the proposed client changes")
    plan.set_defaults(handler=command_plan)

    setup = subparsers.add_parser("setup", help="enroll a provider key and configure selected clients")
    setup.add_argument("--control-plane", required=True, help="for example https://keys.example.com/api")
    setup.add_argument("--token-file", help="read the short-lived enrollment token from a 0600 file")
    setup.add_argument("--provider", required=True)
    setup.add_argument("--model", required=True)
    setup.add_argument("--model-alias", required=True)
    setup.add_argument("--credential-id", default="personal")
    setup.add_argument("--profile", default="default")
    setup.add_argument("--clients", help="comma-separated; defaults to detected clients")
    setup.add_argument("--duration", default="90d")
    setup.add_argument("--max-budget", type=float)
    setup.set_defaults(handler=command_setup)

    verify = subparsers.add_parser("verify", help="verify gateway auth without spending tokens")
    verify.add_argument("--profile", default="default")
    verify.set_defaults(handler=command_verify)

    undo = subparsers.add_parser("undo", help="restore local client configuration")
    undo.add_argument("--profile", default="default")
    undo.set_defaults(handler=command_undo)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except (KeyError, OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"aionas-connect: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
