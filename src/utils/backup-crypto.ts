import * as bip39 from 'bip39';

export interface EncryptedBackupBlob {
  format: 'aes-256-gcm';
  salt: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface EncryptedBackup extends EncryptedBackupBlob {
  version: 3;
  timestamp: number;
  walletName?: string;
  seedFingerprint?: string;
  contacts?: EncryptedBackupBlob;
}

const BACKUP_VERSION = 3;
const PBKDF2_ITERATIONS = 100000;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isValidEncodedBytes(value: unknown, length?: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const bytes = base64ToBytes(value);
    return length === undefined || bytes.length === length;
  } catch {
    return false;
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBlob(plaintext: string, password: string): Promise<EncryptedBackupBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, new TextEncoder().encode(plaintext)));
  const ciphertext = encrypted.slice(0, -AUTH_TAG_BYTES);
  const authTag = encrypted.slice(-AUTH_TAG_BYTES);
  return { format: 'aes-256-gcm', salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext), authTag: bytesToBase64(authTag) };
}

async function decryptBlob(blob: EncryptedBackupBlob, password: string): Promise<string> {
  if (!isEncryptedBlob(blob)) throw new Error('Invalid backup file format');
  try {
    const salt = base64ToBytes(blob.salt);
    const iv = base64ToBytes(blob.iv);
    const ciphertext = base64ToBytes(blob.ciphertext);
    const authTag = base64ToBytes(blob.authTag);
    const key = await deriveKey(password, salt);
    const encrypted = new Uint8Array(ciphertext.length + authTag.length);
    encrypted.set(ciphertext);
    encrypted.set(authTag, ciphertext.length);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, tagLength: 128 }, key, encrypted as BufferSource));
  } catch {
    throw new Error('Failed to decrypt backup. Please check your password.');
  }
}

export function isEncryptedBlob(value: unknown): value is EncryptedBackupBlob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Record<string, unknown>;
  return blob.format === 'aes-256-gcm' && isValidEncodedBytes(blob.salt, SALT_BYTES) && isValidEncodedBytes(blob.iv, IV_BYTES) && isValidEncodedBytes(blob.ciphertext) && isValidEncodedBytes(blob.authTag, AUTH_TAG_BYTES);
}

export function isEncryptedBackup(value: unknown): value is EncryptedBackup {
  if (!isEncryptedBlob(value)) return false;
  const backup = value as unknown as Record<string, unknown>;
  return backup.version === BACKUP_VERSION && typeof backup.timestamp === 'number' && (backup.contacts === undefined || isEncryptedBlob(backup.contacts));
}

export async function encryptBackupMnemonic(mnemonic: string, password: string, walletName?: string, contacts?: string): Promise<EncryptedBackup> {
  if (!bip39.validateMnemonic(mnemonic.trim().toLowerCase())) throw new Error('Invalid recovery phrase');
  const encrypted = await encryptBlob(mnemonic.trim().toLowerCase(), password);
  const contactBlob = contacts === undefined ? undefined : await encryptBlob(contacts, password);
  return { ...encrypted, version: BACKUP_VERSION, timestamp: Date.now(), walletName, ...(contactBlob ? { contacts: contactBlob } : {}) };
}

export async function decryptBackupMnemonic(backup: unknown, password: string): Promise<{ mnemonic: string; contacts?: string }> {
  if (!isEncryptedBackup(backup)) throw new Error('Invalid or unsupported backup file');
  const mnemonic = (await decryptBlob(backup, password)).trim().toLowerCase();
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid recovery phrase in backup');
  return { mnemonic, ...(backup.contacts ? { contacts: await decryptBlob(backup.contacts, password) } : {}) };
}
