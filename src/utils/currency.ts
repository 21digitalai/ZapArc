// Currency conversion utilities for BTC/sats ↔ USD/EUR
// Fetches live rates from CoinGecko with 2-minute caching

export type FiatCurrency = 'usd' | 'eur';

interface CachedRate {
  usd: number;
  eur: number;
  fetchedAt: number;
}

class CurrencyService {
  private cache: CachedRate | null = null;
  private readonly CACHE_TTL_MS = 120_000; // 2 minutes (extension is shorter-lived than mobile)
  private fetchPromise: Promise<void> | null = null;

  /**
   * Fetch both USD and EUR rates from CoinGecko
   * Uses in-flight deduplication to avoid parallel requests
   */
  private async fetchRates(): Promise<void> {
    // If a fetch is already in progress, wait for it
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    this.fetchPromise = (async () => {
      try {
        const response = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur',
          { method: 'GET' }
        );
        
        if (!response.ok) {
          throw new Error(`CoinGecko API error: ${response.status}`);
        }

        const data = await response.json();
        const usd = Number(data?.bitcoin?.usd);
        const eur = Number(data?.bitcoin?.eur);

        if (usd > 0 && eur > 0) {
          this.cache = {
            usd,
            eur,
            fetchedAt: Date.now(),
          };
        } else {
          throw new Error('Invalid rate data from CoinGecko');
        }
      } catch (error) {
        console.warn('[Currency] Failed to fetch rates:', error);
        // Keep stale cache if available
      } finally {
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  /**
   * Get the current rate for a given currency
   * Returns null if rate is unavailable
   */
  async getRate(currency: FiatCurrency): Promise<number | null> {
    // Check if cache is valid
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      return this.cache[currency];
    }

    // Fetch fresh rates
    await this.fetchRates();
    
    return this.cache ? this.cache[currency] : null;
  }

  /**
   * Get both rates at once (for efficiency)
   */
  async getRates(): Promise<{ usd: number; eur: number } | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      return { usd: this.cache.usd, eur: this.cache.eur };
    }

    await this.fetchRates();
    
    return this.cache ? { usd: this.cache.usd, eur: this.cache.eur } : null;
  }

  /**
   * Convert satoshis to fiat amount
   * @param sats - Amount in satoshis
   * @param currency - Target fiat currency ('usd' | 'eur')
   * @returns Fiat amount or null if rate unavailable
   */
  async satsToFiat(sats: number, currency: FiatCurrency): Promise<number | null> {
    const rate = await this.getRate(currency);
    if (!rate) return null;
    
    const btc = sats / 100_000_000;
    return btc * rate;
  }

  /**
   * Convert fiat amount to satoshis
   * @param amount - Fiat amount
   * @param currency - Source fiat currency ('usd' | 'eur')
   * @returns Amount in satoshis (rounded) or null if rate unavailable
   */
  async fiatToSats(amount: number, currency: FiatCurrency): Promise<number | null> {
    const rate = await this.getRate(currency);
    if (!rate) return null;
    
    const btc = amount / rate;
    return Math.round(btc * 100_000_000);
  }

  /**
   * Format fiat amount with proper currency symbol
   * @param amount - Fiat amount
   * @param currency - Currency to format as
   * @returns Formatted string (e.g., "$1,234.56" or "€1.234,56")
   */
  formatFiat(amount: number, currency: FiatCurrency): string {
    const symbol = currency === 'usd' ? '$' : '€';
    
    // EUR uses comma as decimal separator in many locales, USD uses period
    if (currency === 'eur') {
      // Format as EUR style: €1.234,56
      const formatted = amount.toFixed(2);
      const parts = formatted.split('.');
      const integerPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      const decimalPart = parts[1];
      return `${symbol}${integerPart},${decimalPart}`;
    } else {
      // Format as USD style: $1,234.56
      return `${symbol}${amount.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
  }

  /**
   * Format satoshis with thousands separator
   * @param sats - Amount in satoshis
   * @returns Formatted string (e.g., "50,000 sats")
   */
  formatSats(sats: number): string {
    return `${sats.toLocaleString()} sats`;
  }

  /**
   * Format with fiat equivalent
   * @param sats - Amount in satoshis
   * @param currency - Target currency
   * @returns Formatted string (e.g., "50,000 sats (≈ $45.00)")
   */
  async formatWithFiat(sats: number, currency: FiatCurrency): Promise<string> {
    const fiatAmount = await this.satsToFiat(sats, currency);
    const satsFormatted = this.formatSats(sats);
    
    if (fiatAmount === null) {
      return satsFormatted;
    }
    
    const fiatFormatted = this.formatFiat(fiatAmount, currency);
    return `${satsFormatted} (≈ ${fiatFormatted})`;
  }

  /**
   * Format the current BTC spot price in the user's preferred fiat currency.
   */
  async getBtcSpotPrice(currency: FiatCurrency): Promise<string | null> {
    const rate = await this.getRate(currency);
    if (!rate) return null;

    return `1 BTC ≈ ${this.formatFiat(rate, currency)}`;
  }

  /**
   * Clear the rate cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cache = null;
  }
}

// Export singleton instance
export const currencyService = new CurrencyService();

// Export convenience functions
export const satsToFiat = (sats: number, currency: FiatCurrency) => 
  currencyService.satsToFiat(sats, currency);

export const fiatToSats = (amount: number, currency: FiatCurrency) => 
  currencyService.fiatToSats(amount, currency);

export const formatFiat = (amount: number, currency: FiatCurrency) => 
  currencyService.formatFiat(amount, currency);

export const formatSats = (sats: number) => 
  currencyService.formatSats(sats);

export const formatWithFiat = (sats: number, currency: FiatCurrency) => 
  currencyService.formatWithFiat(sats, currency);

export const getBtcSpotPrice = (currency: FiatCurrency) =>
  currencyService.getBtcSpotPrice(currency);

export const getRate = (currency: FiatCurrency) => 
  currencyService.getRate(currency);

export const getRates = () => 
  currencyService.getRates();

export function formatSelectedCurrencyAmount(
  amount: string,
  enteredCurrency: 'sats' | FiatCurrency,
  defaultFiat: FiatCurrency
): string | null {
  if (!amount || enteredCurrency === 'sats' || enteredCurrency === defaultFiat) return null;
  return `Selected amount: ${amount} ${enteredCurrency.toUpperCase()}`;
}
