const cron = require('node-cron');
const { DateTime } = require('luxon');
const DB = require('../database');

// Підключаємо сервіс календаря (якщо він є)
let GCal;
try {
    GCal = require('../calendar_service');
} catch (e) {
    console.log('⚠️ Google Calendar Service не підключено (у cron).');
}

const findConflictingSlots = async (roomId, dateStr, slots) => {
    const dbSlots = await DB.getBookedSlots(dateStr, roomId);
    const googleSlots = GCal ? await GCal.getBusySlots(roomId, dateStr) : [];
    const busySlots = new Set([...dbSlots, ...googleSlots]);
    return slots.filter(slot => busySlots.has(slot));
};

/**
 * Ініціалізація всіх фонових завдань
 * @param {Telegraf} bot - екземпляр бота для відправки повідомлень
 */
const initCronJobs = (bot) => {
    
    // ==========================
    // 🔔 1. НАГАДУВАННЯ (Щодня о 19:00)
    // ==========================
    cron.schedule('0 19 * * *', async () => {
        console.log('⏳ Запуск розсилки нагадувань...');
        
        const tomorrow = DateTime.now().setZone('Europe/Kiev').plus({ days: 1 }).toISODate();
        const bookings = await DB.getBookingsByDate(tomorrow);
        
        if (!bookings || bookings.length === 0) return;

        for (const booking of bookings) {
            // Пропускаємо ручні броні без ID користувача
            if (booking.user_id === 0) continue;

            try {
                const message = `🔔 *Нагадування!*\n\nЗавтра (${booking.date}) у вас запланована репетиція!\n\n⏰ Час: ${booking.time_slots}\n🚪 Кімната: ${booking.room_name}${booking.equipment ? `\n🎸 Оренда: ${booking.equipment}` : ''}\n\nЧекаємо на вас! 🔥`;
                
                await bot.telegram.sendMessage(booking.user_id, message, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error(`❌ Не вдалося надіслати нагадування юзеру ${booking.user_id}`);
            }
        }
    }, {
        timezone: "Europe/Kiev"
    });

    // ==========================
    // 🔄 2. СИНХРОНІЗАЦІЯ З GOOGLE (Кожні 10 хв)
    // ==========================
    cron.schedule('*/10 * * * *', async () => {
        if (!GCal) return;

        try {
            const bookings = await DB.getFutureActiveBookingsWithEvent();
            if (!bookings || bookings.length === 0) return;

            for (const booking of bookings) {
                // Перевіряємо статус у Google
                const status = await GCal.getEventStatus(booking.room_id, booking.google_event_id);

                // Якщо подія видалена в Google -> видаляємо в боті
                if (status === 'cancelled' || status === 'not_found') {
                    console.log(`🗑 Знайдено видалену в Google подію: ${booking.id} (${booking.client_name})`);

                    await DB.cancelBooking(booking.id);

                    // Сповіщаємо юзера
                    if (booking.user_id !== 0) {
                        try {
                            const msg = `⚠️ *Увага! Ваше бронювання скасовано.*\n\n(Адміністратор видалив його з календаря)\n\n📅 Дата: ${booking.date}\n⏰ Час: ${booking.time_slots}`;
                            await bot.telegram.sendMessage(booking.user_id, msg, { parse_mode: 'Markdown' });
                        } catch (e) {}
                    }

                    // Сповіщаємо адміна (лог)
                    try {
                         const adminMsg = `🔄 *Синхронізація*: Бронь ID ${booking.id} видалено слідом за Google.\n👤 ${booking.client_name || 'Невідомий'}`;
                         await bot.telegram.sendMessage(process.env.ADMIN_ID, adminMsg, { parse_mode: 'Markdown' });
                    } catch(e) {}
                }
                
                // Пауза між запитами до Google API
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (e) {
            console.error('❌ Помилка при синхронізації Google Calendar:', e);
        }
    });

    // ==========================
    // ♾️ 3. АВТОПОДОВЖЕННЯ РЕГУЛЯРНИХ СЕРІЙ (Щодня о 03:15)
    // ==========================
    cron.schedule('15 3 * * *', async () => {
        try {
            const seriesList = await DB.getAutoRenewSeries();
            if (!seriesList.length) return;

            const horizon = DateTime.now().setZone('Europe/Kiev').plus({ weeks: 24 }).startOf('day');

            for (const series of seriesList) {
                let nextDate = DateTime.fromISO(series.last_date).plus({ weeks: 1 }).startOf('day');
                const slots = String(series.time_slots || '').split(',').filter(Boolean);
                const createdDates = [];
                const skippedDates = [];

                while (nextDate <= horizon) {
                    const dateStr = nextDate.toISODate();
                    const conflicts = await findConflictingSlots(series.room_id, dateStr, slots);

                    if (conflicts.length === 0) {
                        let googleEventId = null;
                        if (GCal) {
                            googleEventId = await GCal.createEvent(series.room_id, dateStr, slots, {
                                name: series.client_name,
                                phone: 'Бронь Адміна',
                                band: (series.band_name || '-') + (series.is_resident_booking ? ' (Резидент)' : ''),
                                equipment: ''
                            });
                        }

                        await DB.saveBooking(
                            0,
                            series.room_id,
                            series.room_name,
                            dateStr,
                            slots,
                            '',
                            googleEventId,
                            series.series_id,
                            series.client_name,
                            series.band_name,
                            true,
                            !!series.is_resident_booking
                        );
                        createdDates.push(dateStr);
                    } else {
                        skippedDates.push(`${dateStr} (${conflicts.join(', ')})`);
                    }

                    nextDate = nextDate.plus({ weeks: 1 });
                }

                if (createdDates.length > 0 || skippedDates.length > 0) {
                    let adminMsg = `♾️ *Автоподовження серії*\n👤 ${series.client_name || 'Невідомий'}\n🚪 ${series.room_name}\n⏰ ${series.time_slots}`;
                    if (createdDates.length > 0) adminMsg += `\n\n✅ Додано дати:\n${createdDates.join('\n')}`;
                    if (skippedDates.length > 0) adminMsg += `\n\n⚠️ Пропущено дати:\n${skippedDates.join('\n')}`;
                    try {
                        await bot.telegram.sendMessage(process.env.ADMIN_ID, adminMsg, { parse_mode: 'Markdown' });
                    } catch (e) {}
                }
            }
        } catch (e) {
            console.error('❌ Помилка автоподовження серій:', e);
        }
    }, {
        timezone: 'Europe/Kiev'
    });

    console.log('✅ Cron-завдання ініціалізовано.');
};

module.exports = { initCronJobs };