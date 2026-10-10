export function createSingleFlight<Args extends unknown[]>(task: (...args: Args) => Promise<void>): (...args: Args) => Promise<void> {
    let inFlight: Promise<void> | null = null;

    return (...args: Args) => {
        if (inFlight) return inFlight;
        inFlight = task(...args).finally(() => { inFlight = null; });
        return inFlight;
    };
}
