# Main Stage Bot — Workspace Instructions

Telegram booking bot for a Ukrainian recording studio built with Node.js + Telegraf v4.

## Architecture

| File/Folder | Role |
|---|---|
| `index.js` | Entry point — wires bot, middleware, scenes, controllers, cron |
| `database.js` | SQLite abstraction — all DB methods return Promises |
| `calendar_service.js` | Google Calendar integration (event create/delete/busy-check) |
| `sheets_service.js` | Google Sheets logging (registration & booking rows) |
| `keyboards.js` | All Telegraf `Markup` keyboard builders |
| `text.js` | Static Ukrainian UI strings |
| `controllers/` | Composer-based route handlers (user, booking, admin flows) |
| `scenes/` | Multi-step wizard flows (`WizardScene`) |
| `cron/jobs.js` | Scheduled tasks — daily reminders (19:00 UTC+2) and 10-min GCal sync |
| `utils/helpers.js` | `checkIsAdmin()`, `generateUserCalendarLink()` |

Architecture summary: middleware pipeline → controller `Composer`s → `WizardScene` for multi-step forms → optional Google API services that **fail gracefully** (try-catch; never crash the bot).

## Build & Run

```bash
npm install
node index.js
```

No build step. Requires `.env` in project root (see below) and `google_key.json` (Google service account key — excluded from git).

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `BOT_TOKEN` | ✅ | Telegram Bot API token |
| `ADMIN_ID` | ✅ | Telegram user ID of the super-admin |
| `CALENDAR_ID_MAIN` | optional | Google Calendar ID for Main Room |
| `CALENDAR_ID_STANDART` | optional | Google Calendar ID for Standart Room |
| `SPREADSHEET_ID` | optional | Google Sheet ID for logging |

Database file (`bot_database.db`) is auto-created on first run.

## Conventions

- **Language**: All UI text and comments are in Ukrainian.
- **Async style**: Prefer `async/await`. `database.js` uses Promise-wrapped callbacks.
- **Controllers**: Each controller is a `new Composer()`. Register it in `index.js` with `bot.use()`.
- **Button actions**: Follow the `{action}_{param}` pattern (e.g., `cancel_booking_123`, `time_select_10-11`). Extract params via regex in `.action(/pattern/, ...)`.
- **Session state**: Booking progress lives in `ctx.session.booking`; admin wizard state in `ctx.session.admin`. Always reset after flow completion.
- **Time slots**: Stored as comma-separated hour ranges, e.g., `"10-11,11-12"`. Working hours: 10:00–22:00.
- **Date handling**: Use [Luxon](https://moment.github.io/luxon/) with `Asia/Nicosia` timezone (UTC+2). Never use `Date` directly.
- **Google API calls**: Wrap in try-catch. Failure must not block the user flow or crash the bot.
- **Admin permissions**: Super-admin = `process.env.ADMIN_ID`. DB admins = `is_admin = 1`. Check via `checkIsAdmin(ctx)` from `utils/helpers.js`.
- **Emoji prefixes**: Buttons use emoji (📅 🎸 ⚙️ ✅ ❌ ➕) — maintain consistency when adding new buttons.

## Database Schema (SQLite)

```sql
users    (telegram_id PK, username, first_name, phone_number, band_name, is_admin, is_resident, is_banned)
bookings (id PK, user_id, room_id, room_name, date, time_slots, equipment, status,
          google_event_id, series_id, client_name, band_name, created_at)
rooms    (id PK, name, description, price_image, is_active)
```

## Key User Flows

1. **Registration**: `/start` → phone number → band name (`registrationScene`)
2. **Booking**: "📅 Розклад" → room → date (calendar picker) → time slots (grid) → equipment → confirm
3. **Admin booking**: "➕ Створити бронь" → `adminBookingScene` wizard → supports recurring (1 week / 4 weeks / 6 months)
4. **Background sync**: Every 10 min cron checks GCal for deleted events → cancels matching DB bookings → notifies users
