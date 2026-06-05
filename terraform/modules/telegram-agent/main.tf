# ============================================================
# Telegram Agent Module
# Provisions a single iris-runtime Docker container for an
# agent spawned via Telegram. Unlike the generic agent module:
#
#   - Workspace is ID-based (/iris/data/agents/{agent_id})
#     so user-chosen names can't collide across ownership transfers.
#   - Skills are mounted from the global skills directory
#     (/iris/data/skills, read-only) — not per-agent git paths.
#   - A named log volume (iris-agent-{agent_id}-logs) is
#     mounted at /var/log/agent so logs survive container crashes.
#   - AGENT_ID env var is injected for guard dog validation.
# ============================================================

locals {
  container_name = "iris-tg-${var.agent_id}"
  image_tag      = "iris-runtime:local"
  workspace_dir  = "${var.iris_dir}/data/agents/${var.agent_id}"
  log_volume     = "iris-agent-${var.agent_id}-logs"
}

# ─────────────────────────────────────────────
# Ensure iris-runtime image exists
# ─────────────────────────────────────────────
resource "null_resource" "build_image" {
  triggers = {
    package_json = filemd5("${var.iris_repo_dir}/iris-runtime/package.json")
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      cd ${var.iris_repo_dir}/iris-runtime
      npm run build
      docker build -t ${local.image_tag} .
    SHELL
  }
}

# ─────────────────────────────────────────────
# Workspace directory (ID-based, not name-based)
# ─────────────────────────────────────────────
resource "null_resource" "agent_workspace" {
  triggers = {
    agent_id = var.agent_id
  }

  provisioner "local-exec" {
    command = "mkdir -p ${local.workspace_dir}/events"
  }
}

# ─────────────────────────────────────────────
# Named log volume
# ─────────────────────────────────────────────
resource "null_resource" "log_volume" {
  triggers = {
    agent_id = var.agent_id
  }

  provisioner "local-exec" {
    command = "docker volume create ${local.log_volume} 2>/dev/null || true"
  }
}

# ─────────────────────────────────────────────
# Agent container
# ─────────────────────────────────────────────
resource "null_resource" "agent_container" {
  depends_on = [
    null_resource.build_image,
    null_resource.agent_workspace,
    null_resource.log_volume,
  ]

  triggers = {
    agent_id   = var.agent_id
    agent_name = var.agent_name
    image_tag  = local.image_tag
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      docker rm -f ${local.container_name} 2>/dev/null || true
      docker run -d \
        --name ${local.container_name} \
        --restart unless-stopped \
        --network iris-internal \
        --add-host=iris-host:host-gateway \
        --env-file ${var.iris_dir}/.env \
        -e IRIS_ENV=prod \
        -e AGENT_NAME=${var.agent_name} \
        -e AGENT_ID=${var.agent_id} \
        -e IRIS_API_URL=${var.iris_api_url} \
        ${var.key_vault_name != "" ? "-e IRIS_KEY_VAULT=${var.key_vault_name}" : ""} \
        -e IRIS_EVENTS_DIR=/iris/data/events \
        -v ${local.workspace_dir}:/workspace \
        -v /iris/data/skills:/workspace/skills:ro \
        -v ${local.log_volume}:/var/log/agent \
        -v ${var.iris_dir}/data/events:/iris/data/events \
        -v ${var.iris_dir}/data/models.json:/workspace/models.json:ro \
        -v ${var.iris_home}/.azure:/root/.azure \
        ${local.image_tag} \
        --sandbox=host /workspace
    SHELL
  }

  provisioner "local-exec" {
    when    = destroy
    command = <<-SHELL
      docker rm -f iris-tg-${self.triggers.agent_id} 2>/dev/null || true
    SHELL
  }
}

# ─────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────
output "container_name" {
  value = local.container_name
}

output "workspace_dir" {
  value = local.workspace_dir
}

output "log_volume" {
  value = local.log_volume
}
