/**
 * SkillManager — wraps agent-provision skill utilities with a class interface.
 */

import {
  getAvailableSkills,
  addSkillToAgent,
  removeSkillFromAgent,
} from "../agent-provision.js";

export class SkillManager {
  private skillsDir: string;

  constructor(irisDir = process.env.IRIS_DIR ?? "/iris") {
    this.skillsDir = process.env.IRIS_SKILLS_DIR ?? `${irisDir}/data/skills`;
  }

  list(): string[] {
    return getAvailableSkills(this.skillsDir);
  }

  validate(skills: string[]): string[] {
    const available = this.list();
    return skills.filter(s => !available.includes(s));
  }

  async add(agentWorkspaceDir: string, skill: string): Promise<void> {
    await addSkillToAgent(agentWorkspaceDir, skill, this.skillsDir);
  }

  remove(agentWorkspaceDir: string, skill: string): void {
    removeSkillFromAgent(agentWorkspaceDir, skill);
  }
}
