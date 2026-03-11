require('dotenv').config();
const { Composer, Markup } = require('telegraf');
const { DateTime } = require('luxon');
const DB = require('../database');
const KB = require('../keyboards');
const { generateUserCalendarLink, checkIsAdmin } = require('../utils/helpers');
const Sheets = require('../sheets_service');

// Підключаємо GCal
let GCal;
try { GCal = require('../calendar_service'); } catch (e) {}

const composer = new Composer();

// --- КОМАНДА: МОЇ БРОНЮВАННЯ ---
composer.hears('✅ Мої бронювання', async (ctx) => {
    const bookings = await DB.getUserBookings(ctx.from.id);
    if (!bookings.length) return ctx.reply('Активних бронювань немає.');
    ctx.reply('Ваші бронювання (натисніть для скасування):', KB.bookingList(bookings));
});

// --- СКАСУВАННЯ БРОНЮВАННЯ ---
composer.action(/cancel_booking_(.+)/, async (ctx) => {
    const bookingId = ctx.match[1];
    const booking = await DB.getBookingById(bookingId);
    
    if (!booking) return ctx.reply('Бронювання не знайдено.');

    const isAdmin = await checkIsAdmin(ctx);
    if (!isAdmin && booking.user_id !== ctx.from.id) return ctx.reply('Це не ваше бронювання.');

    if (GCal && booking.google_event_id) {
        await GCal.deleteEvent(booking.room_id, booking.google_event_id);
    }
    
    await DB.cancelBooking(bookingId);
    
    if (isAdmin) {
        await ctx.reply(`✅ Бронь ID ${bookingId} видалено.`);
        if (booking.user_id !== 0 && booking.user_id !== ctx.from.id) {
            try {
                await ctx.telegram.sendMessage(booking.user_id, 
                    `⚠️ *Ваше бронювання скасовано адміністратором!*\n\n📅 Дата: ${booking.date}\n⏰ Час: ${booking.time_slots}\n🚪 Кімната: ${booking.room_name}`, 
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        }
    } else {
        await ctx.reply(`❌ Бронь на ${booking.date} скасовано.`);
        const bookings = await DB.getUserBookings(ctx.from.id);
        if (bookings.length) await ctx.editMessageReplyMarkup(KB.bookingList(bookings).reply_markup);
        else await ctx.editMessageText('Активних бронювань немає.');
        
        const user = await DB.getUser(booking.user_id);
        const userName = user ? `${user.first_name} (${user.phone_number})` : 'Невідомий';
        const equipText = booking.equipment ? `\n🎸 Оренда: ${booking.equipment}` : '';
        
        await ctx.telegram.sendMessage(process.env.ADMIN_ID, 
            `⚠️ *СКАСУВАННЯ БРОНЮВАННЯ*\n\n👤 Хто: ${userName}\n📅 Дата: ${booking.date}\n⏰ Час: ${booking.time_slots}\n🚪 Кімната: ${booking.room_name}${equipText}`,
            { parse_mode: 'Markdown' }
        );
    }
});

// --- ПОЧАТОК БРОНЮВАННЯ ---
composer.hears('📅 Розклад', async (ctx) => {
    const rooms = await DB.getRooms(true);
    if (!ctx.session.admin) ctx.session.admin = {};
    ctx.session.admin.isManualBooking = false; 
    ctx.reply('Обери кімнату 🚪', KB.roomSelector(rooms, 'book'));
});

composer.action(/book_(.+)/, async (ctx) => {
    const roomId = ctx.match[1];
    const isManual = ctx.session.admin?.isManualBooking;
    const isAdmin = await checkIsAdmin(ctx);
    
    ctx.session.booking = { roomId: roomId, slots: [], equipment: [] }; 
    if (isManual) ctx.session.admin.isManualBooking = true; 

    const room = await DB.getRoom(roomId);
    if (room) ctx.session.booking.roomName = room.name;

    const now = DateTime.local();
    await ctx.editMessageText(`Обери дату для репетиції в ${room ? room.name : 'кімнаті'} 📅`, KB.createCalendar(now.year, now.month, isAdmin));
});

// --- КАЛЕНДАР ---
composer.action(/cal_(prev|next)_(\d+)_(\d+)/, async (ctx) => {
    try {
        const [_, dir, y, m] = ctx.match;
        let year = parseInt(y), month = parseInt(m);
        const isAdmin = await checkIsAdmin(ctx);
        if (dir === 'next') { month++; if(month>12){month=1; year++;} }
        else { month--; if(month<1){month=12; year--;} }
        await ctx.editMessageReplyMarkup(KB.createCalendar(year, month, isAdmin).reply_markup);
    } catch (e) {}
});

composer.action('back_to_calendar', async (ctx) => {
    const now = DateTime.local();
    const roomName = ctx.session.booking?.roomName || 'кімнаті';
    const isAdmin = await checkIsAdmin(ctx);
    await ctx.editMessageText(`Обери дату для репетиції в ${roomName} 📅`, KB.createCalendar(now.year, now.month, isAdmin));
});

composer.action('back_to_rooms', async (ctx) => {
    const rooms = await DB.getRooms(true);
    await ctx.editMessageText('Обери кімнату 🚪', KB.roomSelector(rooms, 'book'));
});

// --- ВИБІР ДАТИ ---
composer.action(/date_select_(.+)/, async (ctx) => {
    if (!ctx.session.booking) ctx.session.booking = { slots: [], equipment: [] };
    
    const date = ctx.match[1];
    const isAdmin = await checkIsAdmin(ctx);
    const now = DateTime.now().setZone('Europe/Kiev');
    const selectedDate = DateTime.fromISO(date).setZone('Europe/Kiev');

    // 👇 НОВА ПЕРЕВІРКА: ЗАБОРОНА БРОНЮВАННЯ ДЕНЬ-В-ДЕНЬ 👇
    if (!isAdmin && selectedDate.hasSame(now, 'day')) {
        return ctx.answerCbQuery('🚫 Бронювання день-в-день заборонено.\nБудь ласка, бронюйте мінімум за 1 день наперед.', { show_alert: true });
    }
    // 👆 КІНЕЦЬ ПЕРЕВІРКИ 👆

    ctx.session.booking.date = date;
    
    // 1. Отримуємо реально зайняті слоти
    const dbSlots = await DB.getBookedSlots(date, ctx.session.booking.roomId);
    let googleSlots = [];
    if (GCal) {
        googleSlots = await GCal.getBusySlots(ctx.session.booking.roomId, date);
    }
    let allBusySlots = [...new Set([...dbSlots, ...googleSlots])];

    // 2. Логіка блокування минулого часу (для адміна пропускаємо, для юзера - блокуємо вчорашні дні, якщо раптом пролізли)
    if (!isAdmin) {
        // Якщо вибрана дата в минулому (вчора і раніше)
        if (selectedDate < now.startOf('day')) {
             return ctx.answerCbQuery('⏳ Минуле не змінити!', { show_alert: true });
        }
    }

    // 3. Зберігаємо і показуємо
    ctx.session.booking.bookedSlots = allBusySlots;
    
    const roomName = ctx.session.booking.roomName || 'кімнаті';
    const headerText = isAdmin ? `🔓 Режим Адміна (доступні всі слоти)` : `Обирай вільний час:`;

    await ctx.editMessageText(
        `Розклад ${roomName} на ${date}.\n${headerText}`, 
        KB.createTimeGrid(allBusySlots, [])
    );
});

composer.action(/time_select_(.+)/, async (ctx) => {
    if (!ctx.session.booking) ctx.session.booking = {};
    if (!ctx.session.booking.slots) ctx.session.booking.slots = [];
    const slot = ctx.match[1];
    if (ctx.session.booking.slots.includes(slot)) ctx.session.booking.slots = ctx.session.booking.slots.filter(s => s !== slot);
    else { ctx.session.booking.slots.push(slot); ctx.session.booking.slots.sort(); }
    try { await ctx.editMessageReplyMarkup(KB.createTimeGrid(ctx.session.booking.bookedSlots || [], ctx.session.booking.slots).reply_markup); } catch(e) {}
});

// --- ПЕРЕХІД ДАЛІ ---
composer.action('to_equipment', async (ctx) => {
    if (!ctx.session.booking?.slots || ctx.session.booking.slots.length === 0) {
        return ctx.answerCbQuery('Спочатку оберіть час!');
    }
    
    if (ctx.session.admin?.isManualBooking) {
        await ctx.deleteMessage();
        return ctx.scene.enter('adminBookingWizard');
    }

    if (!ctx.session.booking.equipment) ctx.session.booking.equipment = [];
    await ctx.editMessageText('🎸 Чи потрібне додаткове обладнання? (100 грн/год)', KB.equipmentSelector(ctx.session.booking.equipment));
});

composer.action(/equip_toggle_(.+)/, async (ctx) => {
    const item = ctx.match[1];
    if (!ctx.session.booking.equipment) ctx.session.booking.equipment = [];
    if (ctx.session.booking.equipment.includes(item)) ctx.session.booking.equipment = ctx.session.booking.equipment.filter(i => i !== item);
    else ctx.session.booking.equipment.push(item);
    await ctx.editMessageReplyMarkup(KB.equipmentSelector(ctx.session.booking.equipment).reply_markup);
});

composer.action('back_to_time_grid', async (ctx) => {
    const booked = ctx.session.booking.bookedSlots || [];
    const selected = ctx.session.booking.slots || [];
    await ctx.editMessageText(`Розклад на ${ctx.session.booking.date}.\nОбирай вільний час:`, KB.createTimeGrid(booked, selected));
});

composer.action(/show_booking_info_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return ctx.answerCbQuery('Цей час вже заброньовано 🔒');
    const slot = ctx.match[1];
    const { date, roomId } = ctx.session.booking;
    const booking = await DB.getBookingBySlot(date, roomId, slot);
    if (!booking) return ctx.reply(`📅 Цей час (${slot}) зайнято в Google Календарі.`, Markup.inlineKeyboard([[Markup.button.callback('↩️ Приховати', 'delete_msg')]]));
    let userInfo = 'Невідомий';
    if (booking.client_name) userInfo = `${booking.client_name} (${booking.band_name || '-'})`;
    else { const user = await DB.getUser(booking.user_id); if (user) userInfo = `${user.first_name} (${user.phone_number})`; }
    const equipInfo = booking.equipment ? `\n🎸 Оренда: ${booking.equipment}` : '';
    await ctx.reply(`📅 Деталі броні:\nЧас: ${booking.time_slots}\nКим: ${userInfo}\n${equipInfo}`, Markup.inlineKeyboard([[Markup.button.callback('❌ Видалити', `cancel_booking_${booking.id}`)], [Markup.button.callback('↩️ Приховати', 'delete_msg')]]));
});
composer.action('delete_msg', (ctx) => ctx.deleteMessage());

// --- ФІНАЛІЗАЦІЯ ---
composer.action('confirm_equipment', async (ctx) => {
    if (!ctx.session.booking?.date) return ctx.reply('Помилка даних. Почніть з /start');
    
    const user = await DB.getUser(ctx.from.id);
    if (!user) {
        await ctx.deleteMessage();
        return ctx.scene.enter('registrationWizard');
    }
    await finalizeBooking(ctx, user);
});

// Збереження
async function finalizeBooking(ctx, user) {
    const { roomId, roomName, date, slots, equipment } = ctx.session.booking;
    const equipMap = { 'bass': 'Бас-гітара', 'guitar': 'Електрогітара', 'cymbals': 'Тарілки' };
    const equipString = equipment && equipment.length > 0 ? equipment.map(e => equipMap[e]).join(', ') : ''; 

    // 1. Google Calendar (якщо є)
    let googleEventId = null;
    if (GCal) {
        const bandSuffix = user.is_resident ? ' (Резидент)' : '';
        const userInfo = { name: user.first_name, phone: user.phone_number, band: (user.band_name || '-') + bandSuffix, equipment: equipString };
        googleEventId = await GCal.createEvent(roomId, date, slots, userInfo);
    }
    
    // 2. Збереження в SQLite
    const bookingId = await DB.saveBooking(user.telegram_id, roomId, roomName, date, slots, equipString, googleEventId, null, user.first_name, user.band_name);
    
    // 3. 👇 ЗБЕРЕЖЕННЯ В GOOGLE ТАБЛИЦЮ (НОВИЙ БЛОК) 👇
if (process.env.SPREADSHEET_ID) {
        await Sheets.checkAndSaveUser(user);

        await Sheets.appendBooking({
            date: date,
            time: slots.join(', '),
            room: roomName,
            name: user.first_name,
            phone: user.phone_number,
            band: user.band_name || '-',
            equipment: equipString,
            telegramId: String(user.telegram_id)
        });
    }

    const isAdmin = await checkIsAdmin(ctx);
    
    let replyText = `✅ Бронь підтверджено!\nКімната: ${roomName}\nДата: ${date}\nЧас: ${slots.join(', ')}`;
    if (equipString) replyText += `\n🎸 Оренда: ${equipString}`;
    replyText += `\n\n📍 Як нас знайти: https://is.gd/xnAFTa\n📞 Телефон: +38 099 682 97 21\n🏠 Адреса: Дніпровський Узвіз, 1`;

    const calendarLink = generateUserCalendarLink(date, slots, roomName, equipString);
    const finalKeyboard = Markup.inlineKeyboard([[Markup.button.url('➕ Додати в Google Calendar', calendarLink)]]);
    
    await ctx.reply(replyText, { ...finalKeyboard, disable_web_page_preview: true });
    await ctx.reply('Що робимо далі?', KB.getMainMenu(isAdmin));

    const userMention = `[${user.first_name}](tg://user?id=${user.telegram_id})`;
    const usernameText = user.username ? `@${user.username}` : 'без юзернейму';
    const userIdCode = `\`${user.telegram_id}\``;
    
await ctx.telegram.sendMessage(process.env.ADMIN_ID, 
        `🆕 НОВА БРОНЬ!\n🚪 ${roomName}\n📅 ${date}\n⏰ ${slots.join(', ')}\n\n👤 [${user.first_name}](tg://user?id=${user.telegram_id})\n🔗 ${user.username ? `@${user.username}` : 'без юзернейму'}\n🆔 \`${user.telegram_id}\`\n📞 ${user.phone_number}\n🎵 ${user.band_name || '-'}${user.is_resident ? ' 🎓' : ''}${equipString ? `\n\n🎸 Оренда: ${equipString}` : ''}`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', `cancel_booking_${bookingId}`)]])
        }
    );
    ctx.session.booking = {};
}

module.exports = composer;