# ============================================================
# Sub-Agent Container Definitions
# ============================================================
# Each agent gets two containers: preview and prod
# Preview is for testing skills before promotion to prod
# ============================================================

# Key Vault data source — read agent Slack tokens at apply time
data "azurerm_key_vault" "iris" {
  name                = "iris-core-kv-51560915"
  resource_group_name = "iris-core-rg"
}

data "azurerm_key_vault_secret" "cricket_slack_app_token" {
  name         = "CRICKET-SCORES-SLACK-APP-TOKEN"
  key_vault_id = data.azurerm_key_vault.iris.id
}

data "azurerm_key_vault_secret" "cricket_slack_bot_token" {
  name         = "CRICKET-SCORES-SLACK-BOT-TOKEN"
  key_vault_id = data.azurerm_key_vault.iris.id
}

data "azurerm_key_vault_secret" "cricapi_key" {
  name         = "CRICAPI-KEY"
  key_vault_id = data.azurerm_key_vault.iris.id
}

module "cricket_scores_agent" {
  source = "./modules/agent"

  agent_name    = "cricket-scores"
  iris_repo_dir = "/iris/repo"
  key_vault_name = "iris-core-kv-51560915"
  iris_api_url   = "http://172.18.0.1:3000"
  slack_app_token = data.azurerm_key_vault_secret.cricket_slack_app_token.value
  slack_bot_token = data.azurerm_key_vault_secret.cricket_slack_bot_token.value
  bridge_port     = 4100
}

# ─────────────────────────────────────────────
# Cricket Scores WebUI
# Standalone web interface on port 8080
# ─────────────────────────────────────────────
module "cricket_scores_webui" {
  source = "./modules/cricket-webui"

  iris_repo_dir = "/iris/repo"
  webui_port    = 8080
  cricapi_key   = data.azurerm_key_vault_secret.cricapi_key.value
}

# ─────────────────────────────────────────────
# AMJ — Abhishek Mukherjee Jokes Agent
# Bridge-only mode (no Slack)
# ─────────────────────────────────────────────
module "amj_agent" {
  source = "./modules/agent"

  agent_name    = "amj"
  iris_repo_dir = "/iris/repo"
  key_vault_name = "iris-core-kv-51560915"
  iris_api_url   = "http://172.18.0.1:3000"
  # No Slack tokens — bridge-only mode
  slack_app_token = ""
  slack_bot_token = ""
  bridge_port     = 4200
}
