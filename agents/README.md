# Iris Sub-Agents

This directory contains sub-agent scaffolds and templates.

## Creating a New Agent

1. Create a directory: `agents/your-agent/`
2. Add agent-specific files:
   - `README.md` - Agent description and setup
   - `MEMORY.md` - Agent-specific memory and rules
   - `CONSTITUTION.md` (optional) - Agent-specific constitution
   - `skills/` - Agent-specific skills
3. Use the `spawn-agent` skill to deploy

## Example Structure

```
agents/your-agent/
├── README.md
├── MEMORY.md
├── skills/
│   ├── skill-one/
│   │   └── SKILL.md
│   └── skill-two/
│       └── SKILL.md
└── webui/ (optional)
    └── ...
```

## Company-Specific Agents

Keep company-specific agents in your private fork's `overlay/agents/` directory.
See CONTRIBUTING.md for extension patterns.
