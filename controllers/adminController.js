require('dotenv').config();
const { Composer, Markup } = require('telegraf');
const { DateTime } = require('luxon');
const DB = require('../database');
const KB = require('../keyboards');
const { checkIsAdmin } = require('../utils/helpers');

// Підключаємо GCal
let GCal;
try { GCal = require('../calendar_service'); } catch (e) {}

const composer = new Composer();

// --- ВХІД В АДМІНКУ ---
composer.hears('⚙️ Адмін панель', async (ctx) => {
    if (await checkIsAdmin(ctx)) ctx.reply('Вітаю в панелі керування 🛠', KB.adminMenu);
});

// --- РУЧНЕ БРОНЮВАННЯ (ЗАПУСК СЦЕНИ) ---
composer.hears('➕ Створити бронь', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const rooms = await DB.getRooms(true);
    
    ctx.session.admin.isManualBooking = true; 
    ctx.session.booking = { equipment: [] };  
    ctx.reply('Оберіть кімнату для ручного бронювання 🚪', KB.roomSelector(rooms, 'book'));
});

// --- ФІНАЛІЗАЦІЯ РУЧНОГО БРОНЮВАННЯ ---
composer.action(/adm_rec_(.+)/, async (ctx) => {
    const weeks = parseInt(ctx.match[1]);
    await ctx.editMessageText('⏳ Створення серії бронювань...');
    
    const { roomId, roomName, date, slots, manualName, manualBand, manualIsResident } = ctx.session.booking;
    const seriesId = Date.now().toString() + Math.floor(Math.random() * 1000);
    
    let currentDate = DateTime.fromISO(date);
    let createdDates = [];

    for (let i = 0; i < weeks; i++) {
        const dateStr = currentDate.toISODate();
        let googleEventId = null;
        if (GCal) {
            const userInfo = {
                name: manualName,
                phone: 'Бронь Адміна',
                band: (manualBand || '-') + (manualIsResident ? ' (Резидент)' : ''),
                equipment: ''
            };
            googleEventId = await GCal.createEvent(roomId, dateStr, slots, userInfo);
        }
        
        await DB.saveBooking(0, roomId, roomName, dateStr, slots, '', googleEventId, seriesId, manualName, manualBand);
        createdDates.push(dateStr);
        currentDate = currentDate.plus({ weeks: 1 });
    }

    ctx.session.admin.isManualBooking = false;
    ctx.session.booking = {};
    
    let msg = `✅ Успішно створено серію (${weeks} тижнів)!\n👤: ${manualName} (${manualBand})\n⏰: ${slots.join(', ')}\nСерія ID: ${seriesId}`;
    await ctx.reply(msg, KB.adminMenu);
});


// --- КЕРУВАННЯ АДМІНАМИ ---
composer.hears('👮‍♂️ Адміністратори', async (ctx) => {
    if (String(ctx.from.id) !== process.env.ADMIN_ID) return ctx.reply('Доступно тільки власнику.');
    const users = await DB.getAllUsers();
    ctx.reply('Керування адміністраторами:', KB.adminListMenu(users, process.env.ADMIN_ID));
});

composer.action(/admin_toggle_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== process.env.ADMIN_ID) return;
    const targetId = ctx.match[1];
    const user = await DB.getUser(targetId);
    await DB.setAdminStatus(targetId, !user.is_admin);
    const users = await DB.getAllUsers();
    await ctx.editMessageReplyMarkup(KB.adminListMenu(users, process.env.ADMIN_ID).reply_markup);
    try {
        const msg = !user.is_admin ? '🎉 Вам надано права адміністратора.' : 'ℹ️ Ваші права адміністратора скасовано.';
        await ctx.telegram.sendMessage(targetId, msg);
    } catch (e) {}
});

// --- КЕРУВАННЯ РЕЗИДЕНТАМИ ---
composer.hears('🎓 Резиденти', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const users = await DB.getAllUsers();
    ctx.reply('Натисніть на юзера:', KB.residentListMenu(users));
});

composer.action(/resident_toggle_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const targetId = ctx.match[1];
    const user = await DB.getUser(targetId);
    await DB.setResidentStatus(targetId, !user.is_resident);
    const users = await DB.getAllUsers();
    await ctx.editMessageReplyMarkup(KB.residentListMenu(users).reply_markup);
});

// --- КЕРУВАННЯ КІМНАТАМИ ---
composer.hears('🏠 Налаштування кімнат', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const rooms = await DB.getRooms(false);
    ctx.reply('Керування кімнатами:', KB.adminRoomList(rooms));
});

composer.action(/adm_room_toggle_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const roomId = ctx.match[1];
    const room = await DB.getRoom(roomId);
    await DB.updateRoom(roomId, 'is_active', room.is_active ? 0 : 1);
    const rooms = await DB.getRooms(false);
    await ctx.editMessageText('Керування кімнатами:', KB.adminRoomList(rooms));
});

composer.action(/adm_room_edit_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    ctx.session.admin.step = 'edit_room_name';
    ctx.session.admin.roomId = ctx.match[1];
    await ctx.reply('Введіть нову назву кімнати:', KB.skipBtn);
});

// Обробка тексту для редагування кімнат
composer.on('message', async (ctx, next) => {
    // 1. Розсилка
    if (await checkIsAdmin(ctx) && ctx.session.admin?.step === 'broadcast_wait') {
        if (!ctx.message) return next();
        ctx.session.admin.broadcastMsgId = ctx.message.message_id;
        ctx.session.admin.step = 'broadcast_confirm';
        await ctx.reply('👀 Попередній перегляд:');
        await ctx.telegram.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id);
        return ctx.reply('Надіслати всім?', KB.broadcastConfirmBtn);
    }

    // 2. Редагування кімнат
    if (await checkIsAdmin(ctx) && ctx.session.admin?.step?.startsWith('edit_room') && ctx.message.text) {
        const { step, roomId } = ctx.session.admin;
        const text = ctx.message.text;
        if (step === 'edit_room_name') {
            if (text !== 'Пропустити') await DB.updateRoom(roomId, 'name', text);
            ctx.session.admin.step = 'edit_room_desc';
            return ctx.reply('Введіть опис:', KB.skipBtn);
        }
        if (step === 'edit_room_desc') {
            if (text !== 'Пропустити') await DB.updateRoom(roomId, 'description', text);
            ctx.session.admin.step = 'edit_room_price';
            return ctx.reply('Посилання на фото прайсу:', KB.skipBtn);
        }
        if (step === 'edit_room_price') {
            if (text !== 'Пропустити') await DB.updateRoom(roomId, 'price_image', text);
            ctx.session.admin.step = null;
            return ctx.reply('Завершено ✅', KB.adminMenu);
        }
    }
    return next();
});

// Кнопка пропуску для редагування кімнат
composer.action('skip_step', async (ctx) => {
    if (!ctx.session.admin?.step) return;
    const step = ctx.session.admin.step;
    if (step === 'edit_room_name') { ctx.session.admin.step = 'edit_room_desc'; return ctx.reply('Введіть опис:', KB.skipBtn); }
    if (step === 'edit_room_desc') { ctx.session.admin.step = 'edit_room_price'; return ctx.reply('Посилання на фото:', KB.skipBtn); }
    if (step === 'edit_room_price') { ctx.session.admin.step = null; return ctx.reply('Завершено ✅', KB.adminMenu); }
});

// --- ЧОРНИЙ СПИСОК ---
composer.hears('⬛ Чорний список', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const users = await DB.getAllUsers();
    ctx.reply('Керування баном:', KB.blacklistMenu(users));
});

composer.action(/ban_toggle_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const targetId = ctx.match[1];
    const user = await DB.getUser(targetId);
    await DB.toggleBan(targetId, !user.is_banned);
    const users = await DB.getAllUsers();
    await ctx.editMessageReplyMarkup(KB.blacklistMenu(users).reply_markup);
});

// --- РОЗСИЛКА ---
composer.hears('📨 Розсилка', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    ctx.session.admin.step = 'broadcast_wait'; 
    ctx.reply('Надішліть повідомлення (текст/фото/відео) для розсилки:', Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', 'broadcast_cancel')]]));
});

composer.action('broadcast_cancel', async (ctx) => {
    ctx.session.admin = {}; 
    await ctx.reply('Розсилку скасовано.', KB.adminMenu);
    await ctx.deleteMessage();
});

composer.action('broadcast_send', async (ctx) => {
    if (!ctx.session.admin?.broadcastMsgId) return ctx.reply('Помилка: немає повідомлення.');
    const users = await DB.getAllUsers();
    await ctx.reply(`🚀 Старт розсилки на ${users.length} юзерів...`);
    let success = 0;
    for (const user of users) {
        try {
            await ctx.telegram.copyMessage(user.telegram_id, ctx.from.id, ctx.session.admin.broadcastMsgId);
            success++;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 50)); 
    }
    ctx.session.admin = {}; 
    await ctx.reply(`✅ Завершено!\nОтримали: ${success}`, KB.adminMenu);
});

// --- СКАСУВАННЯ СЕРІЙ ---
composer.hears('🔄 Регулярні броні', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const series = await DB.getActiveSeries();
    if (!series || series.length === 0) return ctx.reply('Активних регулярних бронювань немає.');
    ctx.reply('Оберіть серію для СКАСУВАННЯ:', KB.seriesList(series));
});

composer.action(/cancel_series_(.+)/, async (ctx) => {
    const seriesId = ctx.match[1];
    const bookings = await DB.getSeriesBookings(seriesId);
    
    if (bookings.length > 0 && GCal) {
        const idsToDelete = bookings.filter(b => b.google_event_id).map(b => b.google_event_id).join(',');
        if (idsToDelete) await GCal.deleteEvent(bookings[0].room_id, idsToDelete);
    }
    await DB.cancelSeries(seriesId);
    await ctx.editMessageText('✅ Серію регулярних бронювань успішно скасовано.');
});

module.exports = composer;