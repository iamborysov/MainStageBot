const { Scenes, Markup } = require('telegraf');
const DB = require('../database'); // Тут ../ правильно, бо ми в папці scenes
const KB = require('../keyboards');
const Sheets = require('../sheets_service');
const { notifyAdmins } = require('../utils/helpers');

const registrationWizard = new Scenes.WizardScene(
    'registrationWizard',
    
    // КРОК 1
    async (ctx) => {
        await ctx.reply(
            '👋 Привіт! Щоб бронювати час на Main Stage, нам потрібно познайомитись.\n\nНатисніть кнопку нижче, щоб поділитися номером телефону 📱',
            Markup.keyboard([
                [Markup.button.contactRequest('📱 Поділитися номером')]
            ]).resize()
        );
        return ctx.wizard.next();
    },

    // КРОК 2
    async (ctx) => {
        if (!ctx.message) {
            return; 
        }

        if (ctx.message.contact) {
            ctx.wizard.state.phone = ctx.message.contact.phone_number;
        } else if (ctx.message.text) {
            const phoneRegex = /^\+?3?8?(0\d{9})$/;
            if (!phoneRegex.test(ctx.message.text.replace(/\D/g, ''))) {
                await ctx.reply('⚠️ Будь ласка, введіть коректний номер телефону або натисніть кнопку.');
                return; 
            }
            ctx.wizard.state.phone = ctx.message.text;
        } else {
            await ctx.reply('⚠️ Будь ласка, поділіться контактом.');
            return;
        }

        await ctx.reply(
            'Чудово! Тепер напишіть назву вашого гурту (або ваше ім\'я, якщо ви займаєтесь самі) 🎸',
            Markup.removeKeyboard() 
        );
        return ctx.wizard.next();
    },

    // КРОК 3
    async (ctx) => {
        const bandName = ctx.message.text;
        
        const userData = {
            telegram_id: ctx.from.id,
            first_name: ctx.from.first_name,
            username: ctx.from.username,
            phone_number: ctx.wizard.state.phone,
            band_name: bandName,
            is_resident: 0 
        };

        try {
            await DB.saveUser(userData);
            
            if (process.env.SPREADSHEET_ID) {
                await Sheets.saveUser(userData);
            }

            await ctx.reply(
                `🎉 Реєстрацію завершено!\n\nЛаскаво просимо, ${ctx.from.first_name} (${bandName})!`,
                KB.getMainMenu(false) 
            );

            const usernameText = ctx.from.username ? `@${ctx.from.username}` : 'без юзернейму';
            const newUserMsg = `🆕 НОВИЙ КОРИСТУВАЧ\n\n👤 ${ctx.from.first_name}\n🔗 ${usernameText}\n🆔 <code>${ctx.from.id}</code>\n📞 ${ctx.wizard.state.phone}\n🎵 ${bandName}`;
            await notifyAdmins(ctx.telegram, newUserMsg, { parse_mode: 'HTML' });

        } catch (error) {
            console.error('Помилка реєстрації:', error);
            await ctx.reply('Сталася помилка при збереженні даних. Спробуйте /start ще раз.');
        }

        return ctx.scene.leave();
    }
);

// 👇 ВИПРАВЛЕННЯ ТУТ: Експортуємо саму сцену, а не Stage
module.exports = registrationWizard;