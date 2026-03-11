const { Scenes, Markup } = require('telegraf'); // <-- Правильний імпорт
const KB = require('../keyboards');

const adminBookingScene = new Scenes.WizardScene(
    'adminBookingWizard',

    // КРОК 1
    async (ctx) => {
        await ctx.reply('✍️ Введіть ім\'я клієнта:');
        return ctx.wizard.next();
    },

    // КРОК 2
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply('Введіть текст.');
        ctx.wizard.state.manualName = ctx.message.text;
        await ctx.reply('🎸 Введіть назву гурта (або "-"):');
        return ctx.wizard.next();
    },

    // КРОК 3
    async (ctx) => {
        if (!ctx.message || !ctx.message.text) return ctx.reply('Введіть текст.');
        ctx.wizard.state.manualBand = ctx.message.text;
        await ctx.reply('🎓 Чи є цей клієнт резидентом?', KB.boolKeyboard);
        return ctx.wizard.next();
    },

    // КРОК 4
    async (ctx) => {
        if (!ctx.callbackQuery) return ctx.reply('Будь ласка, оберіть варіант кнопкою.');
        
        const data = ctx.callbackQuery.data;
        const isResident = data === 'adm_res_true';
        
        // Зберігаємо в глобальну сесію для фіналізації
        ctx.session.booking.manualName = ctx.wizard.state.manualName;
        ctx.session.booking.manualBand = ctx.wizard.state.manualBand;
        ctx.session.booking.manualIsResident = isResident;

        await ctx.editMessageText('🔄 Як часто повторювати цю бронь?', KB.recurringKeyboard);
        return ctx.scene.leave();
    }
);

module.exports = adminBookingScene;