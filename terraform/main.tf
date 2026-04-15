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
