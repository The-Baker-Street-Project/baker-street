// ---------------------------------------------------------------------------
// Door Policy types
// ---------------------------------------------------------------------------

export type DoorPolicyMode = 'open' | 'card' | 'list' | 'landlord';

export type SenderStatus = 'approved' | 'blocked' | 'pending';

export interface DoorPolicyEntry {
  platform: string;
  senderId: string;
  status: SenderStatus;
  pairedAt: string | null;
  createdAt: string;
}

export interface PairingChallenge {
  code: string;
  platform: string | null;
  expiresAt: string;
  createdAt: string;
}

export type DoorPolicyCheckResult =
  | { action: 'allow' }
  | { action: 'challenge'; message: string }
  | { action: 'validate_code'; code: string }
  | { action: 'deny' };
