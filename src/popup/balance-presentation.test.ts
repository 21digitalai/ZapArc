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

    it('shows the matching wallet-scoped fiat estimate immediately', () => {
        expect(walletSwitchBalancePresentation(22_831, {
            currency: 'usd',
            balanceSats: 22_831,
            display: '$20.01',
        }, 'usd')).toEqual({
            balanceSats: 22_831,
            balanceText: '22,831 sats',
            fiatText: '$20.01',
            showFiat: true,
            loading: false,
        });
    });

    it('rejects a fiat estimate belonging to another balance or currency', () => {
        expect(walletSwitchBalancePresentation(15, {
            currency: 'usd',
            balanceSats: 22_831,
            display: '$20.01',
        }, 'eur').showFiat).toBe(false);
    });
});
