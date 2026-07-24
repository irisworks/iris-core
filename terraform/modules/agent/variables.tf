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

variable "unique_api_token" {
  description = "Provision a unique per-agent IRIS_API_TOKEN (module output `api_token`) instead of the shared token from .env. Opt-in: enabling it 401s this agent's API calls until the output value is registered as the agent's `token` field in agents.json (IRIS-120)."
  type        = bool
  default     = false
}

variable "iris_provider" {
  description = "LLM provider for the agent runtime (IRIS_PROVIDER). Only needed with secrets_mode store/proxy, where the container no longer inherits it from /iris/.env."
  type        = string
  default     = ""
}

variable "iris_model" {
  description = "Model id for the agent runtime (IRIS_MODEL). Only needed with secrets_mode store/proxy, where the container no longer inherits it from /iris/.env."
  type        = string
  default     = ""
}

variable "image_dependency" {
  description = "id of the shared null_resource.iris_runtime_image (terraform/main.tf), passed through so this module's container waits on — and rebuilds after — the one shared image build instead of running its own redundant `npm run build && docker build` per agent."
  type        = string
}

variable "secrets_mode" {
  description = "Host secrets mode (IRIS_SECRETS_MODE). With \"env\" (default) the container inherits the whole /iris/.env via --env-file, matching pre-mode behavior. With \"store\" or \"proxy\" the env files are NOT passed: the agent resolves secrets through the parent API's /secret/:name route (per-agent allow-list in agents.json), so unique_api_token must be true and the agent's `secrets` array must list every name it needs — including its LLM key (e.g. ANTHROPIC-API-KEY). See docs/secrets.md."
  type        = string
  default     = "env"

  validation {
    condition     = contains(["env", "store", "proxy"], var.secrets_mode)
    error_message = "secrets_mode must be \"env\", \"store\", or \"proxy\"."
  }
}
