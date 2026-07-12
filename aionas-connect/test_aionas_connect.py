import json
import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from unittest.mock import patch

import aionas_connect


class AionasConnectTests(unittest.TestCase):
    def test_scan_is_read_only_and_marks_cursor_guided(self):
        found = aionas_connect.scan_clients(lambda command: f"/bin/{command}" if command != "cursor" else None)
        self.assertTrue(found["claude-code"]["installed"])
        self.assertEqual(found["cursor"]["automation"], "guided")

    def test_gateway_url_shapes(self):
        self.assertEqual(aionas_connect.openai_base_url("https://gateway.example"), "https://gateway.example/v1")
        self.assertEqual(aionas_connect.openai_base_url("https://gateway.example/v1"), "https://gateway.example/v1")
        self.assertEqual(aionas_connect.anthropic_base_url("https://gateway.example/v1"), "https://gateway.example")

    def test_openclaw_merge_preserves_unrelated_configuration(self):
        current = {"unrelated": {"keep": True}, "models": {"providers": {"other": {"x": 1}}}}
        merged = aionas_connect.merge_openclaw_config(current, "https://gateway.example", "claude-opus")
        self.assertTrue(merged["unrelated"]["keep"])
        self.assertIn("other", merged["models"]["providers"])
        self.assertEqual(merged["models"]["mode"], "merge")
        self.assertEqual(merged["models"]["providers"]["litellm"]["api"], "openai-completions")
        self.assertEqual(merged["agents"]["defaults"]["model"]["primary"], "litellm/claude-opus")

    def test_file_secret_store_uses_0600_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(aionas_connect.platform, "system", return_value="Other"), patch.object(
                aionas_connect.shutil, "which", return_value=None
            ):
                store = aionas_connect.SecretStore(root)
                store.put("profile:codex", "sk-test-secret")
                self.assertEqual(store.get("profile:codex"), "sk-test-secret")
                self.assertEqual(os.stat(root / "secrets.json").st_mode & 0o777, 0o600)

    def test_atomic_write_replaces_content_and_sets_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "state.json"
            aionas_connect.atomic_write(target, json.dumps({"ok": True}))
            self.assertEqual(json.loads(target.read_text()), {"ok": True})
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)

    def test_claude_wrapper_reads_key_at_launch_without_embedding_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = root / "helper with spaces.sh"
            with patch.object(aionas_connect, "bin_root", return_value=root / "bin"):
                [wrapper] = aionas_connect.configure_claude(
                    root,
                    helper,
                    "https://gateway.example/v1",
                    "opus-alias",
                )
            content = wrapper.read_text()
            self.assertIn('ANTHROPIC_AUTH_TOKEN="$(\'{}\')"'.format(helper), content)
            self.assertIn("ANTHROPIC_BASE_URL=https://gateway.example", content)
            self.assertNotIn("sk-", content)
            self.assertEqual(os.stat(wrapper).st_mode & 0o777, 0o700)

    def test_codex_uses_command_backed_auth_without_exporting_the_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            helper = root / "helpers" / "default:codex.sh"
            with patch.object(aionas_connect, "bin_root", return_value=root / "bin"):
                config, wrapper = aionas_connect.configure_codex(
                    root,
                    helper,
                    "https://gateway.example",
                    "opus-alias",
                )
            content = config.read_text()
            parsed = tomllib.loads(content)
            self.assertIn("[model_providers.aionas.auth]", content)
            self.assertIn(f"command = {json.dumps(str(helper))}", content)
            self.assertIn('wire_api = "responses"', content)
            self.assertNotIn("env_key", content)
            self.assertNotIn("AIONAS_LITELLM_API_KEY", wrapper.read_text())
            self.assertEqual(parsed["model_providers"]["aionas"]["auth"]["command"], str(helper))


if __name__ == "__main__":
    unittest.main()
