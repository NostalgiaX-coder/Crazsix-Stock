import { money } from './preorders.js';

// Stored profit is the original margin after costs, shipping and commission.
// Derive the personal allocation on read so historical sales and shipping edits
// use the same rule without migrations or deducting it twice.
export function personalUseAmount(sale) {
  return money((sale.amount || 0) * (sale.personalUsePercent || 0) / 100);
}
export function saleProfit(sale) {
  return money((sale.profit || 0) - personalUseAmount(sale));
}
