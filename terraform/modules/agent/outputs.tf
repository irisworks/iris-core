output "api_token" {
  description = "Per-agent IRIS_API_TOKEN (null unless unique_api_token = true). Add this as the `token` field on this agent's entry in agents.json so Iris's internal API can derive caller identity from it (IRIS-120)."
  value       = var.unique_api_token ? random_password.api_token[0].result : null
  sensitive   = true
}
