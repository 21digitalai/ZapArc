export type WalletBalancePresentation = {
    balanceSats: number;
    balanceText: string;
    fiatText: string;
    showFiat: boolean;
    loading: boolean;
};

export type CachedFiatBalance = {
    currency?: string;
    balanceSats?: number;
    display?: string;
};

/**
 * Build the immediate balance state shown while changing wallets.
 * Fiat is deliberately cleared because it must never cross wallet boundaries.
 */
export function walletSwitchBalancePresentation(
    cachedBalance: unknown,
    cachedFiat?: CachedFiatBalance | null,
    selectedCurrency?: string,
): WalletBalancePresentation {
    const hasCachedBalance = typeof cachedBalance === 'number' && Number.isFinite(cachedBalance) && cachedBalance >= 0;
    const balanceSats = hasCachedBalance ? cachedBalance : 0;
    const showFiat = Boolean(
        hasCachedBalance
        && selectedCurrency
        && selectedCurrency !== 'sats'
        && cachedFiat?.currency === selectedCurrency
        && cachedFiat?.balanceSats === balanceSats
        && cachedFiat?.display
    );

    return {
        balanceSats,
        balanceText: hasCachedBalance ? `${balanceSats.toLocaleString()} sats` : '-- sats',
        fiatText: showFiat ? cachedFiat?.display || '' : '',
        showFiat,
        loading: !hasCachedBalance,
    };
}
