import { describe, expect, it } from 'vitest';
import { classifyClaimError, getClaimKey, mergeClaimRows } from './onchain-claim-lifecycle';

describe('on-chain claim lifecycle', () => {
    it('keeps nested fee and network failures retryable', () => {
        expect(classifyClaimError({ inner: { message: 'Network timeout' } }, 10_000).status).toBe('retrying');
        expect(classifyClaimError({ variant: 'MaxDepositClaimFeeExceeded', inner: { requiredFeeSats: 900 } }, 10_000).status).toBe('retrying');
    });

    it('only classifies uneconomical deposits as too small', () => {
        expect(classifyClaimError({ inner: { requiredFeeSats: 900 } }, 1_000).status).toBe('too-small');
        expect(classifyClaimError(new Error('missing UTXO'), 1_000).status).toBe('retrying');
    });

    it('deduplicates provisional rows by output identity', () => {
        const key = getClaimKey('tx', 1);
        expect(mergeClaimRows([{ key, txid: 'tx', vout: 1, amountSats: 1, status: 'claiming' }], new Set([key]))).toEqual([]);
    });
});
