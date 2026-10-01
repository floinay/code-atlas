import type { EdgeKind, ElementKind, FeedEntry, WorkerElement } from '@code-atlas/model';

type Plural = [one: string, few: string, many: string];

export const KINDS: Record<ElementKind, { label: string; plural: Plural }> = {
  worker: { label: 'Worker', plural: ['воркер', 'воркери', 'воркерів'] },
  query: { label: 'Query', plural: ['запит', 'запити', 'запитів'] },
  command: { label: 'Command', plural: ['команда', 'команди', 'команд'] },
  aggregate: { label: 'Aggregate', plural: ['агрегат', 'агрегати', 'агрегатів'] },
  event: { label: 'Event', plural: ['подія', 'події', 'подій'] },
  projection: { label: 'Projection', plural: ['проєкція', 'проєкції', 'проєкцій'] },
  table: { label: 'Table', plural: ['таблиця', 'таблиці', 'таблиць'] },
  subscription: { label: 'Subscription', plural: ['підписка', 'підписки', 'підписок'] },
  external: { label: 'Зовнішнє', plural: ['сусід', 'сусіди', 'сусідів'] },
};

/** Sidebar order: entry points first, then the write model, then the read model. */
export const KIND_ORDER: ElementKind[] = [
  'command',
  'query',
  'subscription',
  'worker',
  'aggregate',
  'event',
  'projection',
  'table',
];
export const CHAIN_ORDER: ElementKind[] = [
  'worker',
  'command',
  'query',
  'aggregate',
  'event',
  'projection',
  'table',
  'subscription',
  'external',
];
export const LANE_TITLES = [
  'Воркери',
  'Запити',
  'Команди',
  'Агрегати',
  'Події',
  'Проєкції',
  'Таблиці',
  'Підписки',
];

export function plural(n: number, [one, few, many]: Plural): string {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}
export const count = (n: number, kind: ElementKind) => `${n} ${plural(n, KINDS[kind].plural)}`;

export const REL_OUT: Record<EdgeKind, string> = {
  decides: 'Змінює стан',
  emits: 'Породжує',
  handles: 'Потрапляє в',
  writes: 'Пише в',
  reads: 'Звідси читають',
  calls: 'Викликає',
  streams: 'Транслюється в',
};
export const REL_IN: Record<EdgeKind, string> = {
  decides: 'Змінюють',
  emits: 'Походить з',
  handles: 'Слухає',
  writes: 'Заповнює',
  reads: 'Читає з',
  calls: 'Викликають',
  streams: 'Джерело',
};

export const TRIGGER: Record<WorkerElement['trigger'], string> = {
  loop: 'фоновий цикл',
  startup: 'під час старту',
  migration: 'одноразова міграція',
  schedule: 'за розкладом',
  event: 'у відповідь на подію',
};

export const t = {
  searchPlaceholder: 'Знайти команду, подію, таблицю, тип…',
  searchLabel: 'Пошук елементів',
  nothingFound: 'Нічого не знайдено',
  showSidebar: 'Показати бічну панель',
  theme: 'Перемкнути тему',
  elements: 'Елементи',
  domains: 'Домени',
  links: 'Зв’язки',
  legendWrite: 'запис і потік подій',
  legendRead: 'читання',
  legendCall: 'виклик контракту',
  hint: 'Наведи на елемент, щоб побачити весь ланцюжок. Клік відкриває типи, entity і колонки. Назви лишаються читабельними на будь-якому масштабі.',
  map: 'Карта архітектури',
  zoomIn: 'Наблизити',
  zoomOut: 'Віддалити',
  fitAll: 'Усе',
  feed: 'Живі оновлення',
  clearNew: 'Зняти позначки',
  close: 'Закрити',
  live: 'живе',
  offline: 'немає зв’язку',
  demo: 'демо',
  snapshot: 'знімок',
  demoRun: 'Агент додає фічу',
  demoReset: 'Скинути демо',
  newBadge: 'НОВЕ',
  external: 'зовнішнє',
  externalSystem: 'Зовнішня система',
  collapsedDomain: 'Домен · згорнутий',
  outside: 'поза дослідженими доменами',
  call: 'Виклик',
  internalContract: 'внутрішній контракт',
  permission: 'Дозвіл',
  trigger: 'Запуск',
  storage: 'Зберігання',
  stream: 'стрім',
  accepts: 'Приймає',
  returns: 'Повертає',
  errors: 'Помилки',
  state: 'Стан',
  payload: 'Payload',
  streamRow: 'Рядок потоку',
  entity: 'Entity',
  searchFields: 'Пошук',
  consumer: 'Consumer',
  structure: 'Структура',
  column: 'Колонка',
  type: 'Тип',
  notNull: 'not null',
  dataFlow: 'Потік даних',
  listens: 'Слухає',
  writes: 'Пише в',
  streamsTo: 'Транслюється в',
  readBy: 'Читають',
  appends: 'Пише події',
  direct: 'Прямі зв’язки',
  affects: 'На що впливає',
  comesFrom: 'Звідки береться',
  code: 'Код',
  emptyObject: 'порожній обʼєкт',
  checkTitle: 'Перевірка архітектури.',
  andMore: (n: number) => `та ще ${n}`,
  bundleTitle: (n: number) =>
    `${n} ${plural(n, ['роут', 'роути', 'роутів'])} в одному вузлі`,
  bundleDescription: (n: number, kind: ElementKind) =>
    `${n} ${plural(n, KINDS[kind].plural)} з однаковими зв’язками і однаковою відповіддю згорнуті в один вузол.`,
  checkMessage: (event: string, aggregate: string, consumers: string[], siblings: number) =>
    `${consumers.join(', ')} ${consumers.length > 1 ? 'обробляють' : 'обробляє'} всі ${siblings} інших подій ${aggregate}, але не ${event}.`,
};

/** A feed entry as a sentence. The server sends data, the sentence is ours. */
export function feedText(entry: FeedEntry): string {
  const s = entry.subject;
  switch (s.type) {
    case 'extracted':
      return `Модель зібрана з коду: ${s.domains} ${plural(s.domains, ['домен', 'домени', 'доменів'])}, ${s.elements} ${plural(s.elements, ['елемент', 'елементи', 'елементів'])}, ${s.edges} ${plural(s.edges, ['зв’язок', 'зв’язки', 'зв’язків'])}${s.ms ? ` · ${s.ms} мс` : ''}`;
    case 'watching':
      return 'Стежу за змінами файлів';
    case 'element': {
      const kind = KINDS[s.kind as ElementKind]?.plural[0] ?? s.kind;
      const sign = entry.kind === 'remove' ? '−' : entry.kind === 'change' ? '~' : '+';
      return `${sign} ${kind} ${s.label}`;
    }
    case 'edge':
      return `${entry.kind === 'remove' ? '−' : '+'} ${s.source} → ${s.target}`;
    case 'check':
      return t.checkMessage(s.event, s.aggregate, s.consumers, s.siblings);
    case 'files':
      return `Змінено ${s.count} ${plural(s.count, ['файл', 'файли', 'файлів'])}, модель без змін`;
    case 'error':
      return `Помилка: ${s.message}`;
    case 'note':
      return s.text;
  }
}
