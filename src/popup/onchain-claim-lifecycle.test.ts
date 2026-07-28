import { describe, expect, it } from 'vitest';
import {
    classifyClaimError,
    getClaimKey,
    getProvisionalClaims,
    mergeClaimRows,
    removeProvisionalClaim,
    upsertProvisionalClaim,
} from './onchain-claim-lifecycle';

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

    it('keeps one provisional row per claim output until the completed payment reconciles it', () => {
        const key = getClaimKey('claim-tx', 2);
        upsertProvisionalClaim({ key, txid: 'claim-tx', vout: 2, amountSats: 1_234, status: 'confirming' });
        upsertProvisionalClaim({ key, txid: 'claim-tx', vout: 2, amountSats: 1_234, status: 'retrying' });

        expect(getProvisionalClaims().filter((claim) => claim.key === key)).toHaveLength(1);
        expect(mergeClaimRows(getProvisionalClaims(), new Set([key]))).not.toContainEqual(expect.objectContaining({ key }));
        removeProvisionalClaim(key);
    });
});
