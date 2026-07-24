# ============================================================
# Iris Dynamic Infrastructure
#
# This workspace is for resources Iris provisions on demand:
# sub-agent VMs, storage accounts, DNS records, blobs, etc.
#
# The Iris bootstrap VM itself is NOT managed here — it is
# provisioned once via bootstrap.sh and is intentionally
# outside this state so Iris cannot accidentally destroy her
# own host.
#
# To add a resource: write the .tf file, commit via the
# github skill, then run the terraform skill to plan + apply.
# ============================================================

data "azurerm_client_config" "current" {}

# Resource group for all Iris-provisioned dynamic resources
resource "azurerm_resource_group" "iris_dynamic" {
  name     = var.resource_group_name
  location = var.location
  tags     = var.tags
}

# ─────────────────────────────────────────────
# Shared iris-runtime Docker image (docker-mode agents only)
#
# Gated by var.enable_docker_agents (default false) so an install that only
# ever uses the default service-mode agents — no Terraform, no Docker — never
# triggers an image build just because `terraform apply` ran for an unrelated
# resource. Flip it to true (and uncomment your first docker-mode module in
# agents.tf) the first time spawn-agent --mode=docker is actually used.
#
# Built ONCE here, not per-agent-module. Every module.<name>_agent instance
# depends_on this resource's id instead of running its own `npm run build &&
# docker build` — previously each agent was a brand-new Terraform resource
# address, so Terraform had never seen it and re-ran the full build on every
# single new agent even though the resulting "iris-runtime:local" tag is
# identical across all of them. Hoisting it here means only the very first
# docker-mode agent pays the build; every one after that sees this resource
# unchanged (same package.json hash) and skips straight to `docker run`.
# ─────────────────────────────────────────────
resource "null_resource" "iris_runtime_image" {
  count = var.enable_docker_agents ? 1 : 0

  triggers = {
    package_json = filemd5("${var.iris_repo_dir}/iris-runtime/package.json")
  }

  provisioner "local-exec" {
    command = <<-SHELL
      set -e
      cd ${var.iris_repo_dir}/iris-runtime
      npm run build
      docker build -t iris-runtime:local .
    SHELL
  }
}
