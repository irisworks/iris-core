variable "agent_name" {
  description = "Unique name for this Firecracker agent (e.g. 'public-sandbox')"
  type        = string
}

variable "slot" {
  description = "Network slot 1-254. Host gets 172.20.<slot>.1, guest gets 172.20.<slot>.2"
  type        = number

  validation {
    condition     = var.slot >= 1 && var.slot <= 254
    error_message = "slot must be between 1 and 254."
  }
}

variable "firecracker_bin" {
  description = "Path to the firecracker binary"
  type        = string
  default     = "/usr/local/bin/firecracker"
}

variable "jailer_bin" {
  description = "Path to the jailer binary (used when use_jailer = true)"
  type        = string
  default     = "/usr/local/bin/jailer"
}

variable "kernel_image" {
  description = "Path to the vmlinux kernel image"
  type        = string
  default     = "/var/lib/iris/firecracker/vmlinux"
}

variable "base_rootfs" {
  description = "Path to the base ext4 rootfs image (built by build-firecracker-rootfs.sh)"
  type        = string
  default     = "/var/lib/iris/firecracker/rootfs.ext4"
}

variable "rootfs_dir" {
  description = "Directory where per-agent rootfs copies are stored"
  type        = string
  default     = "/var/lib/iris/firecracker/agents"
}

variable "vcpu_count" {
  description = "Number of vCPUs for the microVM"
  type        = number
  default     = 2
}

variable "mem_size_mib" {
  description = "Memory in MiB for the microVM"
  type        = number
  default     = 512
}

variable "use_jailer" {
  description = "Run Firecracker inside the Jailer (recommended for production)"
  type        = bool
  default     = true
}

variable "jailer_uid" {
  description = "UID for the Jailer process"
  type        = number
  default     = 10000
}

variable "jailer_gid" {
  description = "GID for the Jailer process"
  type        = number
  default     = 10000
}
