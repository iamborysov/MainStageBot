const { Composer } = require('telegraf');
const DB = require('../database');
const KB = require('../keyboards');
const Text = require('../text');
const { checkIsAdmin } = require('../utils/helpers');

const composer = new Composer();

// --- START ---
composer.start(async (ctx) => {
    ctx.session = { booking: {}, admin: {} }; // Скидаємо зайве
    const isAdmin = await checkIsAdmin(ctx);
    await ctx.reply(`Привіт, ${ctx.from.first_name}! Обирай в меню знизу потрібний пункт 🔥`, KB.getMainMenu(isAdmin));
});

// --- МЕНЮ ---
composer.hears('🏠 Головне меню', async (ctx) => {
    const isAdmin = await checkIsAdmin(ctx);
    ctx.reply('Головне меню', KB.getMainMenu(isAdmin));
});

composer.hears('📒 Контакти', (ctx) => ctx.reply(Text.staticText.contacts));
composer.hears('📣 Соцмережі', (ctx) => ctx.reply('Ми в соцмережах:', KB.socialButtons));

// --- ПРОФІЛЬ ---
composer.hears('🔧 Профіль', (ctx) => ctx.reply('Редагування профілю', KB.editProfileBtn));

// Запуск сцени реєстрації при натисканні "Змінити дані"
composer.action('edit_profile_start', (ctx) => ctx.scene.enter('registrationWizard'));

// --- ІНФО ПРО СТУДІЮ ---
composer.hears('🎸 Опис студії', async (ctx) => {
    ctx.reply('Обери кімнату 🚪', KB.roomSelector(await DB.getRooms(true), 'desc'));
});

composer.action(/^desc_(.+)$/, async (ctx) => {
    const room = await DB.getRoom(ctx.match[1]);
    await ctx.editMessageText(room.description || 'Опису немає', KB.backToDescBtn);
});

composer.action('back_to_desc_rooms', async (ctx) => {
    const rooms = await DB.getRooms(true);
    await ctx.editMessageText('Обери кімнату 🚪', KB.roomSelector(rooms, 'desc'));
});

composer.hears('💸 Вартість репетицій', async (ctx) => ctx.reply('Обери кімнату:', KB.roomSelector(await DB.getRooms(true), 'price')));

composer.action(/price_(.+)/, async (ctx) => {
    const room = await DB.getRoom(ctx.match[1]);
    if (room.price_image) await ctx.replyWithPhoto(room.price_image, { caption: `Прайс: ${room.name}` });
    else await ctx.reply('Фото прайсу відсутнє.');
});

module.exports = composer;