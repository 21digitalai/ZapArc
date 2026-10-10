type MasterWalletPinActionDependencies = {
    switchToMaster(masterId: string): Promise<void>;
    getActiveWallet(): Promise<{ masterId: string; subWalletIndex: number } | null>;
    dispatchPinChange(masterId: string, button: PinActionButton): void;
};

type PinActionButton = {
    getAttribute(name: string): string | null;
    addEventListener(type: 'click', listener: (event: Event) => void): void;
};

type PinActionRoot = {
    querySelectorAll(selector: '.master-wallet-pin-btn'): ArrayLike<PinActionButton>;
};

export function attachMasterWalletPinActions(
    root: PinActionRoot,
    dependencies: MasterWalletPinActionDependencies,
): void {
    const buttons = root.querySelectorAll('.master-wallet-pin-btn');
    for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        button.addEventListener('click', (event) => {
            void handleMasterWalletPinAction(event, button, dependencies);
        });
    }
}

async function handleMasterWalletPinAction(
    event: Event,
    button: PinActionButton,
    dependencies: MasterWalletPinActionDependencies,
): Promise<void> {
    event.stopPropagation();
    const masterId = button.getAttribute('data-master-id');
    if (!masterId) return;

    await dependencies.switchToMaster(masterId);
    const activeWallet = await dependencies.getActiveWallet();
    if (!activeWallet || activeWallet.masterId !== masterId || activeWallet.subWalletIndex !== 0) return;

    dependencies.dispatchPinChange(masterId, button);
}
