import { describe, expect, it, vi } from 'vitest';
import { extractLnurlPaymentComment, loadPaymentComment, nonblankPaymentComment, paymentCommentKey, renderTransactionCommentDetailRow, savePaymentComment, shouldShowPaymentComment } from './payment-comment';

describe('payment comments', () => {
    it('uses a wallet-scoped stable payment identity', () => {
        expect(paymentCommentKey('wallet-a', 2, 'payment-1')).toBe('payment_comment_wallet-a_2_payment-1');
    });

    it('keeps provider descriptions and comments distinct without duplicate detail rows', () => {
        expect(shouldShowPaymentComment('Invoice description', 'Lunch reimbursement')).toBe(true);
        expect(shouldShowPaymentComment('Same text', ' Same text ')).toBe(false);
    });

    it('reads the documented incoming LNURL comment metadata only', () => {
        expect(extractLnurlPaymentComment({ details: { inner: { lnurlPayInfo: { comment: ' Thanks! ' } } } })).toBe('Thanks!');
        expect(extractLnurlPaymentComment({ details: { inner: { lnurlPayInfo: { comment: '   ' } } } })).toBeUndefined();
    });

    it('reloads and renders the exact persisted comment in the transaction detail surface', async () => {
        const storage: Record<string, string> = {};
        vi.stubGlobal('chrome', {
            storage: {
                local: {
                    set: vi.fn(async (values: Record<string, string>) => Object.assign(storage, values)),
                    get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]])))
                }
            }
        });
        const storedComment = '  exact sender note  ';
        await savePaymentComment('wallet-a', 2, 'payment-1', storedComment);
        const reloadedComment = await loadPaymentComment('wallet-a', 2, 'payment-1');
        const html = renderTransactionCommentDetailRow('Provider description', reloadedComment, value => value);

        expect(html).toContain('Comment');
        expect(html).toContain(storedComment);
        vi.unstubAllGlobals();
    });

    it('preserves the exact nonblank comment for LNURL delivery while omitting blank values', () => {
        expect(nonblankPaymentComment('  delivered exactly  ')).toBe('  delivered exactly  ');
        expect(nonblankPaymentComment('   ')).toBeUndefined();
    });
});
