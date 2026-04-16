# ============================================================
# Sub-Agent Container Definitions
# ============================================================
# Define your agents here. Each agent gets its own Docker
# container running iris-runtime in bridge-only mode.
#
# Example: add a "my-agent" agent
#
# module "my_agent" {
#   source = "./modules/agent"
#
#   agent_name     = "my-agent"
#   key_vault_name = var.key_vault_name
#   iris_api_url   = "http://172.18.0.1:3000"
#   bridge_port    = 4100
#
#   # Optional: agent-specific Slack tokens
#   # slack_app_token = "xapp-..."
#   # slack_bot_token = "xoxb-..."
# }
# ============================================================
