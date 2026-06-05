variable "agent_id" {
  description = "UUID for this agent (from telegram_agents table)"
  type        = string
}

variable "agent_name" {
  description = "Human-readable name chosen by the user (e.g. 'ResearchBot')"
  type        = string
}

variable "iris_dir" {
  description = "Root Iris directory on the VM"
  type        = string
  default     = "/iris"
}

variable "iris_repo_dir" {
  description = "Path to the iris-core repo checkout on the VM"
  type        = string
  default     = "/iris/repo"
}

variable "iris_home" {
  description = "Home directory of the user running Iris (for mounting ~/.azure)"
  type        = string
  default     = "/home/azureuser"
}

variable "iris_api_url" {
  description = "Internal Iris API URL reachable from Docker containers"
  type        = string
  default     = "http://172.18.0.1:3000"
}

variable "key_vault_name" {
  description = "Azure Key Vault name (optional)"
  type        = string
  default     = ""
}

variable "skills" {
  description = "List of skill names available to this agent"
  type        = list(string)
  default     = []
}
