import { beforeEach, describe, expect, it, vi } from 'vitest';

import { currencyService, getBtcSpotPrice } from './currency';

describe('BTC spot price', () => {
  beforeEach(() => {
    currencyService.clearCache();
    vi.restoreAllMocks();
  });

  it('formats the live rate in the selected fiat currency', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bitcoin: { usd: 65_432.1, eur: 60_123.45 } }),
    }));

    await expect(getBtcSpotPrice('usd')).resolves.toBe('1 BTC ≈ $65,432.10');
    await expect(getBtcSpotPrice('eur')).resolves.toBe('1 BTC ≈ €60.123,45');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('omits the spot-price line when no rate is available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    await expect(getBtcSpotPrice('usd')).resolves.toBeNull();
  });
});
