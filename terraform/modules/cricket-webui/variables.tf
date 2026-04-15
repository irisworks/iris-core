variable "iris_repo_dir" {
  description = "Path to the iris-core repo checkout on the VM"
  type        = string
}

variable "webui_port" {
  description = "Host port to expose the web UI on"
  type        = number
  default     = 8080
}

variable "cricapi_key" {
  description = "CricAPI key for fetching live scores"
  type        = string
  default     = ""
}
