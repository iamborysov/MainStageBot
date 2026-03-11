require('dotenv').config();
const DB = require('../database');

/**
 * Генерує посилання для додавання події в Google Calendar
 */
function generateUserCalendarLink(date, slots, roomName, equipment) {
    const parsedSlots = slots.map(s => {
        const parts = s.split('-');
        return { start: parseInt(parts[0]), end: parseInt(parts[1]) };
    }).sort((a, b) => a.start - b.start);

    const startHour = parsedSlots[0].start;
    const endHour = parsedSlots[parsedSlots.length - 1].end;

    const dateStr = date.replace(/-/g, '');
    const startStr = `${dateStr}T${String(startHour).padStart(2, '0')}0000`;
    const endStr = `${dateStr}T${String(endHour).padStart(2, '0')}0000`;

    const title = encodeURIComponent(`Репетиція | Main Stage Studio`);
    const detailsText = `Кімната: ${roomName}\n${equipment ? 'Оренда: ' + equipment : ''}\n\nБот: @MainStageStudioBot`;
    const details = encodeURIComponent(detailsText);
    const location = encodeURIComponent('Main Stage Studio'); 

    return `https://www.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${startStr}/${endStr}&details=${details}&location=${location}&sf=true&output=xml`;
}

/**
 * Перевіряє, чи є користувач адміністратором
 */
async function checkIsAdmin(ctx) {
    if (!ctx.from) return false;
    const userId = String(ctx.from.id);
    
    // 1. Перевірка за ID власника з .env
    if (userId === process.env.ADMIN_ID) return true; 
    
    // 2. Перевірка в базі даних (якщо призначений адмін)
    try {
        const user = await DB.getUser(userId);
        return user && user.is_admin === 1; 
    } catch (e) {
        return false;
    }
}

// ВАЖЛИВО: Експортуємо обидві функції
module.exports = { generateUserCalendarLink, checkIsAdmin };