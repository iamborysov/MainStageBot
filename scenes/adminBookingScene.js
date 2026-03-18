const { Scenes, Markup } = require('telegraf');
const KB = require('../keyboards');
const DB = require('../database');

const backToUserPickerKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('↩️ Назад до вибору користувача', 'adm_back_to_user_picker')]
]);

const renderUserPicker = async (ctx, text = '👤 Виберіть користувача:') => {
    const users = await DB.getAllUsers();
    const activeUsers = users.filter(u => !u.is_banned).slice(0, 50);

    const buttons = [];
    for (const user of activeUsers) {
        const residentLabel = user.is_resident ? ' 🎓' : '';
        const bandText = user.band_name ? ` (${user.band_name})` : '';
        buttons.push([Markup.button.callback(
            `${user.first_name}${bandText}${residentLabel} [${user.telegram_id}]`,
            `select_user_${user.telegram_id}`
        )]);
    }

    buttons.push([Markup.button.callback('✏️ Ввести ID вручну', 'input_id_mode')]);
    buttons.push([Markup.button.callback('✍️ Ввести імʼя самостійно', 'input_name_mode')]);

    try {
        await ctx.editMessageText(text, Markup.inlineKeyboard(buttons));
    } catch (e) {
        await ctx.reply(text, Markup.inlineKeyboard(buttons));
    }
};

const adminBookingScene = new Scenes.WizardScene(
    'adminBookingWizard',

    // КРОК 1: Показати список користувачів та опції
    async (ctx) => {
        ctx.session.admin = ctx.session.admin || {};
        ctx.session.admin.selectionMode = null;

        await renderUserPicker(ctx);
        return ctx.wizard.next();
    },

    // КРОК 2: Обробка введення залежно від режиму
    async (ctx) => {
        // Якщо це callback - ігноруємо (обробляється в action handlers)
        if (ctx.callbackQuery) return;
        
        const mode = ctx.session.admin?.selectionMode;
        
        // Режим введення ID
        if (mode === 'input_id') {
            if (!ctx.message?.text) return ctx.reply('Введіть ID користувача.');
            
            const userId = String(ctx.message.text).trim();
            const user = await DB.getUser(userId);
            
            if (!user) {
                return ctx.reply(`❌ Користувача з ID ${userId} не знайдено. Спробуйте ще раз.`);
            }
            
            // Зберігаємо користувача
            ctx.session.admin.selectedUser = {
                userId: userId,
                name: user.first_name,
                phone: user.phone_number,
                band: user.band_name,
                isResident: user.is_resident,
                fromDatabase: true
            };
            
            // Показуємо підтвердження
            const msg = `✅ Знайдено:\n👤 ${user.first_name}\n📱 ${user.phone_number || '-'}\n🎸 ${user.band_name || '-'}${user.is_resident ? '\n🎓 Резидент' : ''}`;
            await ctx.reply(msg);
            
            // Якщо резидент - пропускаємо питання
            if (user.is_resident) {
                await ctx.reply('✅ Бронь буде створена як резидентська.');
                await ctx.reply('✅ Підтверджуємо створення броні?', KB.confirmBookingKeyboard);
            } else {
                await ctx.reply('❓ Чи зробити це резидентською бронʼю?', KB.residentDecisionKeyboard);
            }
            ctx.session.admin.selectionMode = null;
            return;
        }
        
        // Режим введення імʼя
        if (mode === 'input_name') {
            if (!ctx.message?.text) return ctx.reply('Введіть ім\'я.');
            
            ctx.session.admin.selectedUser = {
                userId: '0',
                name: ctx.message.text,
                phone: null,
                band: null,
                isResident: false,
                fromDatabase: false
            };
            
            await ctx.reply('🎸 Введіть назву гурта (або "-"):');
            ctx.session.admin.selectionMode = 'input_band';
            return;
        }
        
        // Режим введення гурта
        if (mode === 'input_band') {
            if (!ctx.message?.text) return ctx.reply('Введіть текст.');
            
            ctx.session.admin.selectedUser.band = ctx.message.text;
            
            await ctx.reply('❓ Чи зробити це резидентською бронʼю?', KB.residentDecisionKeyboard);
            ctx.session.admin.selectionMode = 'input_resident';
            return;
        }
        
        // Вибір типу броні обробляється callback-обробниками `set_res_yes` / `set_res_no`.
    }
);

// --- ВИБІР КОРИСТУВАЧА З КНОПКИ ---
adminBookingScene.action(/select_user_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.match[1];
    const user = await DB.getUser(userId);
    
    if (!user) {
        return ctx.answerCbQuery('❌ Користувача не знайдено', { show_alert: true });
    }
    
    // Зберігаємо користувача
    ctx.session.admin = ctx.session.admin || {};
    ctx.session.admin.selectedUser = {
        userId: userId,
        name: user.first_name,
        phone: user.phone_number,
        band: user.band_name,
        isResident: user.is_resident,
        fromDatabase: true
    };
    
    // Показуємо підтвердження
    const msg = `✅ Знайдено:\n👤 ${user.first_name}\n📱 ${user.phone_number || '-'}\n🎸 ${user.band_name || '-'}${user.is_resident ? '\n🎓 Резидент' : ''}`;
    await ctx.editMessageText(msg);
    
    // Якщо користувач уже резидент - пропускаємо питання, відразу підтверджуємо
    if (user.is_resident) {
        await ctx.reply('✅ Бронь буде створена як резидентська.');
        await ctx.reply('✅ Підтверджуємо створення броні?', KB.confirmBookingKeyboard);
    } else {
        // Якщо звичайний користувач - питаємо чи зробити резидентською
        await ctx.reply('❓ Чи зробити це резидентською бронʼю?', KB.residentDecisionKeyboard);
    }
});

// --- ВВЕСТИ ID ВРУЧНУ ---
adminBookingScene.action('input_id_mode', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.admin = ctx.session.admin || {};
    ctx.session.admin.selectionMode = 'input_id';
    await ctx.editMessageText('📝 Введіть Telegram ID користувача:', backToUserPickerKeyboard);
});

// --- ВВЕСТИ ІМ'Я САМОСТІЙНО ---
adminBookingScene.action('input_name_mode', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.admin = ctx.session.admin || {};
    ctx.session.admin.selectionMode = 'input_name';
    await ctx.editMessageText('✍️ Введіть ім\'я клієнта:', backToUserPickerKeyboard);
});

adminBookingScene.action('adm_back_to_user_picker', async (ctx) => {
    await ctx.answerCbQuery('Повертаю до вибору...');
    ctx.session.admin = ctx.session.admin || {};
    ctx.session.admin.selectionMode = null;
    await renderUserPicker(ctx);
});

// --- ВИБІР ТИПУ БРОНІ (РЕЗИДЕНТСЬКА / ЗВИЧАЙНА) ---
adminBookingScene.action('set_res_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const selectedUser = ctx.session.admin?.selectedUser;
    
    if (!selectedUser) {
        return ctx.answerCbQuery('❌ Помилка: користувач не обраний', { show_alert: true });
    }

    selectedUser.isResident = true;
    await ctx.editMessageText('✅ Бронь буде створена як резидентська.');
    await ctx.reply('✅ Підтверджуємо створення броні?', KB.confirmBookingKeyboard);
});

adminBookingScene.action('set_res_no', async (ctx) => {
    await ctx.answerCbQuery();
    const selectedUser = ctx.session.admin?.selectedUser;
    
    if (!selectedUser) {
        return ctx.answerCbQuery('❌ Помилка: користувач не обраний', { show_alert: true });
    }

    selectedUser.isResident = false;
    await ctx.editMessageText('✅ Бронь буде створена як звичайна.');
    await ctx.reply('✅ Підтверджуємо створення броні?', KB.confirmBookingKeyboard);
});

// --- ФІНАЛЬНЕ ПІДТВЕРДЖЕННЯ ---
adminBookingScene.action('confirm_user_yes', async (ctx) => {
    await ctx.answerCbQuery();
    const selectedUser = ctx.session.admin?.selectedUser;

    if (!selectedUser) {
        return ctx.answerCbQuery('❌ Помилка: користувач не обраний', { show_alert: true });
    }

    ctx.session.booking = ctx.session.booking || {};
    ctx.session.booking.userId = selectedUser.userId;
    ctx.session.booking.manualName = selectedUser.name;
    ctx.session.booking.manualBand = selectedUser.band || '-';
    ctx.session.booking.manualIsResident = selectedUser.isResident || false;
    
    // Переходимо до вибору регулярності
    try {
        await ctx.editMessageText('🔄 Як часто повторювати цю бронь?', KB.recurringKeyboard);
    } catch (e) {
        await ctx.reply('🔄 Як часто повторювати цю бронь?', KB.recurringKeyboard);
    }
    
    return ctx.scene.leave();
});

adminBookingScene.action('confirm_user_no', async (ctx) => {
    await ctx.answerCbQuery('Повертаю до вибору користувача...');
    ctx.session.admin = ctx.session.admin || {};
    ctx.session.admin.selectionMode = null;
    ctx.session.admin.selectedUser = null;
    await renderUserPicker(ctx, '👤 Оберіть іншого користувача:');
});

module.exports = adminBookingScene;