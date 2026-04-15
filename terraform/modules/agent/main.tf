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
# Build iris-runtime Docker image from source
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
# Directory structure
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
  depends_on = [null_resource.build_image, null_resource.agent_dirs]

  triggers = {
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
        -e IRIS_KEY_VAULT=${var.key_vault_name} \
        -e IRIS_API_URL=${var.iris_api_url} \
        ${var.slack_app_token != "" ? "-e IRIS_SLACK_APP_TOKEN=${var.slack_app_token}" : ""} \
        ${var.slack_bot_token != "" ? "-e IRIS_SLACK_BOT_TOKEN=${var.slack_bot_token}" : ""} \
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
