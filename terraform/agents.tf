# ============================================================
# Sub-Agent Definitions
# ============================================================
# Two module types are available:
#
# ── Docker agent (trusted internal use) ──────────────────────
# module "my_agent" {
#   source = "./modules/agent"
#
#   agent_name       = "my-agent"
#   key_vault_name   = var.key_vault_name
#   iris_api_url     = "http://172.18.0.1:3000"
#   bridge_port      = 4100
#   unique_api_token = true   # opt-in per-agent token (IRIS-120), see below
# }
#
# output "my_agent_api_token" {
#   value     = module.my_agent.api_token
#   sensitive = true
# }
#
# With `unique_api_token = true`, the container gets its own IRIS_API_TOKEN
# instead of the shared one from .env — that's what lets Iris's API derive
# caller identity from the authenticating token instead of the self-reported
# X-Iris-Caller header (IRIS-120). The agent's API calls are 401 until the
# token is registered, so after apply, run
# `terraform output -raw my_agent_api_token` and copy the value into this
# agent's `token` field in agents.json as part of the same change. Left off
# (the default), the agent keeps using the shared token and resolves as
# unrestricted "iris", same as before.
#
# ── Firecracker agent (public / untrusted use) ───────────────
# Each microVM gets its own Linux kernel + isolated filesystem.
# The VM boots in ~125ms; Iris sends bash commands via HTTP.
#
# Slot number (1-254) determines the network:
#   Host tap: 172.20.<slot>.1
#   Guest VM: 172.20.<slot>.2
#
# module "public_sandbox" {
#   source = "./modules/firecracker-agent"
#
#   agent_name   = "public-sandbox"
#   slot         = 1          # → VM reachable at 172.20.1.2
#   vcpu_count   = 2
#   mem_size_mib = 512
#   use_jailer   = true       # recommended for production
# }
# ============================================================
#
# Uncomment the block below to provision the first Firecracker
# public-sandbox agent (requires --firecracker bootstrap first):
#
# module "public_sandbox" {
#   source = "./modules/firecracker-agent"
#
#   agent_name   = "public-sandbox"
#   slot         = 1
#   vcpu_count   = 2
#   mem_size_mib = 512
#   use_jailer   = true
# }
# ============================================================
