require('dotenv').config();
const { Telegraf, session, Scenes } = require('telegraf'); // <-- Scenes беремо звідси
const DB = require('./database');
const { initCronJobs } = require('./cron/jobs');

// Імпорт сцен
const registrationScene = require('./scenes/registrationScene');
const adminBookingScene = require('./scenes/adminBookingScene');

// Імпорт контролерів
const userController = require('./controllers/userController');
const adminController = require('./controllers/adminController');
const bookingController = require('./controllers/bookingController');

const bot = new Telegraf(process.env.BOT_TOKEN);

// 1. Налаштування Сцен (Stage)
// Ми створюємо "менеджера", який знає про наші сцени
const stage = new Scenes.Stage([registrationScene, adminBookingScene]);

// 2. Підключаємо сесії (ОБОВ'ЯЗКОВО ПЕРШИМИ)
bot.use(session());

// 3. Підключаємо менеджер сцен (ОБОВ'ЯЗКОВО ДО КОНТРОЛЕРІВ)
// Саме цей рядок додає об'єкт ctx.scene, який ми намагалися викликати
bot.use(stage.middleware());

// 4. Ініціалізація дефолтних даних сесії (щоб не було помилок undefined)
bot.use((ctx, next) => {
    if (!ctx.session) ctx.session = {};
    ctx.session.booking = ctx.session.booking || {};
    // admin потрібен для старих перевірок, хоча сцени мають свій state
    ctx.session.admin = ctx.session.admin || {};
    return next();
});

// 5. Перевірка на БАН
bot.use(async (ctx, next) => {
    if (ctx.from) {
        const user = await DB.getUser(ctx.from.id);
        if (user && user.is_banned) return;
    }
    return next();
});

// 6. Перевірка реєстрації (до всіх контролерів)
bot.use(async (ctx, next) => {
    if (!ctx.from) return next();
    // Пропускаємо якщо юзер вже всередині сцени (щоб не переривати реєстрацію)
    if (ctx.session.__scenes?.current) return next();
    // Пропускаємо /start — він завжди доступний
    if (ctx.message?.text === '/start') return next();

    const user = await DB.getUser(ctx.from.id);
    if (!user || !user.phone_number) {
        await ctx.reply('👋 Спочатку потрібно зареєструватись!');
        return ctx.scene.enter('registrationWizard');
    }
    return next();
});

// 7. Підключаємо контролери (логіку бота)
bot.use(userController);
bot.use(adminController);
bot.use(bookingController);

// 8. Запускаємо фонові завдання (нагадування)
initCronJobs(bot);

bot.catch((err, ctx) => {
    console.error(`❌ Помилка для ${ctx.updateType}`, err);
});

// 9. Старт бота
bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('✅ Bot started...');
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));