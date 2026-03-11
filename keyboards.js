const { Markup } = require('telegraf');
const { DateTime } = require('luxon');

const getMainMenu = (isAdmin) => {
    let buttons = [
        ['📅 Розклад', '🎸 Опис студії'],
        ['📅 Мої бронювання', '💸 Вартість репетицій'],
        ['📒 Контакти', '🔧 Профіль'],
        ['📣 Соцмережі']
    ];
    if (isAdmin) {
        buttons.push(['⚙️ Адмін панель']);
    }
    return Markup.keyboard(buttons).resize();
};

const adminMenu = Markup.keyboard([
    ['➕ Створити бронь', '🔄 Регулярні броні'],
    ['⬛ Чорний список', '🎓 Резиденти'],
    ['👮‍♂️ Адміністратори', '🏠 Налаштування кімнат'],
    ['📨 Розсилка', '🏠 Головне меню']
]).resize();

const roomSelector = (rooms, actionPrefix) => {
    const buttons = rooms.map(room => [Markup.button.callback(room.name, `${actionPrefix}_${room.id}`)]);
    return Markup.inlineKeyboard(buttons);
};

const adminRoomList = (rooms) => {
    const buttons = [];
    rooms.forEach(room => {
        buttons.push([Markup.button.callback(room.name, 'noop')]); 
        const statusBtn = room.is_active ? '✅ Увімкнено' : '💤 Вимкнено';
        buttons.push([
            Markup.button.callback('❌', `adm_room_delete_${room.id}`), 
            Markup.button.callback('🔧', `adm_room_edit_${room.id}`),   
            Markup.button.callback(statusBtn, `adm_room_toggle_${room.id}`)             
        ]);
    });
    return Markup.inlineKeyboard(buttons);
};

const skipBtn = Markup.inlineKeyboard([[Markup.button.callback('Пропустити', 'skip_step')]]);

const socialButtons = Markup.inlineKeyboard([
    [
        Markup.button.url('Instagram', 'https://www.instagram.com/mainstagestudio/'),
        Markup.button.url('Facebook', 'https://www.facebook.com/'),
        Markup.button.url('Telegram', 'https://t.me/mainstagestudio')
    ]
]);

const editProfileBtn = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Змінити дані', 'edit_profile_start')]
]);

const backToDescBtn = Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Назад', 'back_to_desc_rooms')]
]);

const bookingList = (bookings) => {
    const buttons = bookings.map(b => {
        return [Markup.button.callback(
            `❌ Скасувати: ${b.date} | ${b.time_slots} | ${b.room_name}`, 
            `cancel_booking_${b.id}`
        )];
    });
    return Markup.inlineKeyboard(buttons);
};

const blacklistMenu = (users) => {
    const buttons = users.map(u => {
        const status = u.is_banned ? '🟢 Розблокувати' : '🔴 Заблокувати';
        const rowText = `${u.first_name} ${u.band_name ? `(${u.band_name})` : ''} - ${status}`;
        return [Markup.button.callback(rowText, `ban_toggle_${u.telegram_id}`)];
    });
    return Markup.inlineKeyboard(buttons);
};

const adminListMenu = (users, superAdminId) => {
    const buttons = users.map(u => {
        if (String(u.telegram_id) === String(superAdminId)) return null;
        const isAdm = u.is_admin ? '✅ Адмін' : '👤 Юзер';
        const rowText = `${u.first_name} (${u.phone_number}) - ${isAdm}`;
        return [Markup.button.callback(rowText, `admin_toggle_${u.telegram_id}`)];
    }).filter(b => b !== null);
    return Markup.inlineKeyboard(buttons);
};

const residentListMenu = (users) => {
    const buttons = users.map(u => {
        const isRes = u.is_resident ? '✅ Резидент' : '👤 Звичайний';
        const rowText = `${u.first_name} (${u.band_name || 'без гурта'}) - ${isRes}`;
        return [Markup.button.callback(rowText, `resident_toggle_${u.telegram_id}`)];
    });
    return Markup.inlineKeyboard(buttons);
};

const broadcastConfirmBtn = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Надіслати', 'broadcast_send')],
    [Markup.button.callback('❌ Скасувати', 'broadcast_cancel')]
]);

const equipmentSelector = (selectedItems = []) => {
    const items = [
        { id: 'bass', name: '🎸 Бас-гітара', price: 100 },
        { id: 'guitar', name: '🎸 Електрогітара', price: 100 },
        { id: 'cymbals', name: '🥁 Тарілки', price: 100 }
    ];

    const buttons = items.map(item => {
        const isSelected = selectedItems.includes(item.id);
        const icon = isSelected ? '✅' : '⬜️';
        const text = `${icon} ${item.name} (${item.price} грн/год)`;
        return [Markup.button.callback(text, `equip_toggle_${item.id}`)];
    });

    const confirmText = selectedItems.length > 0 ? '✅ Готово (Далі)' : '❌ Нічого не треба (Далі)';
    buttons.push([Markup.button.callback(confirmText, 'confirm_equipment')]);
    
    buttons.push([Markup.button.callback('↩️ Назад до часу', 'back_to_time_grid')]);

    return Markup.inlineKeyboard(buttons);
};

// Додали аргумент isAdmin (за замовчуванням false)
const createCalendar = (year, month, isAdmin = false) => {
    const dt = DateTime.local(year, month).setLocale('uk');
    const now = DateTime.now().setLocale('uk'); 
    
    const daysInMonth = dt.daysInMonth;
    const firstDayOfWeek = dt.startOf('month').weekday;
    const monthName = dt.toFormat('LLLL'); 
    
    let buttons = [];
    buttons.push([
        Markup.button.callback('◀️', `cal_prev_${year}_${month}`),
        Markup.button.callback(monthName.toUpperCase(), 'noop'),
        Markup.button.callback('▶️', `cal_next_${year}_${month}`)
    ]);

    buttons.push(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map(d => Markup.button.callback(d, 'noop')));

    let currentWeek = [];
    for (let i = 1; i < firstDayOfWeek; i++) currentWeek.push(Markup.button.callback(' ', 'noop'));

    for (let d = 1; d <= daysInMonth; d++) {
        const btnDate = dt.set({ day: d });
        const dateStr = btnDate.toISODate();
        
        let isAvailable = true;

    if (!isAdmin) {
            // 1. Минулі дні - недоступні
            if (btnDate.startOf('day') < now.startOf('day')) isAvailable = false;
            
            // 2. Сьогоднішній день - ТЕПЕР ТЕЖ НЕДОСТУПНИЙ (❌)
            if (btnDate.hasSame(now, 'day')) isAvailable = false;
        }

        if (isAvailable) {
            currentWeek.push(Markup.button.callback(String(d), `date_select_${dateStr}`));
        } else {
            currentWeek.push(Markup.button.callback('✖️', 'noop')); 
        }

        if (currentWeek.length === 7) { 
            buttons.push(currentWeek); 
            currentWeek = []; 
        }
    }
    
    if (currentWeek.length > 0) {
        while (currentWeek.length < 7) currentWeek.push(Markup.button.callback(' ', 'noop'));
        buttons.push(currentWeek);
    }
    buttons.push([Markup.button.callback('↪️ Назад', 'back_to_rooms')]);
    return Markup.inlineKeyboard(buttons);
};

const createTimeGrid = (bookedSlots, selectedSlots) => {
    const hours = ['10-11', '11-12', '12-13', '13-14', '14-15', '15-16', '16-17', '17-18', '18-19', '19-20', '20-21', '21-22'];
    let buttons = [];
    const columnLength = 6; 

    for (let i = 0; i < columnLength; i++) {
        let row = [];
        const leftSlot = hours[i];
        const rightSlot = hours[i + columnLength];
        
        [leftSlot, rightSlot].forEach(slot => {
            let text = `🆓 ${slot}`;
            let action = `time_select_${slot}`;
            
            if (bookedSlots.includes(slot)) { 
                text = `❌ ${slot}`; 
                action = `show_booking_info_${slot}`; 
            } 
            else if (selectedSlots.includes(slot)) { 
                text = `✅ ${slot}`; 
                action = `time_select_${slot}`; 
            }
            row.push(Markup.button.callback(text, action));
        });
        buttons.push(row);
    }
    buttons.push([Markup.button.callback('↪️ Назад', 'back_to_calendar')]);
    if (selectedSlots.length > 0) buttons.push([Markup.button.callback('➡️ Далі (До обладнання)', 'to_equipment')]);
    
    return Markup.inlineKeyboard(buttons);
};

const boolKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Так (Резидент)', 'adm_res_true'), Markup.button.callback('❌ Ні (Звичайний)', 'adm_res_false')]
]);

const recurringKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('1️⃣ Тільки на цю дату', 'adm_rec_1')],
    [Markup.button.callback('🔄 На місяць (4 тижні)', 'adm_rec_4')],
    [Markup.button.callback('♾️ До скасування (6 міс.)', 'adm_rec_24')]
]);

// --- ОНОВЛЕНО: Відображаємо імена в списку серій ---
const seriesList = (series) => {
    if (!series || series.length === 0) return Markup.inlineKeyboard([]);
    
    const buttons = series.map(s => {
        const dt = DateTime.fromISO(s.date).setLocale('uk');
        const dayOfWeek = dt.toFormat('ccc'); // Пн, Вт...
        
        // Формуємо рядок: "Ім'я (Гурт) | Пн 19:00 | Room"
        const clientInfo = s.client_name ? `${s.client_name} ${s.band_name ? `(${s.band_name})` : ''}` : 'Невідомий';
        const info = `${clientInfo} | ${dayOfWeek} ${s.time_slots} | ${s.room_name}`;
        
        return [Markup.button.callback(`❌ Скасувати: ${info}`, `cancel_series_${s.series_id}`)];
    });
    
    buttons.push([Markup.button.callback('↩️ Назад', 'delete_msg')]);
    return Markup.inlineKeyboard(buttons);
};

module.exports = { 
    getMainMenu, adminMenu, roomSelector, adminRoomList, 
    bookingList, blacklistMenu, adminListMenu, residentListMenu,
    skipBtn, socialButtons, editProfileBtn, backToDescBtn,
    createCalendar, createTimeGrid, broadcastConfirmBtn,
    equipmentSelector,
    boolKeyboard, recurringKeyboard, seriesList
};