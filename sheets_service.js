const { google } = require('googleapis');
const path = require('path');

const KEY_FILE_PATH = path.join(__dirname, 'google_key.json');

const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });

// --- 1. Додавання нового юзера (Базова функція) ---
async function saveUser(user) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Users!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    new Date().toLocaleString('uk-UA'), // Дата додавання
                    String(user.telegram_id),           // ID
                    user.first_name,                    // Ім'я
                    user.phone_number,                  // Телефон
                    user.username ? `@${user.username}` : '-' // Юзернейм
                ]]
            },
        });
        // console.log(`✅ [Sheets] Новий користувач ${user.first_name} доданий.`);
    } catch (error) {
        // console.error('❌ [Sheets] Помилка запису юзера:', error.message);
    }
}

// --- 2. Розумна перевірка і додавання (НОВА ФУНКЦІЯ) ---
async function checkAndSaveUser(user) {
    try {
        const spreadsheetId = process.env.SPREADSHEET_ID;
        
        // Читаємо тільки колонку B (де лежать ID) з вкладки Users
        const result = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: 'Users!B:B', 
        });

        const rows = result.data.values || [];
        // Перетворюємо масив рядків у простий список ID
        const existingIds = rows.map(row => row[0]);

        // Якщо ID користувача ще немає в списку -> додаємо його
        if (!existingIds.includes(String(user.telegram_id))) {
            // console.log(`👤 Користувача ${user.telegram_id} немає в таблиці. Виправляємо...`);
            await saveUser(user);
        } else {
            // console.log('Користувач вже є в базі, все ок.');
        }
    } catch (error) {
        // console.error('❌ [Sheets] Помилка перевірки юзера:', error.message);
    }
}

// --- 3. Додавання бронювання (Без змін) ---
async function appendBooking(bookingData) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Sheet1!A:I', 
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    bookingData.date,
                    bookingData.time,
                    bookingData.room,
                    bookingData.name,
                    bookingData.phone,
                    bookingData.band,
                    bookingData.equipment,
                    bookingData.telegramId,
                    new Date().toLocaleString('uk-UA')
                ]]
            },
        });
        // console.log('✅ [Sheets] Бронь записана.');
    } catch (error) {
        // console.error('❌ [Sheets] Помилка запису броні:', error.message);
    }
}

module.exports = { appendBooking, saveUser, checkAndSaveUser };