/**
 * Shared formatting utilities used across components.
 */

/** Conversion rate: 1 Kiro credit = 0.04 EUR */
const CREDITS_TO_EUR = 0.04;

/**
 * Format a credits value with its EUR equivalent.
 * Returns a string like "2.50 credits (€0.100)" or "0.35 credits (€0.0140)".
 *
 * - Credits < 10 are shown with 2 decimal places, otherwise rounded.
 * - EUR < 0.01 is shown with 4 decimal places, otherwise 3.
 */
export function formatCreditsWithEur(credits: number): { creditsStr: string; eurStr: string } {
  const eur = credits * CREDITS_TO_EUR;
  const creditsStr = credits < 10 ? credits.toFixed(2) : Math.round(credits).toString();
  const eurStr = eur < 0.01 ? eur.toFixed(4) : eur.toFixed(3);
  return { creditsStr, eurStr };
}
