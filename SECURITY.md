# Security Policy

## Supported Versions

Iris Core is pre-1.0. Security fixes land on `main` and in the latest tagged
release only — older tags are not patched. Installs pin the `core` submodule to
a release tag (see [docs/RELEASING.md](docs/RELEASING.md)); bump to the latest
tag to pick up fixes.

| Version              | Supported          |
| -------------------- | ------------------ |
| Latest release (0.x) | :white_check_mark: |
| Older tags           | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of the following methods:

### Preferred: GitHub Security Advisories

1. Go to the repository's Security tab
2. Click "Report a vulnerability"
3. Fill out the advisory form with details

### Alternative: Email

Send an email to: security@thirtysignals.com

Please include:
- Type of vulnerability
- Full path of source file(s) related to the vulnerability
- Location of affected source code (tag/branch/commit)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability

### What to Expect

- **Acknowledgment:** Within 48 hours
- **Assessment:** Within 7 days we'll provide an initial assessment
- **Resolution:** We'll work on a fix and coordinate disclosure timing
- **Credit:** You'll be credited in the security advisory (if desired)

## Security Best Practices

When deploying Iris Core:

### Secrets Management

- **Never commit secrets** to git repositories — `/iris/.env` and `agents.json`
  (which holds live bearer tokens once per-agent `token` fields are set) must
  stay out of version control with tight file permissions
- Sub-agents resolve secrets through the internal API (`GET /secrets/:name`)
  and must be allow-listed per secret in `agents.json` — grant each agent only
  the secrets it needs
- Optional hardened backends: Azure Key Vault (`IRIS_KEY_VAULT`), the bundled
  credential broker (`IRIS_SECRETS_MODE=store|proxy` — see `docs/secrets.md`),
  or an external broker (`IRIS_SECRET_BROKER_URL` — Vault, Infisical, or any
  HTTP service speaking the contract)
- `env` mode (the default) puts every secret in the runtime's process
  environment, so any bash tool call the agent runs — `env`, `cat /iris/.env`
  — can read and echo it. `store` mode moves secrets into an encrypted local
  file and scrubs them from the process environment after startup; `proxy`
  mode adds a separate-uid broker daemon so the agent process can't read the
  key material at all, and secrets marked proxy-only can be *used* (via the
  injection gateway) but never read as plaintext by anyone
- Rotate secrets regularly
- Use separate secrets for preview and prod environments
- Never ask a user to paste a secret into chat — it lands in the LLM's
  context and transcripts. Use the `set-secret` skill to mint a one-time drop
  link instead (`docs/secrets.md`)

### Internal API and Web UI

- The internal HTTP API binds to loopback (`127.0.0.1:3000`) by default. If you
  widen the bind (e.g. `IRIS_API_HOST=0.0.0.0` for Docker sub-agents), **always**
  set `IRIS_API_TOKEN` — never expose the API beyond loopback without a token
- Give each sub-agent its own API token (`unique_api_token` in the Terraform
  agent module + a `token` field in `agents.json`) so the secrets allow-list is
  a real boundary, not just an audit trail
- The web UI is off by default (`IRIS_WEBUI_PORT`). Set `IRIS_WEBUI_PASSWORD`
  before exposing it beyond loopback — without it there is no auth gate

### Infrastructure (cloud profile)

On installs using the opt-in Azure/Terraform profile:

- **Principle of least privilege:** Grant minimal Azure permissions needed
- Use managed identities when possible
- Restrict network access to VMs (use NSG rules)
- Enable cloud security monitoring

### Git Hygiene

- Add `.env`, `*.local.json`, `secrets.*` to `.gitignore`
- Never use `--no-verify` to bypass pre-commit hooks
- Review diffs before committing
- If secrets are accidentally committed:
  1. Revoke the exposed secret immediately
  2. Use `git-filter-repo` to remove from history
  3. Force push (coordinate with team)

### Sub-Agent Isolation

- Run sub-agents in separate Docker containers, or — for the strongest
  boundary — Firecracker microVMs (`--sandbox=firecracker:<ip>` or
  `--sandbox=firecracker-pool`): KVM hardware boundary → jailer (chroot,
  uid 10000, seccomp) → per-VM `/30` TAP network → ephemeral rootfs
- Use resource limits (CPU, memory) to prevent DoS
- Validate all input from sub-agents
- Don't trust sub-agent responses implicitly

### Skill Security

- Review skills before loading (especially from external sources)
- Skills have full bash access - treat as executable code
- Limit skill scope to necessary permissions
- Audit skill changes in git diffs

### Deployment

- Use HTTPS for all public endpoints
- Enable TLS certificates via Let's Encrypt
- Keep dependencies updated (`npm audit`, `apt upgrade`)
- Monitor systemd logs for suspicious activity
- Set up alerting for service failures

## Known Security Considerations

### Bash Sandbox Mode

Iris runs with `--sandbox=host` which means:
- Bash commands execute directly on the host
- Skills have full system access
- No containerization of the orchestrator itself

**Mitigation:** Run Iris on a dedicated VM with minimal privileges and careful skill auditing.

### LLM Provider Trust

Iris sends conversation history to your configured LLM provider — Anthropic,
OpenAI, Azure AI Foundry, AWS Bedrock, or a custom OpenAI-compatible endpoint
registered in `data/models.json`. Each is its own trust boundary.

**Mitigation:** Use provider-specific compliance certifications (SOC 2, HIPAA, etc.) and ensure your data classification allows cloud AI processing.

### Sub-Agent Communication

Sub-agents communicate with Iris over an internal HTTP bridge (registered in
`agents.json`, `@agentname` routing) and the internal API:

- Both bind to loopback by default; bearer-token auth (`IRIS_API_TOKEN`) is
  required the moment either is reachable beyond loopback
- Bridge and API error responses return generic messages — internal details
  (paths, exceptions) go to logs only
- The secrets route derives caller identity from the authenticating token, not
  from self-reported headers

**Residual risk:** with a single shared `IRIS_API_TOKEN`, all sub-agents
resolve as unrestricted `iris`. Issue per-agent tokens (see above) to make the
secrets allow-list an enforced boundary.

## Vulnerability Disclosure Policy

- We follow coordinated disclosure
- Security fixes are prioritized and released ASAP
- Public disclosure after patch is available
- CVE assignment for critical vulnerabilities

## Security Updates

Subscribe to GitHub releases and security advisories to receive notifications about security updates.
