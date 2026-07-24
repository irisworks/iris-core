variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
  validation {
    condition     = length(var.subscription_id) > 0
    error_message = "Azure subscription ID must be provided via AZURE_SUBSCRIPTION_ID or TF_VAR_subscription_id"
  }
}

variable "location" {
  description = "Azure region for dynamic resources"
  type        = string
  default     = "eastus"
}

variable "resource_group_name" {
  description = "Resource group for Iris-provisioned dynamic resources"
  type        = string
  default     = "iris-dynamic-rg"
}

variable "key_vault_name" {
  description = "Azure Key Vault name (passed to sub-agent containers as IRIS_KEY_VAULT)"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
  default     = {}
}

variable "iris_repo_dir" {
  description = "Path to the iris-core repo checkout on the VM (used to build the shared iris-runtime:local image once for all docker-mode agents)"
  type        = string
  default     = "/iris/repo"
}

variable "enable_docker_agents" {
  description = "Set true once at least one spawn-agent --mode=docker sub-agent module is defined in agents.tf. Gates the shared iris-runtime:local image build (null_resource.iris_runtime_image) so installs that only use the default service-mode agents (no Terraform/Docker at all) never pay an image-build cost on unrelated `terraform apply` runs."
  type        = bool
  default     = false
}
