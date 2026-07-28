import { describe, expect, it, vi } from 'vitest';
import { LnurlManager } from './lnurl';

function payRequest(commentAllowed?: number) {
    return { type: 'pay', data: { minSendable: 1_000, maxSendable: 100_000, commentAllowed } };
}

describe('LnurlManager comment delivery', () => {
    it('does not forward a nonblank comment when LUD-12 is unsupported', async () => {
        const wallet = {
            parseLnurl: vi.fn().mockResolvedValue(payRequest(0)),
            hasSufficientBalance: vi.fn().mockResolvedValue(true),
            payLnurl: vi.fn()
        } as any;

        const result = await new LnurlManager(wallet).payLnurl('alice@example.com', 10, 'sender note');

        expect(result).toMatchObject({ success: false, error: expect.stringContaining('does not accept comments') });
        expect(wallet.payLnurl).not.toHaveBeenCalled();
    });

    it('forwards the exact nonblank comment when LUD-12 advertises a sufficient limit', async () => {
        const wallet = {
            parseLnurl: vi.fn().mockResolvedValue(payRequest(32)),
            hasSufficientBalance: vi.fn().mockResolvedValue(true),
            payLnurl: vi.fn().mockResolvedValue({ success: true })
        } as any;

        await new LnurlManager(wallet).payLnurl('alice@example.com', 10, '  exact note  ');

        expect(wallet.payLnurl).toHaveBeenCalledWith(expect.anything(), 10, '  exact note  ');
    });
});
