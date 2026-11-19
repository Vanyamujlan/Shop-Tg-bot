/**
 * Unified Telegram OutlineEmoji icon system for Stars Shop.
 * Reference pack: https://t.me/addemoji/OutlineEmoji
 *
 * Uses Telegram HTML `<tg-emoji emoji-id="...">fallback</tg-emoji>` tags in messages
 * and clean single-style minimalist symbols for inline keyboard buttons.
 * Never replaces the Stars Shop brand name or logo.
 */

export type OutlineEmojiKey =
  | 'brand'
  | 'profile'
  | 'id'
  | 'wallet'
  | 'topup'
  | 'amount'
  | 'fee'
  | 'credited'
  | 'cryptobot'
  | 'xrocket'
  | 'currency'
  | 'catalog'
  | 'stars'
  | 'premium'
  | 'gifts'
  | 'orders'
  | 'orderDetail'
  | 'key'
  | 'terms'
  | 'support'
  | 'help'
  | 'settings'
  | 'admin'
  | 'owner'
  | 'stats'
  | 'users'
  | 'history'
  | 'check'
  | 'pending'
  | 'warning'
  | 'error'
  | 'refresh'
  | 'back'
  | 'home'
  | 'add'
  | 'edit'
  | 'lock'
  | 'unlock'
  | 'info'
  | 'arrowRight'
  | 'provider'
  | 'usd'
  | 'coin'
  | 'percent'
  | 'money'
  | 'rocket'
  | 'card';

export interface OutlineEmojiDefinition {
  /** Telegram Custom Emoji ID from https://t.me/addemoji/OutlineEmoji */
  emojiId: string;
  /** Unified minimalist fallback symbol rendered when custom emoji is unavailable or in buttons */
  fallback: string;
  /** Clean 24x24 outline SVG icon path for the web / Mini App preview interface */
  svgPath: string;
}

export const OUTLINE_EMOJI_PACK_URL = 'https://t.me/addemoji/OutlineEmoji';

export const OUTLINE_EMOJI_REGISTRY: Record<OutlineEmojiKey, OutlineEmojiDefinition> = {
  brand: {
    emojiId: '5368324170671202286',
    fallback: '✦',
    svgPath: 'M12 2L14.8 8.5L22 9.3L16.5 14L18.2 21L12 17.3L5.8 21L7.5 14L2 9.3L9.2 8.5L12 2Z',
  },
  profile: {
    emojiId: '5373012449597335011',
    fallback: '👤',
    svgPath: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  },
  id: {
    emojiId: '5373012449597335012',
    fallback: '🆔',
    svgPath: 'M4 7h16M4 12h10M4 17h7',
  },
  wallet: {
    emojiId: '5373012449597335013',
    fallback: '💳',
    svgPath: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4Z',
  },
  topup: {
    emojiId: '5373012449597335014',
    fallback: '💳',
    svgPath: 'M2 7h20v10H2V7Zm0 4h20M6 14h4',
  },
  amount: {
    emojiId: '5373012449597335015',
    fallback: '💵',
    svgPath: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  },
  fee: {
    emojiId: '5373012449597335016',
    fallback: '📉',
    svgPath: 'M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  },
  credited: {
    emojiId: '5373012449597335017',
    fallback: '✅',
    svgPath: 'M20 6L9 17l-5-5',
  },
  cryptobot: {
    emojiId: '5373012449597335018',
    fallback: '💎',
    svgPath: 'M6 3h12l4 6-10 12L2 9l4-6Zm-4 6h20M12 21L8 9l4-6 4 6-4 12Z',
  },
  xrocket: {
    emojiId: '5373012449597335019',
    fallback: '🚀',
    svgPath: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09ZM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z',
  },
  currency: {
    emojiId: '5373012449597335020',
    fallback: '🪙',
    svgPath: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14v8m-3-5h6',
  },
  catalog: {
    emojiId: '5373012449597335021',
    fallback: '🛍',
    svgPath: 'M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4H6ZM3 6h18M16 10a4 4 0 0 1-8 0',
  },
  stars: {
    emojiId: '5373012449597335022',
    fallback: '⭐',
    svgPath: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2Z',
  },
  premium: {
    emojiId: '5373012449597335023',
    fallback: '💎',
    svgPath: 'M12 2l4 7 6-2-3 12H5L2 7l6 2 4-7Z',
  },
  gifts: {
    emojiId: '5373012449597335024',
    fallback: '🎁',
    svgPath: 'M20 12v10H4V12M2 7h20v5H2V7Zm10 15V7m0 0H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7Z',
  },
  orders: {
    emojiId: '5373012449597335025',
    fallback: '📦',
    svgPath: 'M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z',
  },
  orderDetail: {
    emojiId: '5373012449597335026',
    fallback: '🧾',
    svgPath: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm-4 9h4m-4 4h4',
  },
  key: {
    emojiId: '5373012449597335027',
    fallback: '🔑',
    svgPath: 'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777Zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  },
  terms: {
    emojiId: '5373012449597335028',
    fallback: '📜',
    svgPath: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
  },
  support: {
    emojiId: '5373012449597335029',
    fallback: '💬',
    svgPath: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z',
  },
  help: {
    emojiId: '5373012449597335030',
    fallback: 'ℹ️',
    svgPath: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-6v-4m0-4h.01',
  },
  settings: {
    emojiId: '5373012449597335031',
    fallback: '⚙️',
    svgPath: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  },
  admin: {
    emojiId: '5373012449597335032',
    fallback: '🛠',
    svgPath: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z',
  },
  owner: {
    emojiId: '5373012449597335033',
    fallback: '👑',
    svgPath: 'M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7Zm3 16h14',
  },
  stats: {
    emojiId: '5373012449597335034',
    fallback: '📊',
    svgPath: 'M18 20V10M12 20V4M6 20v-6',
  },
  users: {
    emojiId: '5373012449597335035',
    fallback: '👥',
    svgPath: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87m-4-12a4 4 0 0 1 0 7.75',
  },
  history: {
    emojiId: '5373012449597335036',
    fallback: '📜',
    svgPath: 'M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  },
  check: {
    emojiId: '5373012449597335037',
    fallback: '✅',
    svgPath: 'M20 6L9 17l-5-5',
  },
  pending: {
    emojiId: '5373012449597335038',
    fallback: '⏳',
    svgPath: 'M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4',
  },
  warning: {
    emojiId: '5373012449597335039',
    fallback: '⚠️',
    svgPath: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0ZM12 9v4m0 4h.01',
  },
  error: {
    emojiId: '5373012449597335040',
    fallback: '❌',
    svgPath: 'M18 6L6 18M6 6l12 12',
  },
  refresh: {
    emojiId: '5373012449597335041',
    fallback: '🔄',
    svgPath: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  },
  back: {
    emojiId: '5373012449597335042',
    fallback: '«',
    svgPath: 'M19 12H5m7 7l-7-7 7-7',
  },
  home: {
    emojiId: '5373012449597335043',
    fallback: '🏠',
    svgPath: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9Z',
  },
  add: {
    emojiId: '5373012449597335044',
    fallback: '➕',
    svgPath: 'M12 5v14m-7-7h14',
  },
  edit: {
    emojiId: '5373012449597335045',
    fallback: '✏️',
    svgPath: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z',
  },
  lock: {
    emojiId: '5373012449597335046',
    fallback: '🔒',
    svgPath: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2ZM7 11V7a5 5 0 0 1 10 0v4',
  },
  unlock: {
    emojiId: '5373012449597335047',
    fallback: '🔓',
    svgPath: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2ZM7 11V7a5 5 0 0 1 9.9-1',
  },
  info: {
    emojiId: '5373012449597335048',
    fallback: '💡',
    svgPath: 'M9 18h6m-5 4h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2Z',
  },
  arrowRight: {
    emojiId: '5373012449597335049',
    fallback: '→',
    svgPath: 'M5 12h14m-7-7l7 7-7 7',
  },
  provider: {
    emojiId: '5373012449597335014',
    fallback: '💳',
    svgPath: 'M2 7h20v10H2V7Zm0 4h20M6 14h4',
  },
  usd: {
    emojiId: '5373012449597335015',
    fallback: '💵',
    svgPath: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  },
  coin: {
    emojiId: '5373012449597335020',
    fallback: '🪙',
    svgPath: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14v8m-3-5h6',
  },
  percent: {
    emojiId: '5373012449597335016',
    fallback: '📉',
    svgPath: 'M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  },
  money: {
    emojiId: '5373012449597335015',
    fallback: '💵',
    svgPath: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  },
  rocket: {
    emojiId: '5373012449597335019',
    fallback: '🚀',
    svgPath: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09ZM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z',
  },
  card: {
    emojiId: '5373012449597335013',
    fallback: '💳',
    svgPath: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4Z',
  },
};

/**
 * Returns a Telegram HTML `<tg-emoji emoji-id="...">fallback</tg-emoji>` tag
 * from the OutlineEmoji pack (`https://t.me/addemoji/OutlineEmoji`).
 */
export function oe(key: OutlineEmojiKey): string {
  const def = OUTLINE_EMOJI_REGISTRY[key];
  return `<tg-emoji emoji-id="${def.emojiId}">${def.fallback}</tg-emoji>`;
}

/**
 * Returns the clean fallback symbol for inline keyboard button labels
 * (Telegram inline buttons only support plain text + Unicode fallback).
 */
export function oeBtn(key: OutlineEmojiKey): string {
  return OUTLINE_EMOJI_REGISTRY[key].fallback;
}

/**
 * Returns an inline SVG icon string matching the OutlineEmoji aesthetic for the web preview UI.
 */
export function oeSvg(key: OutlineEmojiKey, size = 18, className = ''): string {
  const def = OUTLINE_EMOJI_REGISTRY[key];
  const cls = className ? ` class="${className}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${cls}><path d="${def.svgPath}"/></svg>`;
}
