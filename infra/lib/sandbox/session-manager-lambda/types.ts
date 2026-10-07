export interface Session {
  sessionId: string;
  userId: string;
  taskArn: string;
  privateIp: string;
  status: 'PENDING' | 'ACTIVE' | 'STOPPING' | 'STOPPED';
  createdAt: number;
  lastActivity: number;
  expiresAt: number; // TTL (epoch seconds)
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
 * Stored in the sessions table under `INVITE#{token}` (following the existing
 * `TASK#{arn}` single-table convention). The token is the secret; it is
 * single-purpose (one session, one role), single-use, and revocable by deleting
 * the item.
 */
export interface Invite {
  token: string;
  sessionId: string;
  /** Cognito user id of the inviter, for auditing and to reject self-invites. */
  invitedBy: string;
  role: 'editor';
  createdAt: number;
  /**
   * TTL (epoch seconds), on links minted before invites became permanent.
   *
   * Never set on a new invite: the collaborator it lets in is meant to stay a
   * member, so the link that grants that membership does not lapse. Still read,
   * because links issued under the old 30-minute expiry must keep honouring it.
   */
  expiresAt?: number;
  /**
   * Cognito user id of whoever redeemed the link, once someone has.
   *
   * This is what makes a permanent link safe: it grants access to one person, not
   * to everyone it is ever forwarded to. The same user may redeem again — their
   * browser does exactly that after a reload.
   */
  redeemedBy?: string;
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
}

export interface JoinSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
}

export interface CreateSessionRequest {
  userId: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
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
