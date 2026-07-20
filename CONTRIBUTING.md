# Contributing to Iris Core

Thank you for your interest in contributing to Iris Core! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors.

## How to Contribute

### Reporting Bugs

If you find a bug, please create an issue with:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, provider, model)
- Relevant logs or error messages

### Suggesting Features

Feature suggestions are welcome! Please create an issue describing:
- The use case or problem it solves
- Proposed solution or API
- Alternative approaches considered
- Impact on existing functionality

### Submitting Pull Requests

1. **Fork the repository** and create a branch from `main`
2. **Make your changes** following our coding standards
3. **Test thoroughly** - run `npm test` in `iris-runtime/`; for bootstrap/skill changes, verify on a clean VM
4. **Update the changelog and docs** - behavior-changing PRs must update `iris-runtime/CHANGELOG.md` (under `[Unreleased]`) and the relevant `docs/` page or README **in the same PR**. The docs-guard CI workflow fails PRs that don't; maintainers can apply the `changelog-not-needed` / `docs-not-needed` labels when a change is genuinely invisible to operators.
5. **Write clear commit messages** - explain what and why
6. **Submit a PR** with:
   - Description of changes
   - Related issue numbers
   - Testing performed
   - Screenshots (for UI changes)

### Development Setup

```bash
# Clone your fork
git clone https://github.com/your-username/iris-core.git
cd iris-core/iris-runtime

npm install
npm test          # dispatch/secrets/transport regression suite (also run in CI)
npm run build     # type-check + compile

# Iterate locally with a Docker bash sandbox (tsx watch mode):
./dev.sh
```

For end-to-end testing of `bootstrap.sh` or install-path changes, use a clean
Ubuntu 22.04 VM: `bash bootstrap.sh --setup --no-keyvault` (see
[docs/SETUP.md](docs/SETUP.md) for all install paths).

### Coding Standards

**Shell Scripts:**
- Use `#!/usr/bin/env bash` shebang
- Enable strict mode: `set -euo pipefail`
- Quote variables: `"${VARIABLE}"`
- Use meaningful function names
- Add comments for complex logic

**Skills (SKILL.md):**
- Follow existing skill structure
- Include clear usage examples
- Document all parameters
- Specify required secrets/permissions

**Documentation:**
- Keep README.md accurate and up-to-date
- Use clear, concise language
- Include examples for new features
- Update CLAUDE.md for repo-level conventions

### Testing

Before submitting a PR:
- [ ] `npm test` passes in `iris-runtime/` (CI runs it on every PR)
- [ ] Bootstrap script works on a clean Ubuntu VM (for bootstrap/install changes)
- [ ] Skills load without errors
- [ ] No hardcoded secrets or company-specific references
- [ ] `iris-runtime/CHANGELOG.md` and the relevant docs page are updated (docs-guard CI enforces this for behavior changes)
- [ ] Commit messages are clear

### Generalization Guidelines

Iris Core must remain provider-agnostic and company-neutral:
- **No hardcoded infrastructure:** Use environment variables; cloud (Azure/Terraform) is an opt-in profile, never a requirement of the default path
- **No company names:** Replace with `example.com` or `<your-company>`
- **No secrets:** Resolve via env vars / the `get-secret` skill (`GET /secrets/:name`); Azure Key Vault and external brokers are opt-in backends
- **Support multiple providers:** Anthropic, OpenAI, Azure AI Foundry, AWS Bedrock, plus custom OpenAI-compatible endpoints via `data/models.json`

### Skill Development

When adding new skills:
1. Create `skills/your-skill/` directory
2. Add `SKILL.md` with full documentation (YAML frontmatter: `name`, `description`)
3. Test skill loads and executes correctly (skills hot-reload — no restart needed)
4. Ensure skill works across providers (if applicable)
5. Document required secrets by name; resolve them via the `get-secret` skill, not direct env/Key Vault reads
6. Core ships **platform skills only** (operate/extend/heal). Domain and business skills belong in an install's overlay, not in this repo

### Sub-Agent Development

When adding agent templates:
1. Create `agents/agent-name/` scaffold
2. Add agent-specific `MEMORY.md` and `README.md`
3. Keep templates generic (no company-specific logic)
4. Document deployment and testing

## Review Process

1. Maintainers will review your PR for:
   - Code quality and standards compliance
   - Test coverage and documentation
   - Alignment with project goals
2. Address review feedback promptly
3. Once approved, maintainers will merge

## Questions?

- Create a discussion in GitHub Discussions
- Check existing issues and PRs
- Read the full documentation in README.md

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
