export type WalletBalancePresentation = {
    balanceSats: number;
    balanceText: string;
    fiatText: string;
    showFiat: boolean;
    loading: boolean;
};

/**
 * Build the immediate balance state shown while changing wallets.
 * Fiat is deliberately cleared because it must never cross wallet boundaries.
 */
export function walletSwitchBalancePresentation(cachedBalance: unknown): WalletBalancePresentation {
    const hasCachedBalance = typeof cachedBalance === 'number' && Number.isFinite(cachedBalance) && cachedBalance >= 0;
    const balanceSats = hasCachedBalance ? cachedBalance : 0;

    return {
        balanceSats,
        balanceText: hasCachedBalance ? `${balanceSats.toLocaleString()} sats` : '-- sats',
        fiatText: '',
        showFiat: false,
        loading: !hasCachedBalance,
    };
}

