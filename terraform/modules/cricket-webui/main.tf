# ============================================================
# Cricket Scores WebUI Module
# Deploys a standalone web container for cricket scores
# Exposed on host port 8080 (configurable)
# ============================================================

locals {
  container_name = "cricket-webui"
  image_tag      = "cricket-webui:local"
  agent_webui_dir = "${var.iris_repo_dir}/agents/cricket-scores/webui"
}

# ─────────────────────────────────────────────
# Build webui Docker image from source
# ─────────────────────────────────────────────
resource "null_resource" "build_webui" {
  triggers = {
    dockerfile_hash = filemd5("${local.agent_webui_dir}/Dockerfile")
    server_hash     = filemd5("${local.agent_webui_dir}/server.js")
    html_hash       = filemd5("${local.agent_webui_dir}/public/index.html")
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      cd ${local.agent_webui_dir}
      docker build -t ${local.image_tag} .
    SHELL
  }
}

# ─────────────────────────────────────────────
# WebUI container
# ─────────────────────────────────────────────
resource "null_resource" "webui_container" {
  depends_on = [null_resource.build_webui]

  triggers = {
    container_name = local.container_name
    image_tag      = local.image_tag
    port           = var.webui_port
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      docker rm -f ${self.triggers.container_name} 2>/dev/null || true
      docker run -d \
        --name ${self.triggers.container_name} \
        --restart unless-stopped \
        --network iris-internal \
        -p ${self.triggers.port}:3000 \
        -e CRICAPI_KEY=${var.cricapi_key} \
        -e PORT=3000 \
        -v ${local.agent_webui_dir}/public:/app/public \
        ${self.triggers.image_tag}
    SHELL
  }

  provisioner "local-exec" {
    when    = destroy
    command = "docker rm -f ${self.triggers.container_name} 2>/dev/null || true"
  }
}
