/**
 * Item model for the projects table (PK `projectId`, SK `sk`).
 *
 * Everything belonging to one project lives in one partition, distinguished by
 * an `sk` prefix in the same style as the sessions table's `TASK#`/`INVITE#`:
 *
 *   sk = 'META'                      → ProjectMeta   (one per project)
 *   sk = 'MSG#{createdAt}#{msgId}'   → ProjectMessage (one per chat message)
 *   sk = 'MEMBER#{userId}'           → ProjectMember  (one per collaborator)
 *
 * Messages are deliberately separate items, not an array on META: a long
 * conversation would exceed DynamoDB's 400KB item limit, and appending a
 * message must not rewrite the entire history on every save. The timestamp
 * sits ahead of the id in the sort key so a plain ascending query returns the
 * conversation in order.
 */

export interface ProjectMeta {
  projectId: string;
  ownerId: string;
  /** Human-readable id the chat URL routes on; unique per project. */
  urlId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number; // TTL (epoch seconds)
}

export interface ProjectMessage {
  id: string;
  role: string;
  content: string;
  /** Who saved this message — the owner, or an invited collaborator. */
  authorId: string;
  createdAt: number;
}

export interface ProjectMember {
  userId: string;
  role: ProjectMemberRole;
  addedAt: number;
}

export type ProjectMemberRole = 'owner' | 'editor';

/** A message as the client sends it. `id` is what makes a re-save idempotent. */
export interface IncomingMessage {
  id?: string;
  role?: string;
  content?: unknown;
  createdAt?: number | string;
}

export interface CreateProjectRequest {
  id?: string;
  urlId?: string;
  description?: string;
}

export interface SaveMessagesRequest {
  messages?: IncomingMessage[];
}

export interface UpdateProjectRequest {
  description?: string;
  /** Set once, when the slug the URL routes on first becomes known. */
  urlId?: string;
}

export interface GetProjectResponse {
  project: ProjectMeta;
  messages: ProjectMessage[];
}

export interface ListProjectsResponse {
  projects: ProjectMeta[];
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
