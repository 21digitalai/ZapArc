/** All top-level view container IDs. Only one should be visible at a time. */
const ALL_VIEW_IDS = [
    'main-interface',
    'unlock-interface',
    'onboarding-wizard',
    'deposit-interface',
    'withdraw-interface',
    'settings-interface',
    'contacts-interface',
    'wallet-management-interface',
    'wallet-selection-interface',
    'archived-wallets-interface',
    'rename-wallet-interface',
    'transaction-history-view',
    'qr-only-interface',
] as const;

/**
 * Hide every top-level popup view before showing the next one.
 * This keeps transitions from leaving multiple views visible at once.
 */
export function hideAllViews(): void {
    for (const id of ALL_VIEW_IDS) {
        document.getElementById(id)?.classList.add('hidden');
    }
}
