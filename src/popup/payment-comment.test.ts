import { describe, expect, it } from 'vitest';
import { extractLnurlPaymentComment, nonblankPaymentComment, paymentCommentKey, renderPaymentCommentDetailRow, shouldShowPaymentComment } from './payment-comment';

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

    it('renders the exact persisted comment in a transaction detail row after reload', () => {
        const storedComment = '  exact sender note  ';
        const html = renderPaymentCommentDetailRow(storedComment, value => value);

        expect(html).toContain('Comment');
        expect(html).toContain(storedComment);
    });

    it('preserves the exact nonblank comment for LNURL delivery while omitting blank values', () => {
        expect(nonblankPaymentComment('  delivered exactly  ')).toBe('  delivered exactly  ');
        expect(nonblankPaymentComment('   ')).toBeUndefined();
    });
});
