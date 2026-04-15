variable "subscription_id" {
  validation {
    condition = length(var.subscription_id) > 0
    error_message = "Azure subscription ID must be provided via IRIS_AZURE_SUBSCRIPTION or TF_VAR_subscription_id"
  }
  description = "Azure subscription ID"
  type        = string
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

variable "tags" {
  description = "Tags applied to all resources"
  type        = map(string)
}

variable "key_vault_name" {
  description = "Azure Key Vault name passed to sub-agent containers"
  type        = string
  default     = "iris-core-kv-51560915"
}
