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

    console.log('✅ Cron-завдання ініціалізовано.');
};

module.exports = { initCronJobs };