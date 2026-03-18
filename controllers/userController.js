const { Composer } = require('telegraf');
const DB = require('../database');
const KB = require('../keyboards');
const Text = require('../text');
const { checkIsAdmin } = require('../utils/helpers');

const composer = new Composer();

// --- START ---
composer.start(async (ctx) => {
    // Повністю скидаємо сесію, щоб прибрати незавершені стани
    ctx.session = { booking: {}, admin: {} };

    // Якщо сцена була перервана/зависла, примусово виходимо
    try {
        await ctx.scene.leave();
    } catch (e) {}

    const user = await DB.getUser(ctx.from.id);
    if (user && user.phone_number) {
        const isAdmin = await checkIsAdmin(ctx);
        return ctx.reply(`Привіт, ${ctx.from.first_name}! Обирай в меню знизу потрібний пункт 🔥`, KB.getMainMenu(isAdmin));
    }

    return ctx.scene.enter('registrationWizard');
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
    const roomId = ctx.match[1];
    const room = await DB.getRoom(roomId);
    if (!room) {
        await ctx.answerCbQuery('Кімнату не знайдено');
        return ctx.editMessageText('Кімнату не знайдено або вона вже видалена.');
    }
    await ctx.editMessageText(room.description || 'Опису немає', KB.roomInfoActions(roomId, 'back_to_desc_rooms'));
});

composer.action('back_to_desc_rooms', async (ctx) => {
    const rooms = await DB.getRooms(true);
    await ctx.editMessageText('Обери кімнату 🚪', KB.roomSelector(rooms, 'desc'));
});

composer.hears('💸 Вартість репетицій', async (ctx) => ctx.reply('Обери кімнату:', KB.roomSelector(await DB.getRooms(true), 'price')));

composer.action(/^price_(.+)$/, async (ctx) => {
    const roomId = ctx.match[1];
    const room = await DB.getRoom(roomId);
    if (!room) {
        await ctx.answerCbQuery('Кімнату не знайдено');
        return ctx.reply('Кімнату не знайдено або вона вже видалена.');
    }

    if (room.price_image) {
        await ctx.replyWithPhoto(room.price_image, {
            caption: `Прайс: ${room.name}`,
            reply_markup: KB.roomInfoActions(roomId, 'back_to_price_rooms').reply_markup
        });
    } else {
        await ctx.reply('Фото прайсу відсутнє.', KB.roomInfoActions(roomId, 'back_to_price_rooms'));
    }
});

composer.action('back_to_price_rooms', async (ctx) => {
    const rooms = await DB.getRooms(true);
    try {
        await ctx.editMessageText('Обери кімнату:', KB.roomSelector(rooms, 'price'));
    } catch (e) {
        await ctx.reply('Обери кімнату:', KB.roomSelector(rooms, 'price'));
    }
});

module.exports = composer;