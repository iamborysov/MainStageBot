require('dotenv').config();
const { google } = require('googleapis');
const { DateTime } = require('luxon');

// ID календарів для кімнат
const CALENDAR_IDS = {
    'main': process.env.CALENDAR_ID_MAIN, 
    'standart': process.env.CALENDAR_ID_STANDART 
};

// Підключення через Service Account
const auth = new google.auth.GoogleAuth({
    keyFile: './google_key.json', // Шлях до вашого ключа
    scopes: ['https://www.googleapis.com/auth/calendar'],
});

const calendar = google.calendar({ version: 'v3', auth });

// Створення події
const createEvent = async (roomId, date, slots, userInfo) => {
    try {
        const calendarId = CALENDAR_IDS[roomId];
        if (!calendarId) throw new Error('Calendar ID not found for this room');

        const parsedSlots = slots.map(s => {
            const parts = s.split('-');
            return { start: parseInt(parts[0]), end: parseInt(parts[1]) };
        }).sort((a, b) => a.start - b.start);

        const startHour = parsedSlots[0].start;
        const endHour = parsedSlots[parsedSlots.length - 1].end;

        // Встановлюємо правильний часовий пояс
        const startDateTime = `${date}T${String(startHour).padStart(2, '0')}:00:00`;
        const endDateTime = `${date}T${String(endHour).padStart(2, '0')}:00:00`;

        const event = {
            summary: `${userInfo.name} | ${userInfo.band}`,
            description: `Тел: ${userInfo.phone}\nОбладнання: ${userInfo.equipment || 'Немає'}\nБронювання через Telegram Bot`,
            start: { dateTime: startDateTime, timeZone: 'Europe/Kiev' },
            end: { dateTime: endDateTime, timeZone: 'Europe/Kiev' },
        };

        const response = await calendar.events.insert({
            calendarId: calendarId,
            resource: event,
        });

        // console.log(`✅ Подія створена (${slots.join(', ')}): ${response.data.htmlLink}`);
        return response.data.id;
    } catch (error) {
        console.error('Error creating Google Calendar event:', error);
        return null;
    }
};

// Видалення події (підтримує видалення кількох ID через кому)
const deleteEvent = async (roomId, eventIds) => {
    try {
        const calendarId = CALENDAR_IDS[roomId];
        if (!calendarId) return;
        
        const ids = eventIds.split(',');
        for (const id of ids) {
            try {
                await calendar.events.delete({
                    calendarId: calendarId,
                    eventId: id.trim()
                });
                // console.log(`🗑 Подію видалено: ${id}`);
            } catch (e) {
                console.log(`Failed to delete event ${id}: ${e.message}`);
            }
        }
    } catch (error) {
        console.error('Error deleting Google Calendar event:', error);
    }
};

// Перевірка зайнятих слотів
const getBusySlots = async (roomId, date) => {
    try {
        const calendarId = CALENDAR_IDS[roomId];
        if (!calendarId) return [];

        const timeMin = `${date}T00:00:00Z`;
        const timeMax = `${date}T23:59:59Z`;

        const response = await calendar.events.list({
            calendarId: calendarId,
            timeMin: timeMin,
            timeMax: timeMax,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = response.data.items;
        let busySlots = [];

        events.forEach(event => {
            if (event.start.dateTime) {
                // Парсимо час з урахуванням київської timezone (незалежно від TZ сервера)
                let startH = DateTime.fromISO(event.start.dateTime).setZone('Europe/Kiev').hour;
                let endH = DateTime.fromISO(event.end.dateTime).setZone('Europe/Kiev').hour;
                
                // Заповнюємо слоти
                for (let h = startH; h < endH; h++) {
                    busySlots.push(`${h}-${h + 1}`);
                }
            }
        });

        return busySlots;
    } catch (error) {
        console.error('Error fetching busy slots:', error);
        return [];
    }
};

// --- НОВА ФУНКЦІЯ: Перевірка статусу події ---
// (Саме її не вистачало для роботи синхронізації)
const getEventStatus = async (roomId, eventId) => {
    try {
        const calendarId = CALENDAR_IDS[roomId]; 
        if (!calendarId) return 'not_found';

        const response = await calendar.events.get({
            calendarId: calendarId,
            eventId: eventId
        });

        if (response.data.status === 'cancelled') {
            return 'cancelled';
        }
        
        return 'active';
    } catch (error) {
        // 404 або 410 означає, що події більше немає
        if (error.code === 404 || error.code === 410) {
            return 'not_found';
        }
        console.error('Помилка перевірки Google події:', error.message);
        return 'error';
    }
};

// ОБОВ'ЯЗКОВО: Додаємо getEventStatus в експорт
module.exports = { createEvent, deleteEvent, getBusySlots, getEventStatus };