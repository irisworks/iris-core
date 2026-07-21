# Iris Core Data Configuration

## models.json

`models.json` registers **custom LLM providers** — OpenAI-compatible endpoints
(Azure AI Foundry, DeepSeek, Mistral, self-hosted gateways), or AWS Bedrock.
Mistral goes through the OpenAI-compatible path, not `pi-ai`'s native `mistral`
provider module, which hangs indefinitely on every call — see
`iris-runtime/CHANGELOG.md`. You only need this file when going beyond the
built-in providers: with a plain
Anthropic or OpenAI key, just set `IRIS_PROVIDER` / `IRIS_MODEL` in `/iris/.env`
and skip this file entirely (see [Configuration](../docs/configuration.md)).

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
    "azure-foundry": {
      "baseUrl": "https://my-ai-account.cognitiveservices.azure.com/openai/v1",
      "api": "openai-completions",
      "apiKey": "AZURE_FOUNDRY_KEY",
      ...
    }
  }
}
```

Here `AZURE_FOUNDRY_KEY` is looked up as `AZURE_FOUNDRY_KEY=...` in `/iris/.env`,
or as a Key Vault secret of the same name when `IRIS_KEY_VAULT` is set. The
template also ships ready-to-use `deepseek` and `mistral` provider blocks
(`DEEPSEEK_API_KEY` / `MISTRAL_API_KEY`).

> Note: `azure-foundry` was named `foundry-e2` before it supported providers
> beyond Azure's `eastus2` deployment — bootstrap.sh migrates old `.env`/Key
> Vault entries automatically, but hand-edited `models.json` files on existing
> installs need the provider key renamed manually.

## Other Data Files

- `MEMORY.md` - Iris's global memory (she can append to this)
- `CONSTITUTION.md` - Immutable operator rules
- `sessions/` - Session state (gitignored)
- `events/` - Event logs (gitignored)
