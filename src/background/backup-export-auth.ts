/**
 * A backup export should affect the PIN lockout only when authentication of the
 * active wallet actually failed. Boundary, storage, and wallet-selection errors
 * must not let malformed requests lock a wallet.
 */
export function isBackupExportPinFailure(error: unknown): boolean {
  return error instanceof Error && error.message === 'Failed to decrypt wallet mnemonic';
}
