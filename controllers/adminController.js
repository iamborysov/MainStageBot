require('dotenv').config();
const { Composer, Markup } = require('telegraf');
const { DateTime } = require('luxon');
const DB = require('../database');
const KB = require('../keyboards');
const { checkIsAdmin, notifyAdmins } = require('../utils/helpers');

// Підключаємо GCal
let GCal;
try { GCal = require('../calendar_service'); } catch (e) {}

const buildSeriesDates = (startDate, weeks) => {
    const dates = [];
    let currentDate = DateTime.fromISO(startDate);

    for (let index = 0; index < weeks; index++) {
        dates.push(currentDate.toISODate());
        currentDate = currentDate.plus({ weeks: 1 });
    }

    return dates;
};

const findConflictingSlots = async (roomId, dateStr, slots) => {
    const timeout = (promise, ms) => {
        return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Google Calendar timeout')), ms))]);
    };
    
    try {
        const dbSlots = await DB.getBookedSlots(dateStr, roomId);
        let googleSlots = [];
        try {
            if (GCal) {
                googleSlots = await timeout(GCal.getBusySlots(roomId, dateStr), 5000);
            }
        } catch (gcalError) {
            console.log(`[WARNING] Google Calendar getBusySlots timeout/error for ${dateStr}:`, gcalError.message);
            // Continue with just DB slots
        }
        const busySlots = new Set([...dbSlots, ...googleSlots]);
        return slots.filter(slot => busySlots.has(slot));
    } catch (error) {
        console.log(`[ERROR] findConflictingSlots for ${dateStr}:`, error.message);
        return [];
    }
};

const buildSeriesPlan = async (booking, weeks) => {
    // Валідація даних
    if (!booking.date) {
        console.log('[ERROR] booking.date is missing');
        return [];
    }
    if (!Array.isArray(booking.slots) || booking.slots.length === 0) {
        console.log('[ERROR]booking.slots is missing or empty');
        return [];
    }
    
    const dates = buildSeriesDates(booking.date, weeks);
    const entries = [];

    for (const dateStr of dates) {
        const conflicts = await findConflictingSlots(booking.roomId, dateStr, booking.slots || []);
        entries.push({
            date: dateStr,
            conflicts,
            available: conflicts.length === 0
        });
    }

    return entries;
};

const formatSeriesPreview = (booking, weeks, plan, autoRenew) => {
    const header = autoRenew
        ? '♾️ Автоподовження увімкнено: бот триматиме горизонт серії приблизно на 6 місяців уперед, доки серію не скасують.'
        : '🔄 Серія буде створена лише на вибраний період.';

    const lines = plan.map(entry => {
        if (entry.available) return `✅ ${entry.date}`;
        return `❌ ${entry.date} — зайнято (${entry.conflicts.join(', ')})`;
    });

    const availableCount = plan.filter(entry => entry.available).length;
    const blockedCount = plan.length - availableCount;

    return [
        `📋 Перевірка серії для ${booking.roomName}`,
        `👤 ${booking.manualName} (${booking.manualBand || '-'})${booking.manualIsResident ? ' 🎓 (Резидент)' : ''}`,
        `⏰ ${booking.slots.join(', ')}`,
        `📦 Період: ${weeks} тижн.`,
        header,
        '',
        ...lines,
        '',
        `Підсумок: доступно ${availableCount}, зайнято ${blockedCount}.`
    ].join('\n');
};

const buildGoogleUserInfo = (booking) => ({
    name: booking.manualName,
    phone: 'Бронь Адміна',
    band: (booking.manualBand || '-') + (booking.manualIsResident ? ' (Резидент)' : ''),
    equipment: ''
});

const runSystemSelfTest = async (ctx, progressReporter = async () => {}) => {
    const results = [];
    const now = DateTime.now().setZone('Europe/Kiev');

    const logProgress = async (line) => {
        console.log(`[SELFTEST] ${line}`);
        await progressReporter(line);
    };

    const pushResult = async (line) => {
        results.push(line);
        await logProgress(line);
    };

    await logProgress('Старт self-test...');
    const rooms = await DB.getRooms(true);
    const room = rooms[0];

    if (!room) {
        await pushResult('❌ Немає активних кімнат для тесту.');
        return results;
    }

    await logProgress(`Кімната для тесту: ${room.name}`);

    const testUserId = ctx.from.id;
    let testDate = now.plus({ days: 5 }).toISODate();
    let testSlot = ['21-22'];
    const unique = `${now.toMillis()}_${Math.floor(Math.random() * 1000)}`;
    const singleClientName = `SELFTEST_SINGLE_${unique}`;
    const seriesClientName = `SELFTEST_SERIES_${unique}`;
    const seriesId = `selftest_${unique}`;

    // Підбираємо гарантовано вільний слот на найближчі 14 днів.
    const candidateSlots = [
        '10-11','11-12','12-13','13-14','14-15','15-16',
        '16-17','17-18','18-19','19-20','20-21','21-22'
    ];
    let foundFree = false;
    for (let d = 5; d <= 18 && !foundFree; d++) {
        const dateCandidate = now.plus({ days: d }).toISODate();
        const busy = await DB.getBookedSlots(dateCandidate, room.id);
        const freeSlot = candidateSlots.find(s => !busy.includes(s));
        if (freeSlot) {
            testDate = dateCandidate;
            testSlot = [freeSlot];
            foundFree = true;
        }
    }

    if (!foundFree) {
        await pushResult('❌ Self-test: не знайдено вільного слоту для тесту (на 14 днів вперед).');
        return results;
    }

    await logProgress(`Тестовий слот: ${testDate} ${testSlot[0]}`);

    try {
        await logProgress('Крок 1/6: перевірка читання користувачів...');
        await DB.getAllUsers();
        await pushResult('✅ БД: читання користувачів працює.');
    } catch (e) {
        await pushResult(`❌ БД: помилка читання користувачів: ${e.message}`);
    }

    let singleBookingId = null;
    try {
        await logProgress('Крок 2/7: створення одиночної броні...');
        singleBookingId = await DB.saveBooking(
            testUserId,
            room.id,
            room.name,
            testDate,
            testSlot,
            '',
            null,
            null,
            singleClientName,
            'SELFTEST_BAND',
            false,
            false
        );

        const bookedSlots = await DB.getBookedSlots(testDate, room.id);
        const hasSlot = bookedSlots.includes(testSlot[0]);
        if (!hasSlot) {
            await pushResult('❌ Бронювання: слот не зʼявився в зайнятих.');
        } else {
            const bySlot = await DB.getBookingBySlot(testDate, room.id, testSlot[0]);
            if (bySlot && bySlot.client_name === singleClientName) {
                await pushResult('✅ Бронювання: створення і перевірка слоту працює.');
            } else {
                await pushResult('❌ Бронювання: getBookingBySlot повернув некоректні дані.');
            }
        }
    } catch (e) {
        await pushResult(`❌ Бронювання: помилка створення/перевірки: ${e.message}`);
    }

    // Реальна перевірка Google Calendar (створення -> статус -> видалення -> статус)
    let gcalEventId = null;
    if (GCal) {
        try {
            await logProgress('Крок 3/7: перевірка Google Calendar (create/get/delete)...');
            gcalEventId = await GCal.createEvent(room.id, testDate, testSlot, {
                name: `SELFTEST_GCAL_${unique}`,
                phone: 'SELFTEST',
                band: 'SELFTEST_BAND',
                equipment: ''
            });

            if (!gcalEventId) {
                await pushResult('❌ Google Calendar: подію не створено (event id порожній).');
            } else {
                await pushResult(`✅ Google Calendar: подію створено (${gcalEventId}).`);

                const statusBeforeDelete = await GCal.getEventStatus(room.id, gcalEventId);
                if (statusBeforeDelete === 'active') {
                    await pushResult('✅ Google Calendar: статус події active.');
                } else {
                    await pushResult(`❌ Google Calendar: неочікуваний статус до видалення: ${statusBeforeDelete}.`);
                }

                await GCal.deleteEvent(room.id, gcalEventId);
                const statusAfterDelete = await GCal.getEventStatus(room.id, gcalEventId);
                if (statusAfterDelete === 'not_found' || statusAfterDelete === 'cancelled') {
                    await pushResult('✅ Google Calendar: подію успішно видалено.');
                } else {
                    await pushResult(`⚠️ Google Calendar: після видалення отримано статус ${statusAfterDelete}.`);
                }
            }
        } catch (e) {
            await pushResult(`❌ Google Calendar: помилка перевірки: ${e.message}`);

            // Best-effort cleanup, якщо подію все ж створило до помилки.
            if (gcalEventId) {
                try { await GCal.deleteEvent(room.id, gcalEventId); } catch (_) {}
            }
        }
    } else {
        await pushResult('⚠️ Google Calendar: сервіс не підключено, крок пропущено.');
    }

    if (singleBookingId) {
        try {
            await logProgress('Крок 4/7: відміна одиночної броні...');
            await DB.cancelBooking(singleBookingId);
            const afterCancel = await DB.getBookingById(singleBookingId);
            if (afterCancel && afterCancel.status === 'cancelled') {
                await pushResult('✅ Відміна однієї броні: працює.');
            } else {
                await pushResult('❌ Відміна однієї броні: статус не змінився на cancelled.');
            }
        } catch (e) {
            await pushResult(`❌ Відміна однієї броні: помилка: ${e.message}`);
        }
    }

    let seriesBookingA = null;
    let seriesBookingB = null;
    try {
        await logProgress('Крок 5/7: створення серії з 2 подій...');
        const dateA = now.plus({ days: 6 }).toISODate();
        const dateB = now.plus({ days: 13 }).toISODate();

        seriesBookingA = await DB.saveBooking(
            testUserId,
            room.id,
            room.name,
            dateA,
            testSlot,
            '',
            null,
            seriesId,
            seriesClientName,
            'SELFTEST_BAND',
            false,
            false
        );

        seriesBookingB = await DB.saveBooking(
            testUserId,
            room.id,
            room.name,
            dateB,
            testSlot,
            '',
            null,
            seriesId,
            seriesClientName,
            'SELFTEST_BAND',
            false,
            false
        );

        const seriesBefore = await DB.getSeriesBookings(seriesId);
        if (seriesBefore.length === 2) {
            await pushResult('✅ Серія: створення 2 подій працює.');
        } else {
            await pushResult(`❌ Серія: очікувалось 2 події, отримано ${seriesBefore.length}.`);
        }
    } catch (e) {
        await pushResult(`❌ Серія: помилка створення: ${e.message}`);
    }

    if (seriesBookingA && seriesBookingB) {
        try {
            await logProgress('Крок 6/7: відміна однієї події з серії...');
            await DB.cancelBooking(seriesBookingA);
            const afterOneCancel = await DB.getSeriesBookings(seriesId);
            if (afterOneCancel.length === 1) {
                await pushResult('✅ Серія: відміна однієї події з серії працює.');
            } else {
                await pushResult(`❌ Серія: після відміни однієї очікувалось 1, отримано ${afterOneCancel.length}.`);
            }

            await logProgress('Крок 7/7: відміна всієї серії...');
            await DB.cancelSeries(seriesId);
            const afterSeriesCancel = await DB.getSeriesBookings(seriesId);
            if (afterSeriesCancel.length === 0) {
                await pushResult('✅ Серія: відміна всієї серії працює.');
            } else {
                await pushResult(`❌ Серія: після cancelSeries лишилось ${afterSeriesCancel.length} активних подій.`);
            }
        } catch (e) {
            await pushResult(`❌ Серія: помилка відміни: ${e.message}`);
        }
    }

    try {
        await logProgress('Фінальна перевірка очищення тестових броней...');
        const userBookings = await DB.getUserBookings(testUserId);
        const hasActiveSelftest = userBookings.some(b =>
            String(b.client_name || '').startsWith('SELFTEST_')
        );
        if (!hasActiveSelftest) {
            await pushResult('✅ Self-test: активних тестових броней не лишилось.');
        } else {
            await pushResult('⚠️ Self-test: знайдено активні тестові броні (перевірте вручну).');
        }
    } catch (e) {
        await pushResult(`❌ Self-test: помилка фінальної перевірки: ${e.message}`);
    }

    await logProgress('Self-test завершено. Формую підсумковий звіт...');

    return results;
};

const executeSelfTestCommand = async (ctx) => {
    await ctx.reply('🧪 Запускаю self-test бронювань. Прогрес буде нижче:');
    const progressLines = [];
    const progressMsg = await ctx.reply('🧪 Self-test виконується...');

    const progressReporter = async (line) => {
        progressLines.push(line);
        const tail = progressLines.slice(-12);
        const text = ['🧪 Self-test виконується...', '', ...tail].join('\n');
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, text);
        } catch (e) {
            // Ігноруємо "message is not modified" та інші не-критичні помилки оновлення прогресу
        }
    };

    try {
        const results = await runSystemSelfTest(ctx, progressReporter);
        const passed = results.filter(line => line.startsWith('✅')).length;
        const failed = results.filter(line => line.startsWith('❌')).length;
        const warnings = results.filter(line => line.startsWith('⚠️')).length;

        const report = [
            '🧪 Результат self-test',
            `✅ Успішно: ${passed}`,
            `❌ Помилок: ${failed}`,
            `⚠️ Попереджень: ${warnings}`,
            '',
            ...results
        ].join('\n');

        try {
            await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, '✅ Self-test завершено. Дивись підсумок нижче.');
        } catch (e) {}

        await ctx.reply(report);
    } catch (error) {
        try {
            await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined, `❌ Self-test впав: ${error.message}`);
        } catch (e) {}
        await ctx.reply(`❌ Self-test завершився з помилкою: ${error.message}`);
    }
};

const composer = new Composer();

// --- ВХІД В АДМІНКУ ---
composer.hears('⚙️ Адмін панель', async (ctx) => {
    if (await checkIsAdmin(ctx)) await ctx.reply('Вітаю в панелі керування 🛠', KB.adminMenu);
});

// --- ПОШУК КОРИСТУВАЧА ПО ID ---
composer.hears('🔍 Пошук користувача', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    ctx.session.admin.searchMode = true;
    await ctx.reply('📝 Введіть Telegram ID користувача для пошуку:', Markup.inlineKeyboard([
        [Markup.button.callback('↩️ Назад', 'search_back_to_admin')]
    ]));
});

composer.action('search_back_to_admin', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.admin.searchMode = false;
    await ctx.deleteMessage();
    await ctx.reply('Що робимо далі?', KB.adminMenu);
});

composer.on('message', async (ctx, next) => {
    if (ctx.session.admin?.searchMode && ctx.message?.text) {
        const userId = String(ctx.message.text).trim();
        
        // Перевіряємо чи це число
        if (!/^\d+$/.test(userId)) {
            return ctx.reply('❌ Будь ласка, введіть коректний ID (тільки цифри)');
        }
        
        const user = await DB.getUser(userId);
        ctx.session.admin.searchMode = false;
        
        if (!user) {
            return ctx.reply(`❌ Користувача з ID ${userId} не знайдено в базі.`);
        }
        
        // Формуємо інформацію про користувача
        const adminStatus = user.is_admin ? '✅' : '❌';
        const residentStatus = user.is_resident ? '✅' : '❌';
        const bannedStatus = user.is_banned ? '🔴 Заблокований' : '🟢 Активний';
        
        const userInfo = `👤 *КОРИСТУВАЧ*\n\n` +
            `🆔 ID: ${user.telegram_id}\n` +
            `📱ім'я: ${user.first_name}\n` +
            `📞 Телефон: ${user.phone_number || '-'}\n` +
            `🎸 Гурт: ${user.band_name || '-'}\n` +
            `👮 Адмін: ${adminStatus}\n` +
            `🎓 Резидент: ${residentStatus}\n` +
            `Статус: ${bannedStatus}`;
        
        const buttons = [
            [Markup.button.callback(user.is_admin ? '❌ Зняти адміна' : '✅ Зробити адміном', `admin_toggle_${userId}`)],
            [Markup.button.callback(user.is_resident ? '❌ Зняти резидента' : '✅ Зробити резидентом', `resident_toggle_${userId}`)],
            [Markup.button.callback(user.is_banned ? '🟢 Розблокувати' : '🔴 Заблокувати', `ban_toggle_${userId}`)],
            [Markup.button.callback('⬅️ Назад', 'back_to_admin_menu')]
        ];
        
        return ctx.reply(userInfo, Markup.inlineKeyboard(buttons));
    }
    return next();
});

composer.action('back_to_admin_menu', async (ctx) => {
    ctx.session.admin.searchMode = false;
    await ctx.deleteMessage();
    await ctx.reply('Що робимо далі?', KB.adminMenu);
});

// --- РУЧНЕ БРОНЮВАННЯ (ЗАПУСК СЦЕНИ) ---
composer.hears('➕ Створити бронь', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const rooms = await DB.getRooms(true);
    
    ctx.session.admin.isManualBooking = true; 
    ctx.session.booking = { equipment: [] };  
    await ctx.reply('Оберіть кімнату для ручного бронювання 🚪', KB.roomSelector(rooms, 'book'));
});

// --- ФІНАЛІЗАЦІЯ РУЧНОГО БРОНЮВАННЯ ---
composer.action(/adm_rec_(\d+)/, async (ctx) => {
    try {
        const rawValue = String(ctx.match[1]).trim();
        const weeks = parseInt(rawValue, 10);
        
        if (isNaN(weeks) || weeks < 1) {
            return ctx.answerCbQuery('❌ Помилка: неправильна кількість тижнів', { show_alert: true });
        }
        
        ctx.session = ctx.session || {};
        ctx.session.admin = ctx.session.admin || {};
        ctx.session.admin.selectedWeeks = weeks;
        const autoRenew = weeks === 24;
        const booking = ctx.session.booking || {};
        
        if (!booking.roomId || !booking.date || !booking.slots || booking.slots.length === 0) {
            return ctx.answerCbQuery('❌ Помилка: не вистачає даних броні', { show_alert: true });
        }

        await ctx.answerCbQuery('⏳ Який момент, завантажуємо...', { show_alert: false });
        
        const plan = await buildSeriesPlan(booking, weeks);
        
        // Кешіруємо план для подальшого використання
        ctx.session.admin.cachedPlan = plan;

        ctx.session.admin.pendingSeries = { weeks, autoRenew };
        try {
            await ctx.editMessageText(
                formatSeriesPreview(booking, weeks, plan, autoRenew),
                KB.recurringPreviewKeyboard(plan.some(entry => entry.available), autoRenew)
            );
        } catch (e) {
            await ctx.reply(
                formatSeriesPreview(booking, weeks, plan, autoRenew),
                KB.recurringPreviewKeyboard(plan.some(entry => entry.available), autoRenew)
            );
        }
    } catch (error) {
        console.error('[ERROR] adm_rec_(\d+):', error);
        await ctx.answerCbQuery('❌ Помилка завантаження', { show_alert: true });
    }
});

composer.action('adm_rec_back', async (ctx) => {
    delete ctx.session.admin.pendingSeries;
    delete ctx.session.admin.cachedPlan;
    try {
        await ctx.editMessageText('🔄 Як часто повторювати цю бронь?', KB.recurringKeyboard);
    } catch (e) {
        await ctx.reply('🔄 Як часто повторювати цю бронь?', KB.recurringKeyboard);
    }
});

composer.action('adm_rec_cancel', async (ctx) => {
    delete ctx.session.admin.pendingSeries;
    delete ctx.session.admin.cachedPlan;
    ctx.session.admin.isManualBooking = false;
    ctx.session.booking = {};
    await ctx.editMessageText('Створення серії скасовано.');
    await ctx.reply('Що робимо далі?', KB.adminMenu);
});

composer.action('adm_rec_confirm', async (ctx) => {
    const pendingSeries = ctx.session.admin?.pendingSeries;
    const booking = ctx.session.booking || {};

    if (!pendingSeries || !booking.roomId || !booking.date || !booking.slots?.length) {
        await ctx.answerCbQuery('Дані серії не знайдені', { show_alert: true });
        return;
    }

    await ctx.answerCbQuery('⏳ Створюю серію...');

    try {
        await ctx.editMessageText('⏳ Створення серії бронювань...');
    } catch (e) {
        await ctx.reply('⏳ Створення серії бронювань...');
    }

    try {
        const { weeks, autoRenew } = pendingSeries;
        const seriesId = Date.now().toString() + Math.floor(Math.random() * 1000);
        // Використовуємо кешований план замість пересчету щоб уникнути тайм-аутів Google Calendar
        const plan = ctx.session.admin.cachedPlan || await buildSeriesPlan(booking, weeks);
        const createdDates = [];
        const skippedDates = [];
        const timeout = (promise, ms) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
        ]);

        // Fail-fast: якщо Google API вже "висить", не блокуємо створення серії.
        let gcalAvailable = !!GCal;
        if (gcalAvailable && booking.roomId && booking.date) {
            try {
                await timeout(GCal.getBusySlots(booking.roomId, booking.date), 2500);
            } catch (e) {
                gcalAvailable = false;
                console.log('[WARNING] Google Calendar unavailable during series confirm, fallback to DB-only:', e.message);
            }
        }

        for (const entry of plan) {
            if (!entry.available) {
                skippedDates.push(`${entry.date} (${entry.conflicts.join(', ')})`);
                continue;
            }

            let googleEventId = null;
            try {
                if (gcalAvailable) {
                    googleEventId = await timeout(
                        GCal.createEvent(booking.roomId, entry.date, booking.slots, buildGoogleUserInfo(booking)),
                        2500
                    );
                }
            } catch (gcalError) {
                console.log('[WARNING] Google Calendar createEvent timeout/error for', entry.date, gcalError.message);
                // Не перериваємо, створюємо бронь без Google Event ID і вимикаємо GCal для цієї серії.
                gcalAvailable = false;
            }

            await DB.saveBooking(
                Number.isFinite(parseInt(booking.userId, 10)) ? parseInt(booking.userId, 10) : 0,
                booking.roomId,
                booking.roomName,
                entry.date,
                booking.slots,
                '',
                googleEventId,
                seriesId,
                booking.manualName,
                booking.manualBand,
                autoRenew,
                booking.manualIsResident
            );
            createdDates.push(entry.date);
        }

        delete ctx.session.admin.pendingSeries;
    delete ctx.session.admin.cachedPlan;
        ctx.session.admin.isManualBooking = false;
        ctx.session.booking = {};

        if (createdDates.length === 0) {
            await ctx.reply('❌ Не вдалося створити серію: усі дати зайняті.', KB.adminMenu);
            return;
        }

        let msg = `✅ Успішно створено серію!\n👤 ${booking.manualName} (${booking.manualBand || '-'})${booking.manualIsResident ? ' 🎓 (Резидент)' : ''}\n⏰ ${booking.slots.join(', ')}\n📅 Створено: ${createdDates.length}\n🆔 Серія ID: ${seriesId}`;
        if (autoRenew) msg += `\n♾️ Автоподовження: увімкнено`;
        if (skippedDates.length > 0) msg += `\n\n⚠️ Пропущено дати:\n${skippedDates.join('\n')}`;
        await ctx.reply(msg, KB.adminMenu);

        if (Number.isFinite(parseInt(booking.userId, 10)) && parseInt(booking.userId, 10) > 0) {
            try {
                let userMsg = `✅ Для вас створено бронювання адміністратором.\n\n🚪 ${booking.roomName}\n⏰ ${booking.slots.join(', ')}\n📅 Дати:\n${createdDates.join('\n')}`;
                if (skippedDates.length > 0) userMsg += `\n\n⚠️ Не створено (зайнято):\n${skippedDates.join('\n')}`;
                await ctx.telegram.sendMessage(parseInt(booking.userId, 10), userMsg);
            } catch (e) {}
        }

        await notifyAdmins(
            ctx.telegram,
            `🆕 БРОНЮВАННЯ ВІД АДМІНА\n\n👤 Клієнт: ${booking.manualName} (${booking.manualBand || '-'})${booking.manualIsResident ? ' 🎓 (Резидент)' : ''}\n🆔 <code>${booking.userId || 0}</code>\n🚪 <b>${booking.roomName}</b>\n⏰ ${booking.slots.join(', ')}\n📅 Створено дат: ${createdDates.length}${autoRenew ? '\n♾️ Автоподовження: так' : ''}`,
            { parse_mode: 'HTML' }
        );
    } catch (error) {
        console.error('[ERROR] adm_rec_confirm:', error);
        await ctx.reply(`❌ Помилка при створенні серії: ${error.message}`, KB.adminMenu);
    }
});


// --- КЕРУВАННЯ АДМІНАМИ ---
composer.hears('👮‍♂️ Адміністратори', async (ctx) => {
    if (String(ctx.from.id) !== process.env.ADMIN_ID) return ctx.reply('Доступно тільки власнику.');
    const users = await DB.getAllUsers();
    await ctx.reply('Керування адміністраторами:', KB.adminListMenu(users, process.env.ADMIN_ID));
});

composer.action(/admin_toggle_(.+)/, async (ctx) => {
    if (String(ctx.from.id) !== process.env.ADMIN_ID) return;
    const targetId = ctx.match[1];
    const user = await DB.getUser(targetId);
    await DB.setAdminStatus(targetId, !user.is_admin);
    const users = await DB.getAllUsers();
    await ctx.editMessageReplyMarkup(KB.adminListMenu(users, process.env.ADMIN_ID).reply_markup);
    try {
        const msg = !user.is_admin ? '🎉 Вам надано права адміністратора.' : 'ℹ️ Ваші права адміністратора скасовано.';
        await ctx.telegram.sendMessage(targetId, msg);
    } catch (e) {}
});

// --- КЕРУВАННЯ РЕЗИДЕНТАМИ ---
composer.hears('🎓 Резиденти', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const users = await DB.getAllUsers();
    await ctx.reply('Натисніть на юзера:', KB.residentListMenu(users));
});

composer.action(/resident_toggle_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const targetId = ctx.match[1];
    const user = await DB.getUser(targetId);
    await DB.setResidentStatus(targetId, !user.is_resident);
    const users = await DB.getAllUsers();
    await ctx.editMessageReplyMarkup(KB.residentListMenu(users).reply_markup);
});

// --- КЕРУВАННЯ КІМНАТАМИ ---
composer.hears('🏠 Налаштування кімнат', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const rooms = await DB.getRooms(false);
    await ctx.reply('Керування кімнатами:', KB.adminRoomList(rooms));
});

composer.action(/adm_room_toggle_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const roomId = ctx.match[1];
    const room = await DB.getRoom(roomId);
    await DB.updateRoom(roomId, 'is_active', room.is_active ? 0 : 1);
    const rooms = await DB.getRooms(false);
    await ctx.editMessageText('Керування кімнатами:', KB.adminRoomList(rooms));
});

composer.action(/adm_room_edit_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    ctx.session.admin.step = 'edit_room_name';
    ctx.session.admin.roomId = ctx.match[1];
    await ctx.reply('Введіть нову назву кімнати:', KB.skipBtn);
});

composer.action(/adm_room_delete_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const roomId = ctx.match[1];
    await DB.deleteRoom(roomId);
    const rooms = await DB.getRooms(false);
    if (rooms.length === 0) {
        await ctx.editMessageText('Кімнат більше немає.');
    } else {
        await ctx.editMessageText('Керування кімнатами:', KB.adminRoomList(rooms));
    }
});

// Обробка тексту для редагування кімнат
composer.on('message', async (ctx, next) => {
    // 1. Розсилка
    if (await checkIsAdmin(ctx) && ctx.session.admin?.step === 'broadcast_wait') {
        if (!ctx.message) return next();
        ctx.session.admin.broadcastMsgId = ctx.message.message_id;
        ctx.session.admin.step = 'broadcast_confirm';
        await ctx.reply('👀 Попередній перегляд:');
        await ctx.telegram.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id);
        return ctx.reply('Надіслати всім?', KB.broadcastConfirmBtn);
    }

    // 2. Редагування кімнат
    if (await checkIsAdmin(ctx) && ctx.session.admin?.step?.startsWith('edit_room') && ctx.message.text) {
        const { step, roomId } = ctx.session.admin;
        const text = ctx.message.text;
        if (step === 'edit_room_name') {
            if (text !== 'Пропустити') await DB.updateRoom(roomId, 'name', text);
            ctx.session.admin.step = 'edit_room_desc';
            return ctx.reply('Введіть опис:', KB.skipBtn);
        }
        if (step === 'edit_room_desc') {
            if (text !== 'Пропустити') await DB.updateRoom(roomId, 'description', text);
            ctx.session.admin.step = 'edit_room_price';
            return ctx.reply('Посилання на фото прайсу:', KB.skipBtn);
        }
        if (step === 'edit_room_price') {
            if (text !== 'Пропустити') await DB.updateRoom(roomId, 'price_image', text);
            ctx.session.admin.step = null;
            return ctx.reply('Завершено ✅', KB.adminMenu);
        }
    }
    return next();
});

// Кнопка пропуску для редагування кімнат
composer.action('skip_step', async (ctx) => {
    if (!ctx.session.admin?.step) return;
    const step = ctx.session.admin.step;
    if (step === 'edit_room_name') { ctx.session.admin.step = 'edit_room_desc'; return ctx.reply('Введіть опис:', KB.skipBtn); }
    if (step === 'edit_room_desc') { ctx.session.admin.step = 'edit_room_price'; return ctx.reply('Посилання на фото:', KB.skipBtn); }
    if (step === 'edit_room_price') { ctx.session.admin.step = null; return ctx.reply('Завершено ✅', KB.adminMenu); }
});

// --- ЧОРНИЙ СПИСОК ---
composer.hears('⬛ Чорний список', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const users = await DB.getAllUsers();
    await ctx.reply('Керування баном:', KB.blacklistMenu(users));
});

composer.action(/ban_toggle_(.+)/, async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const targetId = ctx.match[1];
    const user = await DB.getUser(targetId);
    await DB.toggleBan(targetId, !user.is_banned);
    const users = await DB.getAllUsers();
    await ctx.editMessageReplyMarkup(KB.blacklistMenu(users).reply_markup);
});

// --- РОЗСИЛКА ---
composer.hears('📨 Розсилка', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    ctx.session.admin.step = 'broadcast_wait'; 
    await ctx.reply('Надішліть повідомлення (текст/фото/відео) для розсилки:', Markup.inlineKeyboard([[Markup.button.callback('❌ Скасувати', 'broadcast_cancel')]]));
});

composer.action('broadcast_cancel', async (ctx) => {
    ctx.session.admin = {}; 
    await ctx.reply('Розсилку скасовано.', KB.adminMenu);
    await ctx.deleteMessage();
});

composer.action('broadcast_send', async (ctx) => {
    if (!ctx.session.admin?.broadcastMsgId) return ctx.reply('Помилка: немає повідомлення.');
    const allUsers = await DB.getAllUsers();
    const users = allUsers.filter(u => !u.is_banned);
    await ctx.reply(`🚀 Старт розсилки на ${users.length} юзерів...`);
    let success = 0;
    for (const user of users) {
        try {
            await ctx.telegram.copyMessage(user.telegram_id, ctx.from.id, ctx.session.admin.broadcastMsgId);
            success++;
        } catch (e) {}
        await new Promise(r => setTimeout(r, 50)); 
    }
    ctx.session.admin = {}; 
    await ctx.reply(`✅ Завершено!\nОтримали: ${success}`, KB.adminMenu);
});

// --- СКАСУВАННЯ СЕРІЙ ---
composer.hears('🔄 Регулярні броні', async (ctx) => {
    if (!await checkIsAdmin(ctx)) return;
    const series = await DB.getActiveSeries();
    if (!series || series.length === 0) return ctx.reply('Активних регулярних бронювань немає.');
    ctx.reply('Оберіть серію для СКАСУВАННЯ:', KB.seriesList(series));
});

composer.action(/^cancel_series_(\d+)$/, async (ctx) => {
    const seriesId = ctx.match[1];
    const bookings = await DB.getSeriesBookings(seriesId);
    
    if (bookings.length > 0 && GCal) {
        const idsToDelete = bookings.filter(b => b.google_event_id).map(b => b.google_event_id).join(',');
        if (idsToDelete) await GCal.deleteEvent(bookings[0].room_id, idsToDelete);
    }
    await DB.cancelSeries(seriesId);
    await ctx.editMessageText('✅ Серію регулярних бронювань успішно скасовано.');

    const actor = await DB.getUser(ctx.from.id);
    const actorName = actor ? `${actor.first_name} (${actor.phone_number || '-'})` : `ID ${ctx.from.id}`;
    await notifyAdmins(ctx.telegram, `⚠️ СКАСУВАННЯ СЕРІЇ АДМІНОМ\n\n👤 Адмін: ${actorName}\n🆔 Серія: <code>${seriesId}</code>\n📅 Подій у серії: ${bookings.length}`, { parse_mode: 'HTML' });
});

module.exports = composer;