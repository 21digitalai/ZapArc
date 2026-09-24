# ZapArc — Backend and Storage Guide

> Project-specific conventions for privileged extension operations, encrypted wallet storage, and authentication boundaries.
> Builders and Oracles must read this before changing wallet persistence, PIN handling, background messages, migration, or deletion behavior.
> This guide documents the current implementation; it does not create new product or security policy.

---

## Runtime Boundary

ZapArc is a Chrome/Chromium Manifest V3 extension, not a server-backed application. There are no HTTP API routes or database migrations in this repository.

- `src/background/background.ts` owns privileged message handling, storage orchestration, alarms, and validation at the popup/background boundary.
- `src/utils/messaging.ts` is the typed popup-to-background request wrapper. Add or change a privileged operation on both sides of this boundary.
- `src/utils/storage.ts` owns Chrome storage schemas, encryption/decryption, migration, locking, and persistence invariants.
- Breez SDK wallet operations remain in the popup context because the MV3 service worker cannot host the required WASM runtime. Do not move Breez SDK ownership into the background worker.
- Popup modules may read display/cache state directly where the existing code does so, but sensitive wallet mutations must go through the background message boundary and storage manager.

## Storage Ownership and Schema

Persistent state uses `chrome.storage.local`.

- `multiWalletData` is the authoritative multi-wallet payload, serialized as `MultiWalletStorage` from `src/types/index.ts`.
- Each `EncryptedWalletEntry` keeps non-secret display metadata in plaintext and stores only its BIP39 mnemonic in `encryptedMnemonic`.
- `activeWalletId`, `activeSubWalletIndex`, and `walletOrder` belong to the same `multiWalletData` document and must remain consistent with `wallets`.
- `walletVersion` identifies the active persistence format. Legacy `encryptedWallet` exists only for compatibility and migration.
- `backup_encryptedWallet` is the rollback source for the legacy-to-multi-wallet migration. Do not delete it as part of an unrelated cleanup.
- Settings, contacts, domain preferences, cached balances/transactions, and Lightning-address caches are separate keys. Do not place mnemonic material or PINs in those keys.

All read-modify-write operations on wallet topology or encrypted payloads must use `ChromeStorageManager.withStorageLock(...)`. The in-process mutex prevents concurrent wallet switches, additions, deletions, and PIN rotations from overwriting one another.

## Encryption and PIN Authentication

Wallet mnemonics are encrypted in `src/utils/storage.ts`.

- Encryption is AES-GCM with a fresh 12-byte IV.
- New multi-wallet payloads use a fresh 16-byte per-wallet salt encoded in base64.
- Keys are derived from the PIN with PBKDF2/SHA-256 and 100,000 iterations.
- Payloads without a `salt` use the legacy static salt only for backward compatibility. New write paths must use per-wallet salts.
- Decrypted mnemonics are normalized and validated with `bip39.validateMnemonic` before use.
- A failed decrypt is an authentication failure at the caller boundary; never log, return, or cache the mnemonic to diagnose it.

PIN validation belongs at the background message boundary. Current active-wallet PIN changes require exactly six numeric digits and reject reuse of the authenticated session PIN. Rotation is allowed only while the exact active master wallet is unlocked: the popup binds `walletSessionPin` to `walletSessionMasterKeyId`, the background rechecks unlocked state, and storage rechecks the active ID under lock. A missing, stale, switched, or invalid session must require unlock without recording a failed PIN attempt. Reset attempts only after a successful rotation. Other existing PIN prompts may accept older formats for compatibility; do not silently broaden or narrow those flows without a dedicated approved change.

Session PIN state is ephemeral popup state. Never persist a plaintext PIN in `chrome.storage.local`, logs, support exports, error payloads, or analytics.

## Encrypted Payload Writes

Treat every mnemonic write as a verified replacement, not a blind assignment.

1. Validate and normalize the mnemonic before encryption.
2. Encrypt with a fresh salt and IV.
3. Write under the storage lock.
4. Read the persisted record back.
5. Decrypt it with the intended PIN and compare normalized mnemonic values.
6. If verification fails, restore the prior durable payload or remove the newly inserted entry, then return a specific failure.

`addWallet()` and `addMasterKey()` use `verifyStoredMnemonicRoundTrip()` after persistence. `rotateMasterKeyPin()` verifies the replacement before writing, verifies the persisted replacement again, and restores the original encrypted payload if any write or verification step fails.

Never mutate wallet identity, sub-wallet definitions, ordering, or metadata merely because the encryption PIN changes.

## Migration and Rollback

`migrateToMultiWallet()` is the legacy migration path.

- Confirm legacy wallet data exists and decrypts with the supplied PIN before creating the new structure.
- Preserve the original encrypted payload in `backup_encryptedWallet` before making multi-wallet storage authoritative.
- Write `multiWalletData` and `walletVersion` together, then verify both exist.
- `rollbackMigration()` restores `encryptedWallet` from the backup before removing `multiWalletData` and `walletVersion`.

Migration code must remain backward-compatible and reversible. Do not edit or discard legacy compatibility fields without a separately reviewed migration and explicit rollback plan.

PIN rotation has its own local rollback: retain the original `encryptedMnemonic`, restore it on any persistence or verification failure, and surface the error. A successful rotation is complete only after the persisted payload decrypts with the new PIN.

## Deletion and Active-Wallet Invariants

Deletion is a privileged background operation (`DELETE_WALLET`) and requires wallet ID plus PIN verification through the wallet manager/storage layer.

- Never delete the last wallet through the normal multi-wallet deletion path.
- Remove the deleted ID from both `wallets` and `walletOrder`.
- If the active wallet is deleted, select a remaining wallet and reset `activeSubWalletIndex` to `0`.
- Popup navigation changes only after the background confirms success. `createWalletDeletionTransition()` models the post-success UI state.
- Failed deletion must leave the active wallet and current screen unchanged.
- Full `chrome.storage.local.clear()` is destructive reset behavior and must not be reused for ordinary wallet deletion.

## Validation, Errors, and Logging

- Validate message type payloads in `src/background/background.ts` before calling wallet or storage services.
- Return `{ success: true, data? }` or `{ success: false, error }` through `ExtensionMessaging`; do not expose internal objects by default.
- Throw specific errors from storage and wallet operations. Boundary handlers convert them to user-safe error strings.
- Never swallow failures on sensitive writes, migration, rollback, deletion, or PIN rotation.
- Logs may include operation names, wallet IDs, counts, timestamps, and payload sizes. They must not include PIN values, mnemonic words, encryption keys, decrypted payloads, or ciphertext dumps.
- Support diagnostics and exports must preserve the same secret boundary.

## Tests

Use Vitest. Security-sensitive storage changes require focused behavior tests with a mocked `chrome.storage.local` and Web Crypto implementation where needed.

At minimum, cover:

- successful encrypt/write/read/decrypt round trips;
- wrong-PIN and lockout behavior;
- fresh salt/IV behavior for new writes;
- persistence verification failure and restoration/removal of the attempted write;
- PIN rotation success, wrong current PIN, active-wallet change, write failure, and rollback to the original decryptable payload;
- migration success, verification failure, and legacy rollback;
- deletion of active/non-active wallets, refusal to delete the last wallet, and unchanged popup state after failure;
- concurrent mutation serialization when a change touches `multiWalletData`.

Test observable state and error behavior, not private helper implementation details. Existing popup flow tests should remain alongside their owning modules.

## Build and Runtime Checks

Before handoff, run:

```bash
npm run type-check
npm test
npm run build
```

For changes that affect background messages, storage, unlock, migration, deletion, or PIN rotation, also load the production `dist/` directory as an unpacked extension and exercise the affected flow with a disposable test wallet. Verify the service worker console contains no secret material and that extension reload preserves the expected encrypted state.

## Review Checklist

- Storage ownership and the popup/background boundary are preserved.
- Inputs are validated before privileged work.
- No plaintext mnemonic or PIN reaches persistent storage, logs, errors, or exports.
- Every sensitive write has post-write verification and a failure rollback/removal path.
- `wallets`, `walletOrder`, active IDs, and sub-wallet index remain consistent.
- Legacy payloads remain readable and migrations remain reversible.
- Focused failure-path tests, type-check, full tests, build, and proportional runtime evidence pass.
