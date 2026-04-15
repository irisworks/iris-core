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
3. **Test thoroughly** - ensure bootstrap works, skills function correctly
4. **Update documentation** - README, CLAUDE.md, or skill docs as needed
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
cd iris-core

# Configure environment
cp .env.example .env
# Edit .env with your test values

# Test bootstrap on a VM (recommended)
# Or run locally for development
./bootstrap.sh
```

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
- [ ] Bootstrap script works on clean Ubuntu VM
- [ ] Skills load without errors
- [ ] No hardcoded secrets or company-specific references
- [ ] Documentation is updated
- [ ] Commit messages are clear

### Generalization Guidelines

Iris Core must remain provider-agnostic and company-neutral:
- **No hardcoded infrastructure:** Use environment variables
- **No company names:** Replace with `example.com` or `<your-company>`
- **No secrets:** Store in Key Vault, reference via env vars
- **Support multiple providers:** Azure, AWS, GCP, Anthropic, OpenAI

### Skill Development

When adding new skills:
1. Create `skills/your-skill/` directory
2. Add `SKILL.md` with full documentation
3. Test skill loads and executes correctly
4. Ensure skill works across providers (if applicable)
5. Document required secrets in Key Vault

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

By contributing, you agree that your contributions will be licensed under the MIT License.
