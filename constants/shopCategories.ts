// constants/shopCategories.ts — SHOP BOOK shop categories (text + emoji only,
// no images in MVP). `id` is what the backend stores in shopbook_shop.category.

export interface ShopCategory {
  id: string;
  label: string;
  icon: string; // emoji
}

export const SHOP_CATEGORIES: ShopCategory[] = [
  { id: 'supermarket', label: 'Super Market', icon: '🛒' },
  { id: 'grocery',     label: 'Grocery',      icon: '🏪' },
  { id: 'vegetable',   label: 'Vegetables',   icon: '🥬' },
  { id: 'fruit',       label: 'Fruits',       icon: '🍎' },
  { id: 'chicken',     label: 'Chicken',      icon: '🍗' },
  { id: 'mutton',      label: 'Mutton',       icon: '🥩' },
  { id: 'fish',        label: 'Fish',         icon: '🐟' },
  { id: 'bakery',      label: 'Bakery',       icon: '🍞' },
  { id: 'dairy',       label: 'Dairy',        icon: '🥛' },
  { id: 'medical',     label: 'Medical',      icon: '💊' },
  { id: 'stationery',  label: 'Stationery',   icon: '✏️' },
  { id: 'hardware',    label: 'Hardware',     icon: '🔧' },
  { id: 'electronics', label: 'Electronics',  icon: '💻' },
  { id: 'pet',         label: 'Pet Shop',     icon: '🐾' },
];

export function categoryLabel(id: string): string {
  return SHOP_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function categoryIcon(id: string): string {
  return SHOP_CATEGORIES.find((c) => c.id === id)?.icon ?? '🏬';
}

export default {};
