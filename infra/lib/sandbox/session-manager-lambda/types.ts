export interface Session {
  sessionId: string;
  userId: string;
  taskArn: string;
  privateIp: string;
  status: 'PENDING' | 'ACTIVE' | 'STOPPING' | 'STOPPED';
  createdAt: number;
  lastActivity: number;
  expiresAt: number; // TTL (epoch seconds)
}

export interface CreateSessionRequest {
  userId: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
}

export interface GetSessionResponse {
  session: Session;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}
