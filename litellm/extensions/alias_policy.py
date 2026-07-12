"""Pure authorization policy for Aionas-managed virtual-key aliases."""

from __future__ import annotations

from typing import Any


class AliasAuthorizationError(ValueError):
    """Raised when an Aionas-managed key violates its immutable alias contract."""


def _value(source: Any, name: str, default: Any = None) -> Any:
    if isinstance(source, dict):
        return source.get(name, default)
    return getattr(source, name, default)


def validate_managed_alias_access(user_api_key: Any, data: dict[str, Any]) -> None:
    """Fail closed after LiteLLM resolves a managed key's model alias."""

    metadata = _value(user_api_key, "metadata", {}) or {}
    if not isinstance(metadata, dict) or metadata.get("aionas_managed") is not True:
        return

    models = _value(user_api_key, "models", []) or []
    aliases = _value(user_api_key, "aliases", {}) or {}
    expected_alias = metadata.get("aionas_model_alias")
    expected_target = metadata.get("aionas_internal_model")
    resolved_model = data.get("model")

    if not isinstance(models, list) or not models:
        raise AliasAuthorizationError("Aionas-managed keys require a non-empty model allowlist")
    if not isinstance(expected_alias, str) or not isinstance(expected_target, str):
        raise AliasAuthorizationError("Aionas-managed key metadata is incomplete")
    if not isinstance(aliases, dict) or aliases.get(expected_alias) != expected_target:
        raise AliasAuthorizationError("Aionas-managed key alias mapping was modified")
    if expected_alias not in models or expected_target not in models:
        raise AliasAuthorizationError("Alias and resolved target must both be explicitly allowed")
    if resolved_model != expected_target:
        raise AliasAuthorizationError("Resolved model is outside the key's managed deployment")
