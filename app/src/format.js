const YOCTO = 10n ** 24n;
/** One epoch is 43,200 blocks, measured at about 0.58 seconds each. */
export const HOURS_PER_EPOCH = 7;

export function near(yocto, digits = 2) {
  const value = BigInt(yocto ?? 0);
  const scale = 10n ** BigInt(24 - digits);
  const whole = value / YOCTO;
  const fraction = ((value % YOCTO) / scale).toString().padStart(digits, '0');
  return `${whole.toLocaleString('en-US')}${digits ? `.${fraction}` : ''}`;
}

export const toYocto = (text) => {
  const [whole, fraction = ''] = String(text).trim().split('.');
  return (BigInt(whole || '0') * YOCTO + BigInt(fraction.padEnd(24, '0').slice(0, 24) || '0')).toString();
};

export const worthOf = (b) => BigInt(b.staked) + BigInt(b.unstaked) + BigInt(b.liquid);

export function waitText(epochs) {
  const count = Number(epochs);
  if (count <= 0) return 'now';
  const hours = count * HOURS_PER_EPOCH;
  return hours >= 36 ? `about ${(hours / 24).toFixed(1)} days` : `about ${Math.round(hours)} hours`;
}

/** Discount to what the position holds, in percent. */
export function discount(worth, price) {
  const value = BigInt(worth);
  if (value === 0n) return 0;
  return Number(((value - BigInt(price)) * 100000n) / value) / 1000;
}

export const shortName = (id) => id?.split('.')[0] ?? '';
export const shortAccount = (id) => (id?.length > 26 ? `${id.slice(0, 12)}…${id.slice(-10)}` : id);

export function dateText(ns) {
  return new Date(Number(BigInt(ns) / 1000000n)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const statusTone = (status) => ({ Staked: 'green', Unbonding: 'amber', 'Ready to withdraw': 'sky', 'Ready to claim': 'sky', Moving: 'violet', Empty: 'grey' })[status] ?? 'grey';
export const statusLabel = (status) => (status === 'Unbonding' ? 'Unstaking' : status);

export const ENTRY_TEXT = {
  Minted: 'Created',
  Staked: 'Staked',
  StakeReturned: 'Stake returned to vault',
  UnbondingStarted: 'Unstaking started',
  Withdrawn: 'Unstaked NEAR withdrawn',
  Paid: 'Paid to holder',
  Listed: 'Listed for sale',
  Delisted: 'Taken off sale',
  Sold: 'Sold',
  Transferred: 'Transferred',
};

export function explainError(result) {
  const text = result?.error ?? result?.failures?.[0]?.error ?? '';
  if (/mid-operation/.test(text)) return 'Another action on this Baton is still finishing. Try again in a moment.';
  if (/current holder/.test(text)) return 'Only the current holder can do that.';
  if (/not for sale/.test(text)) return 'This Baton is no longer for sale.';
  if (/listing has changed/.test(text)) return 'The listing changed before your purchase went through, so nothing was charged.';
  if (/below the price/.test(text)) return 'The amount attached is below the price.';
  if (/official factory/.test(text)) return 'That is not an official staking pool.';
  if (/Attach at least/.test(text)) return text.match(/Attach at least [\d.]+ NEAR/)[0];
  return text ? text.slice(0, 200) : 'The transaction did not go through.';
}
