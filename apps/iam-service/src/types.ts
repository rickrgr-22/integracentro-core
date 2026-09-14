export type MfaCanal = 'email' | 'whatsapp';

export interface UsuarioRbac {
  id: string; // UUID v4
  email: string;
  rol: string;
  nombre?: string | null;
  password_hash?: string | null;
  mfa_enabled: boolean;
  mfa_canal: MfaCanal;
  telefono?: string | null;
  mfa_backup_codes?: string[] | null;
  mfa_updated_at?: Date;
  created_at: Date;
}

export interface MfaTicketPayload {
  userId: string; // UUID v4
  email: string;
  canal: MfaCanal;
  destino: string;
  hashOtp: string;
  intentosRestantes: number;
}

export interface JwtUserPayload {
  id: string;
  email: string;
  rol: string;
  nombre?: string;
}