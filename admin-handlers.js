const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

module.exports = (bot, pool, ADMIN_ID) => {
  if (!ADMIN_ID) return;
  console.log(`✅ Admin handlers loaded (ID: ${ADMIN_ID})`);

  // ===== АДМИН /start =====
  bot.start(async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    try {
      const { rows: stats } = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM users) as users,
          (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as subs,
          (SELECT COUNT(*) FROM payments WHERE status = 'pending') as pending
      `);
      
      const msg = `👨‍💼 <b>Панель администратора</b>\n\n` +
        `📊 <b>Статистика:</b>\n` +
        `• 👥 Пользователей: ${stats[0].users}\n` +
        `• 💎 Активных подписок: ${stats[0].subs}\n` +
        `• ⏳ Ожидающих оплат: ${stats[0].pending}\n\n` +
        `💳 Одобрение оплат — через кнопки под фото чека в этом чате.`;
      
      await ctx.reply(msg, { 
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '📋 Ожидающие оплаты', callback_data: 'admin_pending' }],
            [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
            [{ text: '📋 Все платежи', callback_data: 'admin_payments' }],
            [{ text: '👥 Все пользователи', callback_data: 'admin_users' }],
            [{ text: '📝 Экспорт в Excel', callback_data: 'admin_export' }],
            [{ text: '🌐 Веб-админка', web_app: { url: `${process.env.MINI_APP_URL}/admin.html` } }]
          ]
        }
      });
    } catch (e) {
      ctx.reply('❌ Ошибка: ' + e.message);
    }
  });

  // ===== КНОПКИ АДМИНА =====
  bot.action('admin_pending', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      const { rows } = await pool.query(`        SELECT p.id, u.first_name, u.username, p.amount, p.plan_type, p.created_at
        FROM payments p 
        JOIN users u ON p.user_id = u.tg_id 
        WHERE p.status = 'pending' 
        ORDER BY p.created_at DESC 
        LIMIT 10
      `);
      
      if (rows.length === 0) return ctx.answerCbQuery('✅ Нет ожидающих оплат');
      
      let msg = `📋 <b>Ожидающие оплаты (${rows.length}):</b>\n\n`;
      rows.forEach(r => {
        msg += `<b>#${r.id}</b> — ${r.first_name} (@${r.username || '-'})\n`;
        msg += `💎 ${r.plan_type} | 💰 ${r.amount}₽\n\n`;
      });
      ctx.editMessageText(msg, { parse_mode: 'HTML' });
    } catch (e) {
      ctx.answerCbQuery('❌ Ошибка: ' + e.message);
    }
  });

  bot.action('admin_stats', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      const { rows: stats } = await pool.query(`
        SELECT 
          (SELECT COUNT(*) FROM users) as total,
          (SELECT COUNT(*) FROM subscriptions WHERE is_active = TRUE) as active,
          (SELECT SUM(amount) FROM payments WHERE status = 'approved') as revenue
      `);
      ctx.editMessageText(
        `📊 <b>Статистика:</b>\n👥 ${stats[0].total}\n💎 ${stats[0].active}\n💰 ${stats[0].revenue || 0}₽`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      ctx.answerCbQuery('❌ Ошибка');
    }
  });

  bot.action('admin_payments', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      const { rows } = await pool.query(`
        SELECT p.id, u.first_name, u.username, p.amount, p.plan_type, p.status, p.created_at
        FROM payments p 
        JOIN users u ON p.user_id = u.tg_id 
        ORDER BY p.created_at DESC 
        LIMIT 5
      `);
            if (rows.length === 0) return ctx.answerCbQuery('✅ Нет платежей');
      
      let msg = `📋 <b>Последние платежи (${rows.length}):</b>\n\n`;
      rows.forEach(r => {
        const status = r.status === 'approved' ? '✅' : r.status === 'rejected' ? '❌' : '⏳';
        msg += `${status} #${r.id} — ${r.first_name} (@${r.username || '-'})\n`;
        msg += `💎 ${r.plan_type} | 💰 ${r.amount}₽ | ${r.status}\n\n`;
      });
      ctx.editMessageText(msg, { parse_mode: 'HTML' });
    } catch (e) {
      ctx.answerCbQuery('❌ Ошибка: ' + e.message);
    }
  });

  bot.action('admin_users', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      const { rows } = await pool.query(`
        SELECT u.tg_id, u.first_name, u.username, s.plan_type, s.expires_at, s.is_active
        FROM users u 
        LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE
        ORDER BY u.created_at DESC 
        LIMIT 5
      `);
      
      if (rows.length === 0) return ctx.answerCbQuery('✅ Нет пользователей');
      
      let msg = `👥 <b>Последние пользователи (${rows.length}):</b>\n\n`;
      rows.forEach(r => {
        const status = r.is_active ? '✅' : '❌';
        const plan = r.plan_type || 'FREE';
        const expires = r.expires_at ? new Date(r.expires_at).toLocaleDateString('ru-RU') : '—';
        msg += `👤 ${r.first_name} (@${r.username || '-'})\n`;
        msg += `💡 ${status} | 💎 ${plan} | ⏳ До: ${expires}\n\n`;
      });
      ctx.editMessageText(msg, { parse_mode: 'HTML' });
    } catch (e) {
      ctx.answerCbQuery('❌ Ошибка: ' + e.message);
    }
  });

  bot.action('admin_export', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery('🔒', { show_alert: true });
    try {
      await ctx.answerCbQuery('⏳ Генерирую Excel...', { show_alert: true });
      const { rows } = await pool.query(`
        SELECT u.tg_id, u.username, u.first_name, u.created_at,
               s.plan_type, s.expires_at, s.is_active
        FROM users u
        LEFT JOIN subscriptions s ON s.user_id = u.tg_id AND s.is_active = TRUE        ORDER BY u.created_at DESC
      `);
      
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Users');
      
      sheet.columns = [
        { header: 'TG ID', key: 'tg_id', width: 15 },
        { header: 'Username', key: 'username', width: 20 },
        { header: 'Имя', key: 'first_name', width: 20 },
        { header: 'Тариф', key: 'plan_type', width: 10 },
        { header: 'Активен', key: 'is_active', width: 10 },
        { header: 'До', key: 'expires_at', width: 15 },
        { header: 'Регистрация', key: 'created_at', width: 20 }
      ];
      
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF667EEA' }
      };
      
      rows.forEach(r => {
        sheet.addRow({
          tg_id: r.tg_id,
          username: r.username || '-',
          first_name: r.first_name || '-',
          plan_type: r.plan_type || 'FREE',
          is_active: r.is_active ? '✅' : '❌',
          expires_at: r.expires_at ? new Date(r.expires_at).toLocaleDateString('ru-RU') : '-',
          created_at: new Date(r.created_at).toLocaleString('ru-RU')
        });
      });
      
      const buffer = await workbook.xlsx.writeBuffer();
      const fileName = `users_${Date.now()}.xlsx`;
      const filePath = path.join(__dirname, fileName);
      
      fs.writeFileSync(filePath, buffer);
      
      await ctx.replyWithDocument(
        { source: filePath, filename: `users_${new Date().toLocaleDateString('ru-RU')}.xlsx` },
        { caption: `📊 Экспорт: ${rows.length} пользователей` }
      );
      
      fs.unlinkSync(filePath);
    } catch (e) {
      ctx.answerCbQuery('❌ Ошибка: ' + e.message, { show_alert: true });
      console.error('Export error:', e);    }
  });
};
