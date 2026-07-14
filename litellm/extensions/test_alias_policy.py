import unittest

from alias_policy import AliasAuthorizationError, validate_managed_alias_access


def managed_key():
    return {
        "models": ["claude-opus", "aionas-byok-123"],
        "aliases": {"claude-opus": "aionas-byok-123"},
        "metadata": {
            "aionas_managed": True,
            "aionas_model_alias": "claude-opus",
            "aionas_internal_model": "aionas-byok-123",
        },
    }


class AliasPolicyTests(unittest.TestCase):
    def test_allows_expected_resolved_target(self):
        validate_managed_alias_access(managed_key(), {"model": "aionas-byok-123"})

    def test_rejects_cross_tenant_target(self):
        with self.assertRaises(AliasAuthorizationError):
            validate_managed_alias_access(managed_key(), {"model": "aionas-byok-other-tenant"})

    def test_rejects_alias_target_missing_from_allowlist(self):
        key = managed_key()
        key["models"] = ["claude-opus"]
        with self.assertRaises(AliasAuthorizationError):
            validate_managed_alias_access(key, {"model": "aionas-byok-123"})

    def test_rejects_modified_alias_mapping(self):
        key = managed_key()
        key["aliases"] = {"claude-opus": "aionas-byok-other-tenant"}
        with self.assertRaises(AliasAuthorizationError):
            validate_managed_alias_access(key, {"model": "aionas-byok-other-tenant"})

    def test_ignores_unmanaged_keys(self):
        validate_managed_alias_access({"models": []}, {"model": "anything"})


if __name__ == "__main__":
    unittest.main()
