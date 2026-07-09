"""Minimal POC client that calls Claude Opus through the LiteLLM gateway.

All traffic flows: client -> LiteLLM gateway -> Bedrock (Opus) -> gateway -> client.
The gateway is OpenAI-compatible, so we use the standard `openai` SDK and only
change the base URL and API key.
"""

import os
import sys

from openai import OpenAI

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass


def main() -> None:
    base_url = os.environ.get("LITELLM_BASE_URL")
    api_key = os.environ.get("LITELLM_API_KEY")
    if not base_url or not api_key:
        sys.exit("Set LITELLM_BASE_URL and LITELLM_API_KEY (see .env.example).")

    model = os.environ.get("LITELLM_MODEL", "claude-opus")
    client = OpenAI(base_url=base_url, api_key=api_key)

    # Prompt from CLI args, or a default demo prompt.
    prompt = " ".join(sys.argv[1:]) or "Explain what an AI gateway is in two sentences."

    resp = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": prompt}],
    )
    print(resp.choices[0].message.content)
    if resp.usage:
        print(
            f"\n[model={resp.model} "
            f"tokens: prompt={resp.usage.prompt_tokens} "
            f"completion={resp.usage.completion_tokens}]",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
