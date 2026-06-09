/**
 * SkillManager — CRUD over the global skill library plus per-agent assignment.
 *
 * A skill is a directory under the skills dir containing a SKILL.md with
 * YAML frontmatter (`name`, `description`) followed by a markdown body.
 * This manager owns that directory: list/read/create/update/delete skill
 * definitions, and assign/unassign them to a sub-agent's workspace.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import {
  getAvailableSkills,
  addSkillToAgent,
  removeSkillFromAgent,
} from "../agent-provision.js";

const SKILL_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export interface SkillSummary {
  name: string;
  description: string;
  files: string[];
}

export interface SkillDetail extends SkillSummary {
  content: string;
}

function parseSkillMd(raw: string): { description: string; content: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { description: "", content: raw.trim() };
  const descMatch = m[1].match(/^description:\s*(.*)$/m);
  return { description: descMatch ? descMatch[1].trim() : "", content: m[2].trim() };
}

function renderSkillMd(name: string, description: string, content: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
}

function defaultSkillContent(name: string): string {
  return `# Skill: ${name}\n\nDescribe what this skill does and how to use it.\n`;
}

export class SkillManager {
  private skillsDir: string;

  constructor(irisDir = process.env.IRIS_DIR ?? "/iris") {
    this.skillsDir = process.env.IRIS_SKILLS_DIR ?? `${irisDir}/data/skills`;
  }

  private skillDir(name: string): string {
    return join(this.skillsDir, name);
  }

  private skillMdPath(name: string): string {
    return join(this.skillDir(name), "SKILL.md");
  }

  private filesIn(name: string): string[] {
    try {
      return readdirSync(this.skillDir(name)).sort();
    } catch {
      return [];
    }
  }

  // ── Read ──────────────────────────────────────────────────────────────

  list(): string[] {
    return getAvailableSkills(this.skillsDir);
  }

  listDetailed(): SkillSummary[] {
    return this.list().map((name) => {
      let description = "";
      try {
        description = parseSkillMd(readFileSync(this.skillMdPath(name), "utf-8")).description;
      } catch { /* SKILL.md missing or unreadable — leave description blank */ }
      return { name, description, files: this.filesIn(name) };
    });
  }

  get(name: string): SkillDetail | null {
    const dir = this.skillDir(name);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
    let description = "";
    let content = "";
    try {
      ({ description, content } = parseSkillMd(readFileSync(this.skillMdPath(name), "utf-8")));
    } catch { /* no SKILL.md yet */ }
    return { name, description, content, files: this.filesIn(name) };
  }

  validate(skills: string[]): string[] {
    const available = this.list();
    return skills.filter(s => !available.includes(s));
  }

  // ── Create / Update / Delete (global skill library) ──────────────────

  create(name: string, description: string, content?: string): SkillDetail {
    if (!SKILL_NAME_RE.test(name)) {
      throw new Error("Skill name must be lowercase letters, digits, and hyphens, starting with a letter (max 64 chars)");
    }
    if (existsSync(this.skillDir(name))) {
      throw new Error(`Skill "${name}" already exists`);
    }
    mkdirSync(this.skillDir(name), { recursive: true });
    writeFileSync(this.skillMdPath(name), renderSkillMd(name, description, content?.trim() || defaultSkillContent(name)));
    return this.get(name)!;
  }

  update(name: string, updates: { description?: string; content?: string }): SkillDetail {
    const existing = this.get(name);
    if (!existing) throw new Error(`Skill "${name}" not found`);
    const description = updates.description ?? existing.description;
    const content = updates.content ?? existing.content;
    writeFileSync(this.skillMdPath(name), renderSkillMd(name, description, content));
    return this.get(name)!;
  }

  remove(name: string): void {
    const dir = this.skillDir(name);
    if (!existsSync(dir)) throw new Error(`Skill "${name}" not found`);
    rmSync(dir, { recursive: true, force: true });
  }

  // ── Per-agent assignment (copies/removes the skill in an agent's workspace) ──

  async assignToAgent(agentWorkspaceDir: string, skill: string): Promise<void> {
    await addSkillToAgent(agentWorkspaceDir, skill, this.skillsDir);
  }

  unassignFromAgent(agentWorkspaceDir: string, skill: string): void {
    removeSkillFromAgent(agentWorkspaceDir, skill);
  }

  /**
   * Create a skill directly in an agent's own workspace (agent-private — not
   * added to the global library, not visible to other agents). Used for skills
   * that are specific to one agent and don't belong in the shared library.
   */
  createForAgent(agentWorkspaceDir: string, name: string, description: string, content?: string): SkillDetail {
    if (!SKILL_NAME_RE.test(name)) {
      throw new Error("Skill name must be lowercase letters, digits, and hyphens, starting with a letter (max 64 chars)");
    }
    const agentSkillsDir = join(agentWorkspaceDir, "skills");
    const skillDir = join(agentSkillsDir, name);
    if (existsSync(skillDir)) throw new Error(`Skill "${name}" already exists in agent workspace`);
    mkdirSync(skillDir, { recursive: true });
    const mdPath = join(skillDir, "SKILL.md");
    writeFileSync(mdPath, renderSkillMd(name, description, content?.trim() || defaultSkillContent(name)));
    const { description: desc, content: body } = parseSkillMd(readFileSync(mdPath, "utf-8"));
    return { name, description: desc, content: body, files: readdirSync(skillDir).sort() };
  }
}
