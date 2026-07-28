import { describe, expect, it } from 'vitest';
import { extractLnurlPaymentComment, paymentCommentKey, shouldShowPaymentComment } from './payment-comment';

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
});
