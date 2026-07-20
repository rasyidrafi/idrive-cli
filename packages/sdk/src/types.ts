export type EncryptionType = "DEFAULT" | "PRIVATE";

export interface AccountDetails {
  encryptionType: EncryptionType;
  notificationServer?: string;
  syncPassword: string;
  syncUsername: string;
}

export interface SyncServerDetails {
  accountType: string;
  dedup: boolean;
  encryptionType: EncryptionType;
  quota?: number;
  quotaUsed?: number;
  serverDns: string;
  serverIp?: string;
  webServerDns: string;
  webServerIp?: string;
}

export interface StoredProfile {
  dedup: boolean;
  email: string;
  encodedPassword: string;
  encodedPrivateKey: string;
  encryptionType: EncryptionType;
  server: string;
  syncUsername: string;
}

export interface EngineContext {
  encodedPassword: string;
  encodedPrivateKey: string;
  server: string;
  syncUsername: string;
}

export interface ReportPaths {
  errorFile: string;
  reportFile: string;
}
