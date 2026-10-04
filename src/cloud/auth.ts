import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';

export interface UserCredentials {
  uid: string;
  email?: string;
  displayName?: string;
  refreshToken: string;
}

export function credentialsDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'cws');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'cws');
}

export function credentialsPath(customPath?: string): string {
  return customPath ?? path.join(credentialsDir(), 'credentials.json');
}

export async function loadCredentials(customPath?: string): Promise<UserCredentials | null> {
  const file = credentialsPath(customPath);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<UserCredentials>;
    if (typeof parsed?.uid === 'string' && typeof parsed?.refreshToken === 'string') {
      return {
        uid: parsed.uid,
        refreshToken: parsed.refreshToken,
        ...(parsed.email ? { email: parsed.email } : {}),
        ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
      };
    }
  } catch {
    // file does not exist or unreadable
  }
  return null;
}

export async function saveCredentials(creds: UserCredentials, customPath?: string): Promise<void> {
  const file = credentialsPath(customPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
}

export async function clearCredentials(customPath?: string): Promise<boolean> {
  const file = credentialsPath(customPath);
  try {
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

export async function isLoggedIn(customPath?: string): Promise<boolean> {
  const creds = await loadCredentials(customPath);
  return creds !== null;
}

export interface Authenticator {
  login(): Promise<UserCredentials>;
}

export async function loginWithToken(token: string, customPath?: string): Promise<UserCredentials> {
  // If token is a JWT with payload, parse uid if possible, otherwise use a hash or direct identifier
  let uid = 'google_user';
  let email: string | undefined;
  try {
    const parts = token.split('.');
    const part1 = parts[1];
    if (parts.length >= 2 && part1) {
      const payload = JSON.parse(Buffer.from(part1, 'base64').toString('utf8')) as {
        user_id?: string;
        sub?: string;
        email?: string;
      };
      uid = payload.user_id || payload.sub || uid;
      email = payload.email;
    }
  } catch {
    // opaque token
  }

  const creds: UserCredentials = {
    uid,
    refreshToken: token,
    ...(email ? { email } : {}),
  };
  await saveCredentials(creds, customPath);
  return creds;
}
