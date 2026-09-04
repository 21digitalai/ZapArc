export type FinishWalletImportOptions = {
    masterKeyId: string;
    mnemonic: string;
    finalize: () => Promise<boolean>;
    recover: () => void;
    startDiscovery: (masterKeyId: string, mnemonic: string) => Promise<void>;
    onDiscoveryError: (error: unknown) => void;
};

export async function finishWalletImport(options: FinishWalletImportOptions): Promise<boolean> {
    const didFinalize = await options.finalize();
    if (!didFinalize) {
        options.recover();
        return false;
    }

    options.startDiscovery(options.masterKeyId, options.mnemonic).catch(options.onDiscoveryError);
    return true;
}
