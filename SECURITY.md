# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

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

- **Never commit secrets** to git repositories
- Store all API keys and tokens in Azure Key Vault (or equivalent)
- Use Key Vault references in systemd services
- Rotate secrets regularly
- Use separate secrets for preview and prod environments

### Infrastructure

- **Principle of least privilege:** Grant minimal Azure permissions needed
- Use managed identities when possible
- Enable Azure Key Vault access policies, not RBAC for secrets
- Restrict network access to VMs (use NSG rules)
- Enable Azure Security Center monitoring

### Git Hygiene

- Add `.env`, `*.local.json`, `secrets.*` to `.gitignore`
- Never use `--no-verify` to bypass pre-commit hooks
- Review diffs before committing
- If secrets are accidentally committed:
  1. Revoke the exposed secret immediately
  2. Use `git-filter-repo` to remove from history
  3. Force push (coordinate with team)

### Sub-Agent Isolation

- Run sub-agents in separate containers or VMs
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

Iris sends conversation history to your configured LLM provider:
- Azure OpenAI: Microsoft trust boundary
- Anthropic: Anthropic trust boundary
- OpenAI: OpenAI trust boundary

**Mitigation:** Use provider-specific compliance certifications (SOC 2, HIPAA, etc.) and ensure your data classification allows cloud AI processing.

### Sub-Agent Communication

Current sub-agent communication via Slack or file queues:
- Slack: Messages visible to workspace members
- File queues: Accessible to anyone with filesystem access

**Mitigation:** Phase 4 internal HTTP API (planned) will provide isolated communication.

## Vulnerability Disclosure Policy

- We follow coordinated disclosure
- Security fixes are prioritized and released ASAP
- Public disclosure after patch is available
- CVE assignment for critical vulnerabilities

## Security Updates

Subscribe to GitHub releases and security advisories to receive notifications about security updates.
