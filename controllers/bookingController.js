require('dotenv').config();
const { Composer, Markup } = require('telegraf');
const { DateTime } = require('luxon');
const DB = require('../database');
const KB = require('../keyboards');
const { generateUserCalendarLink, checkIsAdmin, notifyAdmins } = require('../utils/helpers');
const Sheets = require('../sheets_service');

// Підключаємо GCal
let GCal;
try { GCal = require('../calendar_service'); } catch (e) {}

const composer = new Composer();

// --- КОМАНДА: МОЇ БРОНЮВАННЯ ---
composer.hears('✅ Мої бронювання', async (ctx) => {
    const bookings = await DB.getUserBookings(ctx.from.id);
    if (!bookings.length) return ctx.reply('Активних бронювань немає.');
    
    // Групуємо броні: серійні окремо
    const groupedBookings = {};
    const standaloneBookings = [];
    
    for (const booking of bookings) {
        if (booking.series_id) {
            if (!groupedBookings[booking.series_id]) {
                groupedBookings[booking.series_id] = [];
            }
            groupedBookings[booking.series_id].push(booking);
        } else {
            standaloneBookings.push(booking);
        }
    }
    
    // Будуємо текст и клавіатуру
    let text = '✅ *Ваші бронювання*\n\n';
    const buttons = [];
    
    // Звичайні броні
    for (const booking of standaloneBookings) {
        buttons.push([Markup.button.callback(
            `❌ ${booking.date} | ${booking.time_slots} | ${booking.room_name}`, 
            `cancel_booking_${booking.id}`
        )]);
    }
    
    // Серійні броні (групи)
    for (const [seriesId, seriesBookings] of Object.entries(groupedBookings)) {
        const firstDate = seriesBookings[0].date;
        const count = seriesBookings.length;
        buttons.push([Markup.button.callback(
            `🔄 Серія (${count} дат): ${firstDate}... | ${seriesBookings[0].room_name}`, 
            `series_manage_${seriesId}`
        )]);
    }
    
    ctx.reply(text, Markup.inlineKeyboard(buttons));
});

// --- УПРАВЛІННЯ СЕРІЙНОЮ БРНЮ ---
composer.action(/series_manage_(.+)/, async (ctx) => {
    const seriesId = ctx.match[1];
    const seriesBookings = await DB.getSeriesBookings(seriesId);
    
    if (!seriesBookings.length) return ctx.answerCbQuery('Серія не знайдена', { show_alert: true });
    
    // Перевіримо що це бронь користувача
    if (seriesBookings[0].user_id !== ctx.from.id) {
        return ctx.answerCbQuery('Ви не маєте доступу до цієї серії', { show_alert: true });
    }
    
    // Будуємо список дат
    let text = `🔄 *Управління серією*\n\n${seriesBookings[0].room_name}\n⏰ ${seriesBookings[0].time_slots}\n\n📅 Доступні дати:\n`;
    
    const buttons = [];
    for (const booking of seriesBookings) {
        buttons.push([Markup.button.callback(
            `❌ ${booking.date}`, 
            `cancel_series_date_${booking.id}`
        )]);
    }
    
    // Кнопка для скасування всієї серії
    buttons.push([Markup.button.callback('🗑️ Скасувати всю серію', `cancel_all_series_${seriesId}`)]);
    buttons.push([Markup.button.callback('⬅️ Назад до броней', 'back_to_bookings')]);
    
    try {
        await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
    } catch (e) {
        await ctx.reply(text, Markup.inlineKeyboard(buttons));
    }
});

// --- СКАСУВАННЯ ОДНІЄЇ ДАТИ З СЕРІЇ ---
composer.action(/cancel_series_date_(\d+)/, async (ctx) => {
    const bookingId = parseInt(ctx.match[1], 10);
    if (!Number.isFinite(bookingId)) {
        return ctx.answerCbQuery('Некоректний ID бронювання', { show_alert: true });
    }

    try {
        const booking = await DB.getBookingById(bookingId);
        if (!booking) return ctx.answerCbQuery('Бронювання не знайдено', { show_alert: true });
        if (String(booking.user_id) !== String(ctx.from.id)) {
            return ctx.answerCbQuery('Ви не маєте доступу', { show_alert: true });
        }

        // Перевірка 12-годинного вікна
        const slots = String(booking.time_slots || '').split(',').filter(Boolean);
        const startHours = slots
            .map(s => parseInt(String(s).split('-')[0], 10))
            .filter(n => Number.isFinite(n));

        if (startHours.length > 0) {
            const earliestHour = Math.min(...startHours);
            const bookingStart = DateTime.fromISO(`${booking.date}T${String(earliestHour).padStart(2, '0')}:00:00`, { zone: 'Europe/Kiev' });
            const now = DateTime.now().setZone('Europe/Kiev');
            const hoursLeft = bookingStart.diff(now, 'hours').hours;

            if (hoursLeft < 12) {
                return ctx.answerCbQuery('Скасування недоступне менш ніж за 12 годин до репетиції.', { show_alert: true });
            }
        }

        await ctx.answerCbQuery('⏳ Скасовую дату...');

        if (GCal && booking.google_event_id) {
            try {
                await GCal.deleteEvent(booking.room_id, booking.google_event_id);
            } catch (e) {
                // Навіть якщо GCal недоступний, локальне скасування має відбутися.
            }
        }

        await DB.cancelBooking(bookingId);
        const afterCancel = await DB.getBookingById(bookingId);
        if (!afterCancel || afterCancel.status !== 'cancelled') {
            await ctx.reply('❌ Не вдалося скасувати обрану репетицію. Спробуйте ще раз.');
            return;
        }

        await ctx.reply(`✅ Видалено репетицію: ${booking.date} | ${booking.time_slots} | ${booking.room_name}`);

        const actor = await DB.getUser(ctx.from.id);
        const actorName = actor ? `${actor.first_name} (${actor.phone_number || '-'})` : `ID ${ctx.from.id}`;
        await notifyAdmins(ctx.telegram, `⚠️ СКАСУВАННЯ ОДНІЄЇ ДАТИ СЕРІЇ\n\n👤 ${actorName}\n📅 <b>${booking.date}</b>\n⏰ ${booking.time_slots}\n🚪 <b>${booking.room_name}</b>`, { parse_mode: 'HTML' });

        // Оновлюємо список серії
        const seriesBookings = await DB.getSeriesBookings(booking.series_id);
        if (seriesBookings.length === 0) {
            await ctx.editMessageText('✅ У серії не лишилось активних дат.');
        } else {
            const text = `🔄 *Управління серією*\n\n${seriesBookings[0].room_name}\n⏰ ${seriesBookings[0].time_slots}\n\n📅 Доступні дати:\n`;
            const buttons = [];
            for (const b of seriesBookings) {
                buttons.push([Markup.button.callback(`❌ ${b.date}`, `cancel_series_date_${b.id}`)]);
            }
            buttons.push([Markup.button.callback('🗑️ Скасувати всю серію', `cancel_all_series_${booking.series_id}`)]);
            buttons.push([Markup.button.callback('⬅️ Назад до броней', 'back_to_bookings')]);
            await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
        }
    } catch (error) {
        console.error('[ERROR] cancel_series_date:', error);
        await ctx.reply('❌ Сталася помилка при скасуванні конкретної дати.');
    }
});

// --- СКАСУВАННЯ ВСІЄЇ СЕРІЇ ---
composer.action(/cancel_all_series_(\d+)/, async (ctx) => {
    const seriesId = ctx.match[1];
    const seriesBookings = await DB.getSeriesBookings(seriesId);
    
    if (!seriesBookings.length) return ctx.answerCbQuery('Серія не знайдена', { show_alert: true });
    if (String(seriesBookings[0].user_id) !== String(ctx.from.id)) return ctx.answerCbQuery('Ви не маєте доступу', { show_alert: true });

    // Спочатку перевіряємо всю серію: якщо хоч одна дата < 12 годин — не скасовуємо нічого
    const protectedDates = [];
    for (const booking of seriesBookings) {
        const slots = String(booking.time_slots || '').split(',').filter(Boolean);
        const startHours = slots
            .map(s => parseInt(String(s).split('-')[0], 10))
            .filter(n => Number.isFinite(n));

        if (startHours.length > 0) {
            const earliestHour = Math.min(...startHours);
            const bookingStart = DateTime.fromISO(`${booking.date}T${String(earliestHour).padStart(2, '0')}:00:00`, { zone: 'Europe/Kiev' });
            const now = DateTime.now().setZone('Europe/Kiev');
            const hoursLeft = bookingStart.diff(now, 'hours').hours;

            if (hoursLeft < 12) {
                protectedDates.push(`${booking.date} (${booking.time_slots})`);
            }
        }
    }

    if (protectedDates.length > 0) {
        return ctx.answerCbQuery(`⛔ Не можна скасувати серію: є репетиції менш ніж за 12 годин.`, { show_alert: true });
    }

    await ctx.answerCbQuery('⏳ Скасовую всю серію...');

    let cancelledCount = 0;
    for (const booking of seriesBookings) {
        if (GCal && booking.google_event_id) {
            try { await GCal.deleteEvent(booking.room_id, booking.google_event_id); } catch (e) {}
        }
        await DB.cancelBooking(booking.id);
        const afterCancel = await DB.getBookingById(booking.id);
        if (afterCancel && afterCancel.status === 'cancelled') cancelledCount++;
    }

    await ctx.editMessageText(`✅ Скасовано всю серію: видалено ${cancelledCount} з ${seriesBookings.length} дат.`);
    await ctx.reply('Що робимо далі?', KB.getMainMenu());

    const actor = await DB.getUser(ctx.from.id);
    const actorName = actor ? `${actor.first_name} (${actor.phone_number || '-'})` : `ID ${ctx.from.id}`;
        await notifyAdmins(ctx.telegram, `⚠️ СКАСУВАННЯ СЕРІЇ КОРИСТУВАЧЕМ\n\n👤 ${actorName}\n🆔 Серія: <code>${seriesId}</code>\n📅 Скасовано дат: ${cancelledCount}`, { parse_mode: 'HTML' });
});

// --- ПОВЕРНЕННЯ ДО БРОНЕЙ ---
composer.action('back_to_bookings', async (ctx) => {
    const bookings = await DB.getUserBookings(ctx.from.id);
    if (!bookings.length) return ctx.editMessageText('Активних бронювань немає.');
    
    const groupedBookings = {};
    const standaloneBookings = [];
    
    for (const booking of bookings) {
        if (booking.series_id) {
            if (!groupedBookings[booking.series_id]) {
                groupedBookings[booking.series_id] = [];
            }
            groupedBookings[booking.series_id].push(booking);
        } else {
            standaloneBookings.push(booking);
        }
    }
    
    let text = '✅ *Ваші бронювання*\n\n';
    const buttons = [];
    
    for (const booking of standaloneBookings) {
        buttons.push([Markup.button.callback(
            `❌ ${booking.date} | ${booking.time_slots} | ${booking.room_name}`, 
            `cancel_booking_${booking.id}`
        )]);
    }
    
    for (const [seriesId, seriesBookings] of Object.entries(groupedBookings)) {
        const firstDate = seriesBookings[0].date;
        const count = seriesBookings.length;
        buttons.push([Markup.button.callback(
            `🔄 Серія (${count} дат): ${firstDate}... | ${seriesBookings[0].room_name}`, 
            `series_manage_${seriesId}`
        )]);
    }
    
    await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
});
composer.action(/cancel_booking_(.+)/, async (ctx) => {
    const bookingId = ctx.match[1];
    const booking = await DB.getBookingById(bookingId);
    
    if (!booking) return ctx.reply('Бронювання не знайдено.');

    const isAdmin = await checkIsAdmin(ctx);
    if (!isAdmin && booking.user_id !== ctx.from.id) return ctx.reply('Це не ваше бронювання.');

    // Для користувача: заборона скасування менш ніж за 12 годин до репетиції
    if (!isAdmin) {
        const slots = String(booking.time_slots || '').split(',').filter(Boolean);
        const startHours = slots
            .map(s => parseInt(String(s).split('-')[0], 10))
            .filter(n => Number.isFinite(n));

        if (startHours.length > 0) {
            const earliestHour = Math.min(...startHours);
            const bookingStart = DateTime.fromISO(`${booking.date}T${String(earliestHour).padStart(2, '0')}:00:00`, { zone: 'Europe/Kiev' });
            const now = DateTime.now().setZone('Europe/Kiev');
            const hoursLeft = bookingStart.diff(now, 'hours').hours;

            if (hoursLeft < 12) {
                return ctx.answerCbQuery('Скасування недоступне менш ніж за 12 годин до репетиції.', { show_alert: true });
            }
        }
    }

    if (GCal && booking.google_event_id) {
        await GCal.deleteEvent(booking.room_id, booking.google_event_id);
    }
    
    await DB.cancelBooking(bookingId);
    
    if (isAdmin) {
        await ctx.reply(`✅ Бронь ID ${bookingId} видалено.`);
        if (booking.user_id !== 0 && booking.user_id !== ctx.from.id) {
            try {
                await ctx.telegram.sendMessage(booking.user_id, 
                    `⚠️ Ваше бронювання скасовано адміністратором.\n\n📅 Дата: ${booking.date}\n⏰ Час: ${booking.time_slots}\n🚪 Кімната: ${booking.room_name}`
                );
            } catch (e) {}
        }

        const actor = await DB.getUser(ctx.from.id);
        const actorName = actor ? `${actor.first_name} (${actor.phone_number || '-'})` : `ID ${ctx.from.id}`;
        await notifyAdmins(ctx.telegram, `⚠️ СКАСУВАННЯ БРОНЮВАННЯ АДМІНОМ\n\n👤 Адмін: ${actorName}\n📅 <b>${booking.date}</b>\n⏰ ${booking.time_slots}\n🚪 <b>${booking.room_name}</b>`, { parse_mode: 'HTML' });
    } else {
        await ctx.reply(`❌ Бронь на ${booking.date} скасовано.`);
        const bookings = await DB.getUserBookings(ctx.from.id);
        if (bookings.length) await ctx.editMessageReplyMarkup(KB.bookingList(bookings).reply_markup);
        else await ctx.editMessageText('Активних бронювань немає.');
        
        const user = await DB.getUser(booking.user_id);
        const residentLabel = user && user.is_resident ? ' 🎓 (Резидент)' : '';
        const userName = user ? `${user.first_name} (${user.phone_number})${residentLabel}` : 'Невідомий';
        const equipText = booking.equipment ? `\n🎸 Оренда: ${booking.equipment}` : '';

        await notifyAdmins(ctx.telegram, 
            `⚠️ СКАСУВАННЯ БРОНЮВАННЯ КОРИСТУВАЧЕМ\n\n👤 ${userName}\n📅 <b>${booking.date}</b>\n⏰ ${booking.time_slots}\n🚪 <b>${booking.room_name}</b>${equipText}`,
            { parse_mode: 'HTML' }
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
    ctx.session.booking = {};
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
    await ctx.editMessageText('🎸 Чи потрібне додаткові обладнання? (100 грн/год)', KB.equipmentSelector(ctx.session.booking.equipment));
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
    
    let replyText = `Юху 🤗\nРепетиція підтверджена! ✨\n\nКімната: <b>${roomName}</b>\nДата: <b>${date}</b>\nЧас: <b>${slots.join(', ')}</b>`;
    if (equipString) replyText += `\n🎸 Оренда: ${equipString}`;
    replyText += `\n\n📍 Як нас знайти: https://is.gd/xnAFTa\n📞 Телефон: +38 099 682 97 21\n🏠 Адреса: Дніпровський Узвіз, 1`;

    const calendarLink = generateUserCalendarLink(date, slots, roomName, equipString);
    const finalKeyboard = Markup.inlineKeyboard([[Markup.button.url('➕ Додати в Google Calendar', calendarLink)]]);
    
    await ctx.reply(replyText, { ...finalKeyboard, parse_mode: 'HTML', disable_web_page_preview: true });
    await ctx.reply('Що робимо далі?', KB.getMainMenu(isAdmin));

    const usernameText = user.username ? `@${user.username}` : 'без юзернейму';

    await notifyAdmins(
        ctx.telegram,
        `🆕 НОВЕ БРОНЮВАННЯ ВІД КОРИСТУВАЧА\n\n🚪 <b>${roomName}</b>\n📅 <b>${date}</b>\n⏰ ${slots.join(', ')}\n👤 ${user.first_name}\n🔗 ${usernameText}\n🆔 <code>${user.telegram_id}</code>\n📞 ${user.phone_number}\n🎵 ${user.band_name || '-'}${user.is_resident ? ' 🎓 (Резидент)' : ''}${equipString ? `\n🎸 Оренда: ${equipString}` : ''}`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', `cancel_booking_${bookingId}`)]])
        }
    );
    ctx.session.booking = {};
}

module.exports = composer;