import { describe, expect, it } from 'vitest';
import { calculateSendBalanceSummary } from './send-balance-summary';

describe('calculateSendBalanceSummary', () => {
    it('includes known fees when calculating the remaining balance', () => {
        expect(calculateSendBalanceSummary(10_000, 2_500, 75)).toMatchObject({
            totalSats: 2_575,
            remainingSats: 7_425,
            hasSufficientFunds: true
        });
    });

    it('flags a payment whose amount plus fee exceeds the spendable balance', () => {
        expect(calculateSendBalanceSummary(1_000, 950, 75)).toMatchObject({
            remainingSats: -25,
            hasSufficientFunds: false
        });
    });

    it('keeps the remainder and sufficiency unknown when the fee is unavailable', () => {
        expect(calculateSendBalanceSummary(1_000, 950, undefined)).toMatchObject({
            totalSats: null,
            remainingSats: null,
            hasSufficientFunds: null
        });
    });
});
