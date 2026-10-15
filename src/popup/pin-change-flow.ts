export type ActiveWallet = { id: string; name: string };
export type PinChangeInput = { newPin: string; confirmation: string };
export type PinRotation = (masterKeyId: string, currentPin: string, newPin: string) => Promise<{ success: boolean; error?: string }>;

export function createPinRotation(messaging: { changeActiveWalletPin: PinRotation }): PinRotation {
    return (masterKeyId, currentPin, newPin) => messaging.changeActiveWalletPin(masterKeyId, currentPin, newPin);
}

export type PinChangeFlowDependencies = {
    expectedMasterId: string;
    getActiveWallet(): Promise<ActiveWallet | null>;
    getAuthenticatedSessionPin(): Promise<string | null>;
    promptForChangePin(): Promise<PinChangeInput | null>;
    rotate: PinRotation;
    persistSessionPin(pin: string): Promise<void>;
    showError(message: string): void;
    showSuccess(message: string): void;
};

export async function runPinChangeFlow(dependencies: PinChangeFlowDependencies): Promise<void> {
    const wallet = await dependencies.getActiveWallet();
    if (!wallet || wallet.id !== dependencies.expectedMasterId) {
        dependencies.showError('Active wallet changed; try again');
        return;
    }
    const initialSessionPin = await dependencies.getAuthenticatedSessionPin();
    if (!initialSessionPin) {
        dependencies.showError('Unlock the current wallet before changing PIN');
        return;
    }

    const change = await dependencies.promptForChangePin();
    if (!change) return;
    const { newPin, confirmation } = change;
    if (!/^\d{6}$/.test(newPin) || !/^\d{6}$/.test(confirmation)) {
        dependencies.showError('PIN must contain exactly 6 digits');
        return;
    }
    if (newPin !== confirmation) {
        dependencies.showError('New PINs do not match');
        return;
    }
    if (newPin === initialSessionPin) {
        dependencies.showError('New PIN must be different');
        return;
    }

    const currentWallet = await dependencies.getActiveWallet();
    if (!currentWallet || currentWallet.id !== dependencies.expectedMasterId) {
        dependencies.showError('Active wallet changed; try again');
        return;
    }
    const currentPin = await dependencies.getAuthenticatedSessionPin();
    if (!currentPin) {
        dependencies.showError('Unlock the current wallet before changing PIN');
        return;
    }

    const response = await dependencies.rotate(wallet.id, currentPin, newPin);
    if (!response.success) {
        dependencies.showError(response.error || 'Failed to change PIN');
        return;
    }
    await dependencies.persistSessionPin(newPin);
    dependencies.showSuccess('PIN changed for the current wallet');
}
