output "guest_ip" {
  description = "Guest IP of the Firecracker VM"
  value       = "172.20.${var.slot}.2"
}

output "host_ip" {
  description = "Host-side tap IP"
  value       = "172.20.${var.slot}.1"
}

output "sandbox_arg" {
  description = "Value to pass as --sandbox to iris-runtime"
  value       = "firecracker:172.20.${var.slot}.2"
}

output "service_name" {
  description = "systemd service name for this VM"
  value       = "iris-fc-${var.agent_name}"
}
