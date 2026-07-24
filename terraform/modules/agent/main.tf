# ============================================================
# Sub-Agent Module
# Provisions a single iris-runtime Docker container per agent.
# (Preview/prod split can be re-introduced later when needed.)
# ============================================================

locals {
  agent_dir    = "${var.iris_dir}/agents/${var.agent_name}"
  container_name = "iris-${var.agent_name}"
  image_tag    = "iris-runtime:local"
}

# ─────────────────────────────────────────────
# Per-agent API token (opt-in via unique_api_token)
# Unique per container so the secrets allow-list in agents.json can derive
# caller identity from which token authenticated, instead of trusting the
# self-reported X-Iris-Caller header (IRIS-120). Overrides the shared
# IRIS_API_TOKEN from .env for this container only — add the same value to
# this agent's entry in agents.json (`token` field) so Iris's API recognizes
# it. Opt-in because until that registration happens, this agent's API calls
# (escalate, get-secret) are 401 — enable it agent-by-agent, copying the
# token into agents.json as part of the same change.
# ─────────────────────────────────────────────
resource "random_password" "api_token" {
  count   = var.unique_api_token ? 1 : 0
  length  = 32
  special = false
}

# ─────────────────────────────────────────────
# Directory structure
#
# The iris-runtime:local image itself is built once, shared across every
# agent module instance, by the top-level null_resource.iris_runtime_image in
# terraform/main.tf — pass its id in as var.image_dependency so this module
# depends on it without owning its own (redundant) build step.
# ─────────────────────────────────────────────
resource "null_resource" "agent_dirs" {
  triggers = {
    agent_name = var.agent_name
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      mkdir -p ${local.agent_dir}/data/events

      ln -sfn ${var.iris_repo_dir}/agents/${var.agent_name}/MEMORY.md \
        ${local.agent_dir}/data/MEMORY.md
      ln -sfn ${var.iris_repo_dir}/agents/${var.agent_name}/skills \
        ${local.agent_dir}/data/skills
    SHELL
  }
}

# ─────────────────────────────────────────────
# Agent container
# ─────────────────────────────────────────────
resource "null_resource" "agent" {
  depends_on = [null_resource.agent_dirs]

  lifecycle {
    precondition {
      condition     = var.secrets_mode == "env" || var.unique_api_token
      error_message = "secrets_mode store/proxy requires unique_api_token = true — the per-agent token is how the parent API enforces the agent's secrets allow-list (agents.json)."
    }
  }

  triggers = {
    agent_name = var.agent_name
    image_tag  = local.image_tag
    api_token  = var.unique_api_token ? random_password.api_token[0].result : ""
    # References the shared build's id (not a resource reference, so not a
    # valid depends_on target) — including it here gives Terraform an
    # implicit data dependency: this container is only (re)created after
    # null_resource.iris_runtime_image in terraform/main.tf has run.
    image_ready = var.image_dependency
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      # IRIS_SLACK_APP_TOKEN / IRIS_SLACK_BOT_TOKEN / TELEGRAM_BOT_TOKEN below are
      # always passed explicitly, even empty. --env-file (secrets_mode == "env")
      # injects Iris's own copies of all three from /iris/.env into every
      # container regardless of this module's variables; explicit -e flags are
      # applied after --env-file, so an empty value here overrides and clears
      # them unless this agent was given its own distinct value. Never set
      # var.slack_app_token/slack_bot_token/telegram_bot_token to Iris's real
      # tokens — mint a separate Slack app / Telegram bot per agent, or two
      # processes end up authenticating with the same bot credentials
      # (duplicate Socket Mode connections / Telegram getUpdates 409 conflicts,
      # agent intermittently not responding).
      #
      # Caveat on Key-Vault-profile installs: iris-runtime resolves these three
      # via getSecretProvider().get("IRIS-SLACK-APP-TOKEN" etc.), which — in
      # secrets_mode "env" (this module's default) — falls back to `az keyvault
      # secret show` whenever IRIS_KEY_VAULT is set and the env var is empty
      # (engine/secrets.ts's envSecretProvider). Clearing the env var here is
      # NOT sufficient if var.key_vault_name points at the same vault Iris's
      # own tokens are stored in under those exact names — the agent can still
      # resolve them via Key Vault. For installs where that isolation matters,
      # use secrets_mode = "store" or "proxy" with unique_api_token = true
      # instead, which requires this agent's `secrets` allow-list in
      # agents.json to explicitly name anything it may read (see docs/secrets.md).
      docker rm -f ${local.container_name} 2>/dev/null || true
      docker run -d \
        --name ${local.container_name} \
        --restart unless-stopped \
        --network iris-internal \
        --add-host=iris-host:host-gateway \
        ${var.secrets_mode == "env" ? "--env-file ${var.iris_dir}/.env" : ""} \
        ${var.secrets_mode == "env" && fileexists("${var.iris_dir}/.secrets.env") ? "--env-file ${var.iris_dir}/.secrets.env" : ""} \
        ${var.secrets_mode != "env" ? "-e IRIS_SECRET_BROKER_URL=${var.iris_api_url} -e IRIS_SECRET_BROKER_TOKEN=${var.unique_api_token ? random_password.api_token[0].result : ""}" : ""} \
        ${var.iris_provider != "" ? "-e IRIS_PROVIDER=${var.iris_provider}" : ""} \
        ${var.iris_model != "" ? "-e IRIS_MODEL=${var.iris_model}" : ""} \
        -e IRIS_ENV=prod \
        -e AGENT_NAME=${var.agent_name} \
        -e IRIS_KEY_VAULT=${var.key_vault_name} \
        -e IRIS_API_URL=${var.iris_api_url} \
        ${var.unique_api_token ? "-e IRIS_API_TOKEN=${random_password.api_token[0].result}" : ""} \
        -e IRIS_SLACK_APP_TOKEN=${var.slack_app_token} \
        -e IRIS_SLACK_BOT_TOKEN=${var.slack_bot_token} \
        -e TELEGRAM_BOT_TOKEN=${var.telegram_bot_token} \
        ${var.bridge_port > 0 ? "-e IRIS_BRIDGE_PORT=${var.bridge_port} -p 127.0.0.1:${var.bridge_port}:${var.bridge_port}" : ""} \
        -e IRIS_EVENTS_DIR=/iris/data/events \
        -v ${local.agent_dir}/data:/workspace \
        -v ${var.iris_repo_dir}/agents/${var.agent_name}/skills:/workspace/skills:ro \
        -v ${var.iris_dir}/data/models.json:/workspace/models.json:ro \
        -v ${var.iris_dir}/data/events:/iris/data/events \
        -v ${var.iris_home}/.azure:/root/.azure \
        ${local.image_tag} \
        --sandbox=host /workspace
    SHELL
  }

  provisioner "local-exec" {
    when    = destroy
    command = <<-SHELL
      docker rm -f iris-${self.triggers.agent_name} 2>/dev/null || true
      docker rm -f iris-${self.triggers.agent_name}-prod 2>/dev/null || true
      docker rm -f iris-${self.triggers.agent_name}-preview 2>/dev/null || true
    SHELL
  }
}
