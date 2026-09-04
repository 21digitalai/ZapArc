import type { WalletMetadata } from '../types';

export type WalletDeletionDestination = 'wallet-selection' | 'onboarding';

export interface WalletDeletionTransition {
    remainingWallets: WalletMetadata[];
    nextActiveWalletId: string | null;
    destination: WalletDeletionDestination;
}

/**
 * Derive the only valid popup state after a successful wallet deletion.
 * The caller must not apply this transition until the background deletion
 * confirms success, so a failed deletion leaves the active screen untouched.
 */
export function createWalletDeletionTransition(
    wallets: WalletMetadata[],
    deletedWalletId: string,
): WalletDeletionTransition {
    const remainingWallets = wallets.filter((wallet) => wallet.id !== deletedWalletId);
    const nextActiveWalletId = remainingWallets.length > 0 ? remainingWallets[0].id : null;

    return {
        remainingWallets,
        nextActiveWalletId,
        destination: nextActiveWalletId ? 'wallet-selection' : 'onboarding',
    };
}
