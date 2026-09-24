export type ActiveWallet = { id: string; name: string };

export type PinChangeFlowDependencies = {
    getActiveWallet(): Promise<ActiveWallet | null>;
    getAuthenticatedSessionPin(): Promise<string | null>;
    promptForPin(message: string): Promise<string | null>;
    rotate(masterKeyId: string, currentPin: string, newPin: string): Promise<{ success: boolean; error?: string }>;
    persistSessionPin(pin: string): Promise<void>;
    showError(message: string): void;
    showSuccess(message: string): void;
};

export async function runPinChangeFlow(dependencies: PinChangeFlowDependencies): Promise<void> {
    const wallet = await dependencies.getActiveWallet();
    if (!wallet) {
        dependencies.showError('No active wallet found');
        return;
    }

    const newPin = await dependencies.promptForPin('Enter a new 6-digit PIN');
    if (!newPin) return;
    const confirmation = await dependencies.promptForPin('Confirm the new PIN');
    if (!confirmation) return;
    if (newPin !== confirmation) {
        dependencies.showError('New PINs do not match');
        return;
    }
    const currentPin = await dependencies.getAuthenticatedSessionPin();
    if (!currentPin) {
        dependencies.showError('Unlock the current wallet before changing PIN');
        return;
    }
    if (newPin === currentPin) {
        dependencies.showError('New PIN must be different');
        return;
    }

    const currentWallet = await dependencies.getActiveWallet();
    if (!currentWallet || currentWallet.id !== wallet.id) {
        dependencies.showError('Active wallet changed; try again');
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
