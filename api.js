const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { validateTelegramAuth } = require('./auth');
const { callGigaChat } = require('./gigachat');
const { transcribeVoice } = require('./stt');
const router = express.Router();
// ===== КОНСТАНТЫ =====
const FREE_LIMIT = 3;
const PRO_PRICE = 500;
const VIP_PRICE = 800;
const SBP_PHONE = process.env.SBP_PHONE || '+79022231321';
const SBP_RECIPIENT = process.env.SBP_RECIPIENT || 'Ермачкова Алина В.';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 0;
// ===== Папка для чеков =====
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// ===== Multer =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `receipt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
const uploadAudio = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// ===== USER AUTH MIDDLEWARE =====
router.use((req, res, next) => {
  const initData = req.header('x-telegram-init-data');
  if (!initData) return res.status(401).json({ error: 'No initData' });
  const user = validateTelegramAuth(initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Invalid initData' });
  req.telegramUser = user;
  next();
});
// ===== ADMIN AUTH MIDDLEWARE =====
const adminAuth = (req, res, next) => {
  if (!ADMIN_ID) return res.status(403).json({ error: 'Admin not configured' });
  if (req.telegramUser?.id !== ADMIN_ID) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
};
// ===== HELPERS =====
// ===== ЕДИНЫЙ ЗАЩИТНЫЙ БЛОК — вставляется в каждый system-промпт =====
const FOOD_ONLY_GUARD = `
КРИТИЧЕСКОЕ ПРАВИЛО: Ты работаешь ИСКЛЮЧИТЕЛЬНО в сфере еды, кулинарии и напитков. 
Если пользователь спрашивает о чём-либо не связанном с едой, рецептами, кулинарными техниками, продуктами питания или напитками — вежливо откажи и верни разговор к теме еды.
Примеры запрещённых тем: политика, медицина, юриспруденция, финансы, техника, программирование, отношения, история, география и всё остальное не связанное с едой.
Ответ на оффтоп: "Я специализируюсь только на кулинарии 👨‍🍳 Спроси меня о рецептах, ингредиентах или способах приготовления!"
`;

function detectRequestType(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'рецепт', 'приготовь', 'хочу', 'сделай', 'как сделать', 'как приготовить',
    'борщ', 'салат', 'суп', 'паста', 'карбонара', 'омлет', 'плов', 'пюре',
    'котлеты', 'торт', 'десерт', 'пицца', 'блины', 'шашлык', 'гуляш', 'рагу',
    'запеканка', 'каша', 'пирог', 'соус', 'маринад', 'закуска', 'напиток',
    'смузи', 'коктейль', 'чай', 'кофе', 'сок', 'компот', 'варенье', 'джем'
  ];
  if (keywords.some(k => lower.includes(k))) return 'dish';
  if (text.includes(',')) return 'ingredients';
  return 'dish';
}

function buildPrompt(requestType, ingredients, details, planType) {
  const isVIP = planType === 'VIP';
  const isPRO = planType === 'PRO' || isVIP;

  const system = `Ты опытный домашний шеф-повар с профессиональным образованием. Твоя единственная задача — давать подробные, понятные рецепты которые реально работают на домашней кухне.
${FOOD_ONLY_GUARD}
ФОРМАТ РЕЦЕПТА (строго соблюдай):

🍽 [Название блюда] — [одна строка с аппетитным описанием]

📝 О блюде: [2-3 предложения: история/особенность, почему вкусно]

👥 Порций: [N] | ⏱ Подготовка: [X мин] | 🔥 Готовка: [X мин]

🥣 ИНГРЕДИЕНТЫ:
— [продукт] — [точное количество в граммах/штуках/ложках]
— [продукт] — [количество]
(перечисли ВСЕ ингредиенты)

🔥 МЕТОД ПРИГОТОВЛЕНИЯ: [жарка / варка / запекание / тушение и т.д.]
🌡 Температура: [X°C если нужна духовка или точный нагрев]

👨‍🍳 ПОШАГОВЫЙ РЕЦЕПТ:
Шаг 1. [Конкретное действие] — [X мин]
Шаг 2. [Конкретное действие] — [X мин]
Шаг 3. [продолжай нумерацию для всех шагов]
(минимум 5-7 шагов, каждый с временем выполнения)

💡 СОВЕТЫ ШЕФА:
— [практичный лайфхак по технике]
— [как не испортить блюдо]
— [чем можно заменить ингредиент]

🍷 ПОДАЧА: [как красиво подать, с чем сочетается, какой напиток подойдёт]
${isPRO ? '\n📊 КБЖУ НА ПОРЦИЮ: Калории — X ккал | Белки — Xг | Жиры — Xг | Углеводы — Xг' : ''}

ПРАВИЛА:
— Используй только эмодзи из шаблона выше для структуры
— Пиши точные граммы и минуты, не пиши "по вкусу" для основных ингредиентов
— Шаги пиши простым языком как будто объясняешь другу
— Не используй HTML теги и markdown звёздочки **`;

  const user = requestType === 'ingredients'
    ? `Придумай блюдо и дай полный рецепт, используя ТОЛЬКО эти продукты (можно использовать базовые специи и масло): ${ingredients}${details ? `\nДополнительные пожелания: ${details}` : ''}`
    : `Дай полный подробный рецепт: ${ingredients}${details ? `\nДополнительные пожелания: ${details}` : ''}`;

  return { system, user };
}
function parseSteps(fullText) {
  if (!fullText) return ['Текст рецепта не получен.'];
  const stepRegex = /(?:Шаг\s*\d+[.:\s-])|(?:^\d+.\s)/gim;
  const parts = fullText.split(stepRegex).filter(p => p.trim().length > 5);
  if (parts.length >= 2) return parts.map(p => p.trim());
  return fullText.split(/\n\s*\n/).filter(p => p.trim().length > 10);
}
function cleanHtml(text) {
  if (!text) return '';
  let safe = text
    .replace(/`html/gi, '').replace(/`/g, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/ /g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const headings = ['🍽', '📝', '🔥', '👨‍🍳', '🍷', '📊', '⏱', '💡'];
  headings.forEach(emoji => {
    const escaped = emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped}[^\n]+)`, 'g');
    safe = safe.replace(regex, '<b>$1</b>');
  });
  const open = (safe.match(/<b>/g) || []).length;
  const close = (safe.match(/<\/b>/g) || []).length;
  if (open !== close) return safe.replace(/<\/?b>/g, '');
  return safe;
}
// ===== STATUS =====
router.get('/recipe/status', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    res.json({
      subscription: sub || null,
      freeUsed: user?.free_recipes_used || 0,
      freeLimit: FREE_LIMIT,
      prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== GENERATE RECIPE =====
router.post('/recipe/generate', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { ingredients, details } = req.body;
    if (!ingredients) return res.status(400).json({ error: 'No ingredients' });
    await global.pool.query(
      `INSERT INTO users (tg_id, username, first_name, free_recipes_used)
       VALUES ($1,$2,$3,0) ON CONFLICT (tg_id) DO NOTHING`,
      [tgId, req.telegramUser.username, req.telegramUser.first_name]
    );
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    if (!sub && user.free_recipes_used >= FREE_LIMIT) {
      return res.status(403).json({
        error: 'limit_reached',
        message: 'Лимит исчерпан',
        prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
      });
    }
    const planType = sub?.plan_type || 'FREE';
    const requestType = detectRequestType(ingredients);
    const prompt = buildPrompt(requestType, ingredients, details, planType);
    let recipe = await callGigaChat(prompt.system, prompt.user);
    recipe = cleanHtml(recipe);
    const steps = parseSteps(recipe);
    if (!sub) {
      await global.pool.query(
        `UPDATE users SET free_recipes_used = free_recipes_used + 1 WHERE tg_id=$1`,
        [tgId]
      );
    }
    res.json({
      title: (recipe.match(/🍽 [^\n]+/) || ['Твой рецепт'])[0],
      fullText: recipe,
      steps,      total: steps.length
    });
  } catch (e) {
    console.error('Recipe error:', e);
    res.status(500).json({ error: e.message });
  }
});
// ===== STT =====
router.post('/stt/recognize', uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    const text = await transcribeVoice(req.file.buffer);
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== PAYMENT INFO =====
router.get('/payment/info', (req, res) => {
  res.json({
    sbpPhone: SBP_PHONE,
    recipient: SBP_RECIPIENT,
    prices: { PRO: PRO_PRICE, VIP: VIP_PRICE }
  });
});
// ===== UPLOAD RECEIPT =====
router.post('/payment/upload', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const tgId = req.telegramUser.id;
    const { planType } = req.body;
    const amount = planType === 'VIP' ? VIP_PRICE : PRO_PRICE;
    const receiptPath = `/uploads/${req.file.filename}`;
    console.log(`📥 Загрузка чека от ${tgId}:`, req.file.filename);
    const { rows: [payment] } = await global.pool.query(
      `INSERT INTO payments (user_id, amount, receipt_file_path, status, plan_type)
       VALUES ($1,$2,$3,'pending',$4) RETURNING id, created_at`,
      [tgId, amount, receiptPath, planType]
    );
    console.log(`✅ Платёж создан: #${payment.id}`);
    const { rows: [user] } = await global.pool.query(
      `SELECT * FROM users WHERE tg_id=$1`, [tgId]
    );
    const { rows: [currentSub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE LIMIT 1`,
      [tgId]
    );
    if (global.sendPhotoToAdmin) {
      const isNewUser = !currentSub;
      const caption =        `🚨 <b>НОВАЯ ЗАЯВКА #${payment.id}</b>\n\n` +
        `👤 <b>Пользователь:</b>\n` +
        `   • Имя: ${user?.first_name || 'unknown'}\n` +
        `   • Username: @${user?.username || '—'}\n` +
        `   • TG ID: <code>${tgId}</code>\n` +
        `   • Регистрация: ${user?.created_at ? new Date(user.created_at).toLocaleDateString('ru-RU') : '—'}\n\n` +
        `💳 <b>Оплата:</b>\n` +
        `   • Тариф: <b>${planType}</b>\n` +
        `   • Сумма: <b>${amount}₽</b>\n` +
        `   • Статус юзера: ${isNewUser ? '🆕 Новый' : `📅 ${currentSub.plan_type} до ${new Date(currentSub.expires_at).toLocaleDateString('ru-RU')}`}\n\n` +
        `📊 Рецептов создано: ${user?.free_recipes_used || 0}`;
      const keyboard = {
        inline_keyboard: [
          [
            { text: '✅ Одобрить', callback_data: `approve_${payment.id}` },
            { text: '❌ Отклонить', callback_data: `reject_${payment.id}` }
          ],
          [
            { text: '🌐 Веб-админка', web_app: { url: `${process.env.MINI_APP_URL || ''}/admin.html` } }
          ]
        ]
      };
      // 🔥 ИСПРАВЛЕНО: используем абсолютный путь напрямую от multer
      const fullPath = req.file.path;
      console.log('📸 Путь к файлу:', fullPath);
      console.log('📸 Файл существует:', fs.existsSync(fullPath));
      await global.sendPhotoToAdmin(fullPath, caption, keyboard);
      console.log('✅ Чек отправлен админу');
    } else {
      console.error('❌ global.sendPhotoToAdmin не определён!');
    }
    res.json({ paymentId: payment.id, status: 'pending' });
  } catch (e) {
    console.error('❌ Upload error:', e);
    res.status(500).json({ error: e.message });
  }
});
// ===== PROFILE =====
router.get('/user/profile', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    res.json({ user, subscription: sub || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }});
// ===== FULL PROFILE =====
router.get('/user/fullprofile', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [user] } = await global.pool.query(`SELECT * FROM users WHERE tg_id=$1`, [tgId]);
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    const { rows: [{ count }] } = await global.pool.query(
      `SELECT COUNT(*) FROM payments WHERE user_id=$1 AND status='approved'`,
      [tgId]
    );
    res.json({
      user,
      subscription: sub || null,
      approvedPayments: parseInt(count) || 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== VIP: WEEK MENU =====
router.post('/vip/weekmenu', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { prefs, level = 'base', portions = 2 } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }

    const levelInstructions = {
      base: `УРОВЕНЬ МЕНЮ: БАЗОВОЕ (доступное)
Используй ТОЛЬКО простые продукты из любого магазина: яйца, картофель, макароны, гречка, рис, овсянка, курица (бёдра/грудка), фарш, морковь, лук, капуста, свёкла, огурцы, помидоры, молоко, кефир, сметана, твёрдый сыр, сливочное масло, хлеб, консервы (тунец, сайра).
СТРОГО ЗАПРЕЩЕНО: авокадо, лосось, сёмга, киноа, моцарелла, страчателла, руккола, трюфель, пармезан, спаржа, артишоки, тапенада и любые импортные деликатесы. Стоимость одного дня питания не должна превышать 500 рублей на человека.`,
      pro: `УРОВЕНЬ МЕНЮ: ПРОФИ (разнообразное)
Используй разнообразные продукты из обычного супермаркета. Блюда должны быть интересными и вкусными. Разрешено: любая рыба (минтай, горбуша, треска, тилапия), разные виды мяса (свинина, говядина, индейка), свежая зелень, разные виды пасты, бобовые (чечевица, нут), греческий йогурт, творог, разные сыры.`,
      luxury: `УРОВЕНЬ МЕНЮ: ИЗЫСКАННОЕ (ресторанное)
Ресторанный уровень с особыми продуктами и техниками. Разрешено всё: лосось, сёмга, тунец, страчателла, пармезан, авокадо, спаржа, рукола, трюфельное масло, крем-фреш, соус демиглас, конфи, карпаччо. Сложные техники: сувид, фламбе, эмульсии, деглазирование.`
    };

    const system = `Ты профессиональный шеф-повар и сертифицированный нутрициолог. Твоя задача — составить детальное меню питания на РОВНО 7 ДНЕЙ для ${portions} человек с полными пошаговыми рецептами.
${FOOD_ONLY_GUARD}
${levelInstructions[level] || levelInstructions.base}

СТРОГИЙ ФОРМАТ — повторяй ТОЧНО для каждого из 7 дней без исключений:

════════════════════════════
ДЕНЬ 1 — ПОНЕДЕЛЬНИК
════════════════════════════

🌅 ЗАВТРАК: [Название блюда]
🥣 Ингредиенты на ${portions} чел.:
— [продукт] — [количество]
— [продукт] — [количество]
⏱ Время: [X мин] | 🌡 [температура если нужна]
👨‍🍳 Как готовить:
1. [конкретное действие с деталями] — [X мин]
2. [конкретное действие] — [X мин]
3. [конкретное действие] — [X мин]
4. [продолжай до финального шага]
📊 КБЖУ: Калории — X ккал | Белки — Xг | Жиры — Xг | Углеводы — Xг
💡 Совет: [практичный лайфхак — замена ингредиента или техника]

☀️ ОБЕД: [Название блюда]
[та же структура: ингредиенты → время/температура → шаги 1-2-3-4 → КБЖУ → совет]

🌙 УЖИН: [Название блюда]
[та же структура]

🍎 ПЕРЕКУС: [Название]
🥣 Ингредиенты: [список]
👨‍🍳 Приготовление: [2-3 строки]
📊 КБЖУ: Калории — X ккал | Белки — Xг | Жиры — Xг | Углеводы — Xг

📊 ИТОГО ЗА ДЕНЬ: Калории — X ккал | Белки — Xг | Жиры — Xг | Углеводы — Xг

═ (затем ДЕНЬ 2 — ВТОРНИК, ДЕНЬ 3 — СРЕДА и так до ДЕНЬ 7 — ВОСКРЕСЕНЬЕ)

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
1. Все 7 дней обязательны — не сокращай и не пропускай
2. Не повторяй одинаковые блюда в разные дни
3. Ингредиенты с точными граммами и штуками — никаких "по вкусу" для основных продуктов
4. Шаги пиши простым языком как другу — без профессионального жаргона
5. Время приготовления: завтрак до 20 мин, обед/ужин до 45 мин
6. НЕ используй HTML теги, markdown ** или # заголовки`;

    const userMsg = `Предпочтения: ${prefs || 'сбалансированное питание без ограничений'}. Составь меню на все 7 дней без пропусков.`;

    const menu = await callGigaChat(system, userMsg);

    // Чистим markdown артефакты
    const cleanMenu = menu
      .replace(/\*\*/g, '')
      .replace(/\*/g, '')
      .replace(/^#{1,3}\s*/gm, '')
      .replace(/\n{4,}/g, '\n\n\n');

    res.json({ menu: cleanMenu });
  } catch (e) {
    console.error('Week menu error:', e);
    res.status(500).json({ error: e.message });
  }
}); 
// ===== VIP: ФОТО ХОЛОДИЛЬНИКА =====
router.post('/vip/fridge-scan', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }
    const system = `Ты опытный шеф-повар который умеет придумывать блюда из любых продуктов.
${FOOD_ONLY_GUARD}
Пользователь прислал фото своего холодильника. Твоя задача:
1. Определи все видимые продукты
2. Предложи 1 конкретное блюдо которое можно приготовить прямо сейчас
3. Дай короткое описание почему именно это блюдо

ФОРМАТ ОТВЕТА:
🔍 Вижу в холодильнике: [перечисли продукты через запятую]

🍽 Предлагаю приготовить: [НАЗВАНИЕ БЛЮДА]
📝 [2-3 предложения почему это блюдо — вкусно, быстро, из этих продуктов]
⏱ Время: [X минут]

Ответ должен быть коротким и мотивирующим. Не используй HTML и markdown.`;
    const suggestion = await callGigaChat(system, 'Определи продукты на фото и предложи блюдо');
    const dishMatch = suggestion.match(/предлагаю приготовить[:\s]+([^\n]+)/i);
    res.json({ suggestion, dish: dishMatch ? dishMatch[1].trim() : '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== VIP: ЧТО ЕСТЬ В ДОМЕ (текстом) =====
router.post('/vip/rescue-cook', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { ingredients, prefs } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }
    const system = `Ты изобретательный шеф-повар который умеет готовить вкусную еду из минимального набора продуктов. Специализируешься на "спасении ужина" когда холодильник почти пустой.
${FOOD_ONLY_GUARD}
Пользователь перечислит что у него есть дома. Твоя задача — предложить самое вкусное и реалистичное блюдо из этих продуктов.

ФОРМАТ ОТВЕТА:
✨ Из этого можно приготовить: [НАЗВАНИЕ БЛЮДА]

📝 [2-3 предложения: почему это хорошая идея, что получится]
⏱ Время: [X минут] | 👥 Порций: [N]

🥣 Понадобится:
— [из предложенных продуктов] — [количество]
— [базовые специи/масло если нужны]

👨‍🍳 Быстрый рецепт:
1. [шаг]
2. [шаг]
3. [шаг]

💡 [совет как улучшить блюдо или чем дополнить]

Не используй HTML и markdown. Будь конкретным и вдохновляющим.`;
    const userMsg = `Продукты которые есть дома: ${ingredients}${prefs ? `\nОграничения: ${prefs}` : ''}`;
    const suggestion = await callGigaChat(system, userMsg);
    const dishMatch = suggestion.match(/можно приготовить[:\s]+([^\n]+)/i);
    res.json({ suggestion, dish: dishMatch ? dishMatch[1].trim() : '' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== PRO: СПИСОК ПОКУПОК =====
router.post('/recipe/shopping-list', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { recipe } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,
      [tgId]
    );
    if (!sub) return res.status(403).json({ error: 'Только для PRO и VIP' });
    const system = `Ты помощник по кулинарным покупкам. Из текста рецепта извлеки все ингредиенты и верни их структурированным списком.
${FOOD_ONLY_GUARD}
ФОРМАТ ОТВЕТА — только валидный JSON, без пояснений:
{"items": [{"name": "название продукта", "amount": "количество и единица"}, ...]}

Правила:
— Каждый ингредиент отдельным объектом
— name: только название продукта (без количества)
— amount: точное количество с единицей (200г, 2 шт, 3 ст.л.)
— Не дублируй одинаковые продукты — суммируй их
— Не включай воду, соль, перец (они есть у всех)`;
    const raw = await callGigaChat(system, `Извлеки список покупок из рецепта:\n${recipe}`);
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      res.json(parsed);
    } catch {
      res.json({ items: [] });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== VIP: ДИЕТОЛОГ =====
router.post('/vip/diet', async (req, res) => {
  try {
    const tgId = req.telegramUser.id;
    const { question } = req.body;
    const { rows: [sub] } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND is_active=TRUE AND expires_at>NOW() LIMIT 1`,      [tgId]
    );
    if (!sub || sub.plan_type !== 'VIP') {
      return res.status(403).json({ error: 'Только для VIP' });
    }
    const system = `Ты профессиональный диетолог и нутрициолог с 15-летним практическим опытом. Консультируешь по вопросам питания, составу продуктов, диетам и здоровому образу жизни через еду.
${FOOD_ONLY_GUARD}
ФОРМАТ ОТВЕТА:

🥗 [Краткий заголовок ответа]

📋 СУТЬ: [Прямой ответ на вопрос — 2-3 предложения без воды]

📊 ПОДРОБНЕЕ:
[Развёрнутое научно обоснованное объяснение простым языком. Конкретные цифры где уместно.]

✅ ЧТО ДЕЛАТЬ:
— [конкретная рекомендация]
— [конкретная рекомендация]

⚠️ НА ЧТО ОБРАТИТЬ ВНИМАНИЕ:
— [важный нюанс]

🍽 ПРОДУКТЫ/БЛЮДА КОТОРЫЕ ПОМОГУТ:
— [конкретный продукт или блюдо с пояснением]
— [ещё один вариант]

💡 ПРАКТИЧЕСКИЙ СОВЕТ: [один конкретный лайфхак который легко применить]

Правила: пиши простым языком, давай конкретные цифры (граммы, калории, проценты), не используй HTML и markdown звёздочки.`;
    const answer = await callGigaChat(system, question);
    res.json({ answer: cleanHtml(answer) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: СТАТИСТИКА =====
router.get('/admin/stats', adminAuth, async (req, res) => {
  try {
    const { rows: [basic] } = await global.pool.query(`SELECT (SELECT COUNT(*) FROM users) as total_users, (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours') as users_today, (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days') as users_week, (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days') as users_month, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE) as active_subs, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND plan_type='PRO') as pro_subs, (SELECT COUNT(*) FROM subscriptions WHERE is_active=TRUE AND plan_type='VIP') as vip_subs, (SELECT COUNT(*) FROM payments WHERE status='pending') as pending_payments, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved') as total_revenue, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '30 days') as revenue_month, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '7 days') as revenue_week, (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status='approved' AND created_at > NOW() - INTERVAL '24 hours') as revenue_today`);
    const { rows: regChart } = await global.pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    const { rows: revChart } = await global.pool.query(`
      SELECT DATE(created_at) as date, COALESCE(SUM(amount), 0) as revenue, COUNT(*) as count
      FROM payments
      WHERE status='approved' AND created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `);
    const { rows: expiring } = await global.pool.query(`
      SELECT u.first_name, u.username, u.tg_id, s.plan_type, s.expires_at
      FROM subscriptions s
      JOIN users u ON s.user_id = u.tg_id
      WHERE s.is_active = TRUE AND s.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
      ORDER BY s.expires_at ASC
    `);
    res.json({ basic, regChart, revChart, expiring, prices: { PRO: PRO_PRICE, VIP: VIP_PRICE } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ПЛАТЕЖИ =====
router.get('/admin/payments', adminAuth, async (req, res) => {
  try {
    const { status, plan_type, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;
    if (status && status !== 'all') {
      where += ` AND p.status = $${idx++}`;      params.push(status);
    }
    if (plan_type && plan_type !== 'all') {
      where += ` AND p.plan_type = $${idx++}`;
      params.push(plan_type);
    }
    const { rows: payments } = await global.pool.query(
      `SELECT p.*, u.first_name, u.username, u.tg_id
       FROM payments p JOIN users u ON p.user_id = u.tg_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );
    const { rows: [{ total }] } = await global.pool.query(
      `SELECT COUNT(*) as total FROM payments p ${where}`,
      params
    );
    res.json({
      payments,
      total: parseInt(total),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(total) / parseInt(limit))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ПОЛЬЗОВАТЕЛИ =====
router.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const { search, plan, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let where = 'WHERE 1=1';
    const params = [];
    let idx = 1;
    if (search) {
      where += ` AND (u.first_name ILIKE $${idx} OR u.username ILIKE $${idx} OR u.tg_id::text LIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (plan && plan !== 'all') {
      if (plan === 'FREE') {
        where += ` AND s.id IS NULL`;
      } else {
        where += ` AND s.plan_type = $${idx} AND s.is_active = TRUE`;
        params.push(plan);
        idx++;
      }
    }    const { rows: users } = await global.pool.query(
      `SELECT u.*, s.plan_type, s.expires_at, s.is_active,
       (SELECT COUNT(*) FROM payments WHERE user_id = u.tg_id AND status='approved') as total_paid
       FROM users u LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
       ${where} ORDER BY u.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, parseInt(limit), offset]
    );
    const { rows: [{ total }] } = await global.pool.query(
      `SELECT COUNT(*) as total FROM users u LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE ${where}`,
      params
    );
    res.json({
      users,
      total: parseInt(total),
      page: parseInt(page),
      totalPages: Math.ceil(parseInt(total) / parseInt(limit))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ПРОСМОТР ЮЗЕРА =====
router.get('/admin/user/:tgId', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { rows: [user] } = await global.pool.query(
      `SELECT * FROM users WHERE tg_id = $1`, [tgId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { rows: subs } = await global.pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY starts_at DESC`, [tgId]
    );
    const { rows: payments } = await global.pool.query(
      `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC`, [tgId]
    );
    res.json({ user, subscriptions: subs, payments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ВЫДАТЬ ТАРИФ =====
router.post('/admin/user/:tgId/plan', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { planType, days = 30 } = req.body;
    if (!['PRO', 'VIP'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }
    const expiresAt = new Date();    expiresAt.setDate(expiresAt.getDate() + parseInt(days));
    await global.pool.query(
      `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`, [tgId]
    );
    await global.pool.query(
      `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) VALUES ($1, TRUE, $2, $3)`,
      [tgId, expiresAt, planType]
    );
    await global.pool.query(
      `UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`, [tgId]
    );
    try {
      const { Telegraf } = require('telegraf');
      const notifyBot = new Telegraf(process.env.BOT_TOKEN);
      await notifyBot.telegram.sendMessage(
        parseInt(tgId),
        `🎉 <b>Администратор выдал вам ${planType}!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Notify user error:', e.message);
    }
    res.json({ success: true, expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: БАН =====
router.post('/admin/user/:tgId/ban', adminAuth, async (req, res) => {
  try {
    const { tgId } = req.params;
    const { banned = true } = req.body;
    await global.pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_banned') THEN ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE; END IF; END $$;`);
    await global.pool.query(
      `UPDATE users SET is_banned=$1 WHERE tg_id=$2`,
      [banned, tgId]
    );
    if (banned) {
      await global.pool.query(
        `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`,
        [tgId]
      );
    }
    res.json({ success: true, banned });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ОДОБРИТЬ ПЛАТЕЖ =====
router.post('/admin/payment/:id/approve', adminAuth, async (req, res) => {  try {
    const { id } = req.params;
    const { rows: [payment] } = await global.pool.query(
      `SELECT * FROM payments WHERE id=$1`, [id]
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await global.pool.query(
      `UPDATE subscriptions SET is_active=FALSE WHERE user_id=$1`,
      [payment.user_id]
    );
    await global.pool.query(
      `INSERT INTO subscriptions (user_id, is_active, expires_at, plan_type) VALUES ($1, TRUE, $2, $3)`,
      [payment.user_id, expiresAt, payment.plan_type]
    );
    await global.pool.query(
      `UPDATE users SET free_recipes_used=0 WHERE tg_id=$1`,
      [payment.user_id]
    );
    await global.pool.query(
      `UPDATE payments SET status='approved' WHERE id=$1`, [id]
    );
    try {
      const { Telegraf } = require('telegraf');
      const notifyBot = new Telegraf(process.env.BOT_TOKEN);
      await notifyBot.telegram.sendMessage(
        payment.user_id,
        `🎉 <b>${payment.plan_type} активирована!</b>\n📅 До: ${expiresAt.toLocaleDateString('ru-RU')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Notify user error:', e.message);
    }
    res.json({ success: true, expiresAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ОТКЛОНИТЬ ПЛАТЕЖ =====
router.post('/admin/payment/:id/reject', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { rows: [payment] } = await global.pool.query(
      `SELECT * FROM payments WHERE id=$1`, [id]
    );
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    await global.pool.query(
      `UPDATE payments SET status='rejected' WHERE id=$1`, [id]
    );    try {
      const { Telegraf } = require('telegraf');
      const notifyBot = new Telegraf(process.env.BOT_TOKEN);
      await notifyBot.telegram.sendMessage(
        payment.user_id,
        `❌ Оплата отклонена.\n📋 #${payment.id}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('Notify user error:', e.message);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: PENDING =====
router.get('/admin/pending', adminAuth, async (req, res) => {
  try {
    const { rows } = await global.pool.query(`SELECT p.id, u.first_name, u.username, u.tg_id, p.amount, p.plan_type, p.created_at, p.receipt_file_path FROM payments p JOIN users u ON p.user_id = u.tg_id WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 50`);
    res.json({ pending: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ===== ADMIN: ЭКСПОРТ =====
router.get('/admin/export/:type', adminAuth, async (req, res) => {
  try {
    const { type } = req.params;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Chef AI Admin';
    workbook.created = new Date();
    if (type === 'users') {
      const { rows } = await global.pool.query(`
        SELECT u.tg_id, u.username, u.first_name, u.free_recipes_used, u.created_at,
               s.plan_type, s.expires_at, s.is_active
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
        ORDER BY u.created_at DESC
      `);
      const sheet = workbook.addWorksheet('Пользователи');
      sheet.columns = [
        { header: 'TG ID', key: 'tg_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Рецептов', key: 'free_recipes_used', width: 12 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Активен', key: 'is_active', width: 10 },
        { header: 'До', key: 'expires_at', width: 15 },
        { header: 'Регистрация', key: 'created_at', width: 20 }      ];
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
      rows.forEach(r => {
        sheet.addRow({
          tg_id: r.tg_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          free_recipes_used: r.free_recipes_used || 0,
          plan_type: r.plan_type || 'FREE',
          is_active: r.is_active ? '✅' : '❌',
          expires_at: r.expires_at ? new Date(r.expires_at).toLocaleDateString('ru-RU') : '-',
          created_at: new Date(r.created_at).toLocaleString('ru-RU')
        });
      });
    } else if (type === 'payments') {
      const { rows } = await global.pool.query(`
        SELECT p.id, p.user_id, u.username, u.first_name, p.amount, p.plan_type, p.status, p.created_at, p.receipt_file_path
        FROM payments p JOIN users u ON p.user_id = u.tg_id
        ORDER BY p.created_at DESC
      `);
      const sheet = workbook.addWorksheet('Платежи');
      sheet.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'TG ID', key: 'user_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Сумма', key: 'amount', width: 10 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Статус', key: 'status', width: 12 },
        { header: 'Дата', key: 'created_at', width: 20 },
        { header: 'Чек', key: 'receipt_file_path', width: 40 }
      ];
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
      rows.forEach(r => {
        sheet.addRow({
          id: r.id,
          user_id: r.user_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          amount: r.amount,
          plan_type: r.plan_type,
          status: r.status === 'approved' ? '✅ ' + r.status :
                  r.status === 'rejected' ? '❌ ' + r.status : '⏳ ' + r.status,
          created_at: new Date(r.created_at).toLocaleString('ru-RU'),
          receipt_file_path: r.receipt_file_path || '-'
        });
      });
    } else if (type === 'subscriptions') {      const { rows } = await global.pool.query(`
        SELECT s.id, s.user_id, u.username, u.first_name, s.plan_type, s.starts_at, s.expires_at, s.is_active
        FROM subscriptions s JOIN users u ON s.user_id = u.tg_id
        ORDER BY s.starts_at DESC
      `);
      const sheet = workbook.addWorksheet('Подписки');
      sheet.columns = [
        { header: 'ID', key: 'id', width: 8 },
        { header: 'TG ID', key: 'user_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Начало', key: 'starts_at', width: 15 },
        { header: 'Конец', key: 'expires_at', width: 15 },
        { header: 'Активна', key: 'is_active', width: 10 }
      ];
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF667EEA' } };
      rows.forEach(r => {
        sheet.addRow({
          id: r.id,
          user_id: r.user_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          plan_type: r.plan_type,
          starts_at: new Date(r.starts_at).toLocaleDateString('ru-RU'),
          expires_at: new Date(r.expires_at).toLocaleDateString('ru-RU'),
          is_active: r.is_active ? '✅' : '❌'
        });
      });
    } else {
      return res.status(400).json({ error: 'Invalid export type' });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${type}_${new Date().toISOString().split('T')[0]}.xlsx`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});
module.exports = router;
