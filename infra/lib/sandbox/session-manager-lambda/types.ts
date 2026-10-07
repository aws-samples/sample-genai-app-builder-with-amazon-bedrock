export interface Session {
  sessionId: string;
  userId: string;
  taskArn: string;
  privateIp: string;
  status: 'PENDING' | 'ACTIVE' | 'STOPPING' | 'STOPPED';
  createdAt: number;
  lastActivity: number;
  expiresAt: number; // TTL (epoch seconds), extended on every heartbeat
  /** Epoch ms of the last status change; absent on records written before it existed. */
  statusChangedAt?: number;
  /**
   * Cognito user ids invited to co-edit this session, excluding the owner.
   * Absent on solo sessions — collaboration is opt-in, so nothing is written
   * until the owner actually invites someone.
   */
  members?: string[];
}

/**
 * An invitation to co-edit a session.
 *
 * Stored in the sessions table under `INVITE#{sha256(token)}` (following the
 * existing `TASK#{arn}` single-table convention). The token is a bearer secret
 * and is never persisted; it is single-purpose (one session, one role),
 * single-use, time-limited and revocable.
 */
export interface Invite {
  /** The plaintext bearer token. Only ever held in memory, never stored. */
  token: string;
  /**
   * The DynamoDB key the record was found under: the token's hash, or the raw
   * token for links minted before hashing. Set on records read back.
   */
  recordKey?: string;
  sessionId: string;
  /** User id of the inviter. Must be the session owner for the invite to work. */
  invitedBy: string;
  role: 'editor';
  createdAt: number;
  /**
   * When the link stops being redeemable (epoch seconds). Also the table's TTL
   * attribute. Records minted without one are treated as expiring a full invite
   * lifetime after `createdAt`.
   */
  expiresAt: number;
  /**
   * User id of whoever redeemed the link, once someone has.
   *
   * A link grants access to one person, not to everyone it is forwarded to. The
   * same user may redeem again. Revoking the invite removes this user's access.
   */
  redeemedBy?: string;
  /** Set when the owner revokes the link; a revoked link can never be claimed. */
  revokedAt?: number;
  /**
   * Project whose conversation the invite also grants, when the inviter had one
   * open.
   *
   * Sharing a sandbox only shares the files; the chat history is a separate
   * record. Carrying the project here is what lets redemption grant both, since
   * an invite is minted before anyone accepts it — at which point the inviter
   * cannot know who to grant access to.
   */
  projectId?: string;
}

export interface CreateInviteResponse {
  token: string;
  /** When the link stops being redeemable (epoch seconds). */
  expiresAt: number;
}

export interface JoinSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
  /** Live preview URL on the untrusted-content origin (never the app's). */
  previewUrl?: string;
}

export interface CreateSessionRequest {
  userId: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
  /** Live preview URL on the untrusted-content origin (never the app's). */
  previewUrl?: string;
  /**
   * True when the caller was handed the session they already had rather than a
   * new one — a reload of a session someone else is in. Present so a client can
   * tell "reconnected to my shared sandbox" from "got a fresh sandbox"; the
   * connection details are used the same way either way.
   */
  resumed?: boolean;
}

export interface GetSessionResponse {
  session: Session;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
