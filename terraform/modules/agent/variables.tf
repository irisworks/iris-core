variable "agent_name" {
  description = "Short name for the sub-agent (e.g. 'cricket', 'newsletter')"
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

variable "key_vault_name" {
  description = "Azure Key Vault name (passed to agent as env var)"
  type        = string
  default     = ""
}


variable "iris_api_url" {
  description = "Internal Iris API URL reachable from Docker containers (via iris-internal gateway)"
  type        = string
  default     = "http://172.18.0.1:3000"
}

variable "slack_app_token" {
  description = "Agent-specific Slack app token (xapp-...). Overrides the shared token from .env"
  type        = string
  default     = ""
  sensitive   = true
}

variable "slack_bot_token" {
  description = "Agent-specific Slack bot token (xoxb-...). Overrides the shared token from .env"
  type        = string
  default     = ""
  sensitive   = true
}

variable "webui_dir" {
  description = "Optional path to a webui source directory to mount at /workspace/webui (agent can edit files live)"
  type        = string
  default     = ""
}

variable "bridge_port" {
  description = "Internal bridge server port for @agentname routing (prod). Preview gets port+1. 0 = disabled."
  type        = number
  default     = 0
}
