import { describe, expect, it } from 'vitest';
import { walletSwitchBalancePresentation } from './balance-presentation';

describe('wallet balance presentation', () => {
    it('clears the previous fiat estimate when a new wallet has no cache', () => {
        expect(walletSwitchBalancePresentation(undefined)).toEqual({
            balanceSats: 0,
            balanceText: '-- sats',
            fiatText: '',
            showFiat: false,
            loading: true,
        });
    });

    it('may show wallet-scoped sats immediately but never reuses another wallet fiat estimate', () => {
        expect(walletSwitchBalancePresentation(0)).toEqual({
            balanceSats: 0,
            balanceText: '0 sats',
            fiatText: '',
            showFiat: false,
            loading: false,
        });
    });
});

