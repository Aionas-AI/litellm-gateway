"""LiteLLM pre-call hook that closes key-alias authorization gaps."""

from __future__ import annotations

from typing import Any, Optional, Union

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger

from aionas_extensions.alias_policy import AliasAuthorizationError, validate_managed_alias_access


class AionasAliasAuthorizationGuard(CustomLogger):
    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict[str, Any],
        call_type: str,
    ) -> Optional[Union[Exception, str, dict[str, Any]]]:
        del cache, call_type
        try:
            validate_managed_alias_access(user_api_key_dict, data)
        except AliasAuthorizationError as exc:
            raise HTTPException(status_code=403, detail={"error": str(exc)}) from exc
        return data


alias_authorization_guard = AionasAliasAuthorizationGuard()
