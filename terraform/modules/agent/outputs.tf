output "api_token" {
  description = "Per-agent IRIS_API_TOKEN. Add this as the `token` field on this agent's entry in agents.json so Iris's internal API can derive caller identity from it (IRIS-120)."
  value       = random_password.api_token.result
  sensitive   = true
}
