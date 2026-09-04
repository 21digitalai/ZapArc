import { describe, expect, it } from 'vitest';
import { createWalletDeletionTransition } from './wallet-deletion';

const wallet = (id: string) => ({ id, nickname: id, createdAt: 0, lastUsedAt: 0 });

describe('createWalletDeletionTransition', () => {
    it('selects a remaining wallet after deleting the active wallet', () => {
        const transition = createWalletDeletionTransition([wallet('deleted'), wallet('remaining')], 'deleted');

        expect(transition).toEqual({
            remainingWallets: [wallet('remaining')],
            nextActiveWalletId: 'remaining',
            destination: 'wallet-selection',
        });
    });

    it('routes the final-wallet deletion to onboarding without a stale active ID', () => {
        const transition = createWalletDeletionTransition([wallet('deleted')], 'deleted');

        expect(transition).toEqual({
            remainingWallets: [],
            nextActiveWalletId: null,
            destination: 'onboarding',
        });
    });

    it('does not restore a deleted wallet when stale history replays its identifier', () => {
        const transition = createWalletDeletionTransition([wallet('survivor')], 'deleted');

        expect(transition.nextActiveWalletId).not.toBe('deleted');
        expect(transition.destination).toBe('wallet-selection');
    });
});
