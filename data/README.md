# Iris Core Data Configuration

## models.json

Copy `models.json.template` to `models.json` and replace placeholders:

1. Replace `<your-account>` with your Azure Cognitive Services account name
2. Update `apiKey` field to match your Key Vault secret name
3. Add or remove models based on your deployments

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

The `apiKey` field should match a secret name in your Azure Key Vault.

## Other Data Files

- `MEMORY.md` - Iris's global memory (she can append to this)
- `CONSTITUTION.md` - Immutable operator rules
- `sessions/` - Session state (gitignored)
- `events/` - Event logs (gitignored)
