/**
 * SessionManager — wraps sessions.ts with a consistent class interface.
 * Adds Blob write-through when BLOB_ENABLED=true.
 */

import {
  createSession,
  loadSessions,
  updateSession,
  listForAgent,
  type Session,
} from "../sessions.js";
import { blobWrite } from "../blob.js";

export type { Session };

export class SessionManager {
  constructor(private workingDir: string) {}

  create(opts: Parameters<typeof createSession>[1]): Session {
    const session = createSession(this.workingDir, opts);
    void blobWrite(`sessions/${session.sessionId}.json`, JSON.stringify(session));
    return session;
  }

  list(): Session[] {
    return Array.from(loadSessions(this.workingDir).values());
  }

  get(sessionId: string): Session | undefined {
    return loadSessions(this.workingDir).get(sessionId);
  }

  listForAgent(agentId: string): Session[] {
    return listForAgent(loadSessions(this.workingDir), agentId);
  }

  update(sessionId: string, patch: Partial<Session>): Session {
    const updated = updateSession(this.workingDir, sessionId, patch);
    void blobWrite(`sessions/${updated.sessionId}.json`, JSON.stringify(updated));
    return updated;
  }
}
