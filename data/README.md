# Iris Core Data Configuration

## models.json

`models.json` registers **custom LLM providers** — OpenAI-compatible endpoints
(Azure AI Foundry, self-hosted gateways) or AWS Bedrock. You only need it when
going beyond the built-in providers: with a plain Anthropic or OpenAI key, just
set `IRIS_PROVIDER` / `IRIS_MODEL` in `/iris/.env` and skip this file entirely
(see [Configuration](../docs/configuration.md)).

To use it, copy `models.json.template` to `models.json` and adapt:

1. Set `baseUrl` to your endpoint (e.g. replace `<your-account>` for Azure AI
   Foundry, `<your-region>` for Bedrock)
2. Set `apiKey` to the **name** of the secret holding the key — resolved via the
   `get-secret` skill from `/iris/.env` (default) or Azure Key Vault (Key Vault
   profile). The key itself never goes in this file.
3. Add or remove models to match your deployments

Example:
```json
{
  "providers": {
    "foundry-e2": {
      "baseUrl": "https://my-ai-account.cognitiveservices.azure.com/openai/v1",
      "api": "openai-completions",
      "apiKey": "FOUNDRY_E2_KEY",
      ...
    }
  }
}
```

Here `FOUNDRY_E2_KEY` is looked up as `FOUNDRY_E2_KEY=...` in `/iris/.env`, or as
a Key Vault secret of the same name when `IRIS_KEY_VAULT` is set.

## Other Data Files

- `MEMORY.md` - Iris's global memory (she can append to this)
- `CONSTITUTION.md` - Immutable operator rules
- `sessions/` - Session state (gitignored)
- `events/` - Event logs (gitignored)
