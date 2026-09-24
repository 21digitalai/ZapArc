export type SendBalanceSummary = {
    spendableSats: number;
    amountSats: number;
    feeSats: number | null;
    totalSats: number | null;
    remainingSats: number | null;
    hasSufficientFunds: boolean | null;
};

export function calculateSendBalanceSummary(
    spendableSats: number,
    amountSats: number,
    feeSats: number | null | undefined
): SendBalanceSummary {
    const safeBalance = Math.max(0, Number.isFinite(spendableSats) ? spendableSats : 0);
    const safeAmount = Math.max(0, Number.isFinite(amountSats) ? amountSats : 0);
    const knownFee = typeof feeSats === 'number' && Number.isFinite(feeSats) && feeSats >= 0
        ? feeSats
        : null;
    const totalSats = knownFee === null ? null : safeAmount + knownFee;

    return {
        spendableSats: safeBalance,
        amountSats: safeAmount,
        feeSats: knownFee,
        totalSats,
        remainingSats: totalSats === null ? null : safeBalance - totalSats,
        hasSufficientFunds: totalSats === null
            ? (safeAmount > safeBalance ? false : null)
            : safeBalance >= totalSats
    };
}
