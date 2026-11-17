import { Product, ProductCategory, OrderStatus } from './types.ts';

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  stars: '⭐ Telegram Stars',
  premium: '💎 Telegram Premium',
  gifts: '🎁 Telegram Gifts',
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '⏳ Ожидает оплаты',
  paid: '✅ Оплачен (ожидает выдачи)',
  processing: '🔄 В обработке у администратора',
  completed: '🎉 Выполнен (товар выдан)',
  cancelled: '❌ Отменён',
  refunded: '↩️ Возврат средств (Stars)',
  failed: '⚠️ Ошибка заказа',
};

export const INITIAL_TEST_PRODUCTS: Omit<Product, 'createdAt' | 'updatedAt'>[] = [
  {
    id: 'stars_pack_50',
    name: 'Пакет 50 Telegram Stars (Тест)',
    category: 'stars',
    description:
      'Пополнение баланса Telegram Stars (50 ⭐). Тестовая позиция каталога — администратор может изменить цену в админ-панели.',
    price: 10,
    currency: 'XTR',
    imageUrl: '',
    isActive: true,
    fulfillmentType: 'manual',
  },
  {
    id: 'stars_pack_250',
    name: 'Пакет 250 Telegram Stars (Тест)',
    category: 'stars',
    description:
      'Пополнение баланса Telegram Stars (250 ⭐). Выдача выполняется после подтверждения оплаты.',
    price: 50,
    currency: 'XTR',
    imageUrl: '',
    isActive: true,
    fulfillmentType: 'manual',
  },
  {
    id: 'premium_3m',
    name: 'Telegram Premium — 3 месяца (Тест)',
    category: 'premium',
    description:
      'Подписка Telegram Premium на 3 месяца для вашего аккаунта. Тестовая цена для проверки оплаты и выдачи.',
    price: 100,
    currency: 'XTR',
    imageUrl: '',
    isActive: true,
    fulfillmentType: 'manual',
  },
  {
    id: 'premium_12m',
    name: 'Telegram Premium — 12 месяцев (Тест)',
    category: 'premium',
    description:
      'Годовая подписка Telegram Premium со всеми привилегиями. Выдаётся администратором после оплаты.',
    price: 300,
    currency: 'XTR',
    imageUrl: '',
    isActive: true,
    fulfillmentType: 'manual',
  },
  {
    id: 'gift_star_box',
    name: 'Коллекционный подарок «Звёздный Кубок» (Тест)',
    category: 'gifts',
    description:
      'Эксклюзивный цифровой подарок Telegram Gift для отправки на профиль. Тестовая запись каталога.',
    price: 25,
    currency: 'XTR',
    imageUrl: '',
    isActive: true,
    fulfillmentType: 'manual',
  },
  {
    id: 'gift_crystal_rose',
    name: 'Подарок «Хрустальная Роза» (Тест)',
    category: 'gifts',
    description:
      'Редкий анимированный подарок Telegram Gift с персональной подписью при отправке.',
    price: 75,
    currency: 'XTR',
    imageUrl: '',
    isActive: true,
    fulfillmentType: 'manual',
  },
];
