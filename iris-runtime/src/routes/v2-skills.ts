/**
 * /v2/skills — full CRUD over the global skill library (Gateway consumption).
 *
 * GET    /v2/skills                list all skills (name, description, files)
 * POST   /v2/skills                create a skill — body: { name, description, content? }
 * GET    /v2/skills/:name          get a skill (description, content, files)
 * PATCH  /v2/skills/:name          update a skill — body: { description?, content? }
 * DELETE /v2/skills/:name          delete a skill (blocked if assigned to sub-agents)
 */

import * as log from "../log.js";
import { listSubAgents } from "../sub-agent-registry.js";
import type { V2Handler } from "./v2-types.js";
import { ok, created, err } from "./v2-types.js";

export const handleV2Skills: V2Handler = async (method, parts, _req, readBody, deps) => {
  // GET /v2/skills
  if (method === "GET" && parts.length === 0) {
    return ok({ skills: deps.skillManager.listDetailed() });
  }

  // POST /v2/skills
  if (method === "POST" && parts.length === 0) {
    let body: { name?: string; description?: string; content?: string };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (!body.name || !body.description) return err(400, "name and description are required");
    try {
      const skill = deps.skillManager.create(body.name, body.description, body.content);
      log.logInfo(`[v2/skills] created "${skill.name}"`);
      return created(skill);
    } catch (e) {
      return err(409, e instanceof Error ? e.message : String(e));
    }
  }

  const name = parts[0];
  if (!name) return null;

  // GET /v2/skills/:name
  if (method === "GET" && parts.length === 1) {
    const skill = deps.skillManager.get(name);
    if (!skill) return err(404, "Skill not found");
    return ok(skill);
  }

  // PATCH /v2/skills/:name
  if (method === "PATCH" && parts.length === 1) {
    let body: { description?: string; content?: string };
    try { body = JSON.parse(await readBody()); } catch {
      return err(400, "invalid JSON body");
    }
    if (body.description === undefined && body.content === undefined) {
      return err(400, "description or content is required");
    }
    try {
      const skill = deps.skillManager.update(name, body);
      log.logInfo(`[v2/skills] updated "${name}"`);
      return ok(skill);
    } catch (e) {
      return err(404, e instanceof Error ? e.message : String(e));
    }
  }

  // DELETE /v2/skills/:name
  if (method === "DELETE" && parts.length === 1) {
    const agents = await listSubAgents();
    const inUseBy = agents.filter(a => a.skills.includes(name)).map(a => a.name);
    if (inUseBy.length > 0) {
      return err(409, `Skill "${name}" is assigned to sub-agents: ${inUseBy.join(", ")}. Remove it from them first.`);
    }
    try {
      deps.skillManager.remove(name);
      log.logInfo(`[v2/skills] deleted "${name}"`);
      return ok({ name, deleted: true });
    } catch (e) {
      return err(404, e instanceof Error ? e.message : String(e));
    }
  }

  return null;
};
