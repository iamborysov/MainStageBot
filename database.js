const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./bot_database.db');

db.serialize(() => {
    // 1. СТВОРЕННЯ ТАБЛИЦЬ
    db.run(`CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        phone_number TEXT,
        band_name TEXT,
        is_admin INTEGER DEFAULT 0,
        is_resident INTEGER DEFAULT 0,
        is_banned INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        room_id TEXT,
        room_name TEXT,
        date TEXT,
        time_slots TEXT,
        equipment TEXT,
        status TEXT DEFAULT 'active',
        google_event_id TEXT, 
        series_id TEXT,
        client_name TEXT, 
        band_name TEXT,
        auto_renew INTEGER DEFAULT 0,
        is_resident_booking INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        price_image TEXT,
        is_active INTEGER DEFAULT 1
    )`);
    
    // 2. МІГРАЦІЇ
    db.all("PRAGMA table_info(bookings)", (err, rows) => {
        if (err) return;
        if (!rows.some(r => r.name === 'google_event_id')) db.run("ALTER TABLE bookings ADD COLUMN google_event_id TEXT");
        if (!rows.some(r => r.name === 'status')) db.run("ALTER TABLE bookings ADD COLUMN status TEXT DEFAULT 'active'");
        if (!rows.some(r => r.name === 'equipment')) db.run("ALTER TABLE bookings ADD COLUMN equipment TEXT");
        if (!rows.some(r => r.name === 'series_id')) db.run("ALTER TABLE bookings ADD COLUMN series_id TEXT");
        if (!rows.some(r => r.name === 'client_name')) db.run("ALTER TABLE bookings ADD COLUMN client_name TEXT");
        if (!rows.some(r => r.name === 'band_name')) db.run("ALTER TABLE bookings ADD COLUMN band_name TEXT");
        if (!rows.some(r => r.name === 'auto_renew')) db.run("ALTER TABLE bookings ADD COLUMN auto_renew INTEGER DEFAULT 0");
        if (!rows.some(r => r.name === 'is_resident_booking')) db.run("ALTER TABLE bookings ADD COLUMN is_resident_booking INTEGER DEFAULT 0");
    });

    db.all("PRAGMA table_info(users)", (err, rows) => {
        if (err) return;
        if (!rows.some(r => r.name === 'is_admin')) db.run("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0");
        if (!rows.some(r => r.name === 'is_banned')) db.run("ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0");
        if (!rows.some(r => r.name === 'is_resident')) db.run("ALTER TABLE users ADD COLUMN is_resident INTEGER DEFAULT 0");
    });
});

const initRooms = () => {
    db.get("SELECT count(*) as count FROM rooms", (err, row) => {
        if (row && row.count === 0) {
            const stmt = db.prepare("INSERT INTO rooms (id, name, description, price_image) VALUES (?, ?, ?, ?)");
            stmt.run('main', 'MAIN ROOM [42m2]', 'Опис Main Room...', 'https://i.ibb.co/99FWsKYN/image.png');
            stmt.run('standart', 'STANDART ROOM [24m2]', 'Опис Standart Room...', 'https://i.ibb.co/Q3jGM1wJ/image.png');
            stmt.finalize();
        }
    });
};
initRooms();

// --- API ФУНКЦІЇ ---

const getUser = (id) => {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE telegram_id = ?", [id], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
};

const getAllUsers = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM users", (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

const saveUser = (user) => {
    return new Promise((resolve, reject) => {
        const { telegram_id, username, first_name, phone_number, band_name } = user;
        db.run(`INSERT INTO users (telegram_id, username, first_name, phone_number, band_name) 
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(telegram_id) DO UPDATE SET 
                username=excluded.username, 
                first_name=excluded.first_name, 
                phone_number=excluded.phone_number, 
                band_name=excluded.band_name`, 
                [telegram_id, username, first_name, phone_number, band_name], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

const toggleBan = (userId, status) => {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET is_banned = ? WHERE telegram_id = ?", [status ? 1 : 0, userId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

const setAdminStatus = (userId, isAdmin) => {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET is_admin = ? WHERE telegram_id = ?", [isAdmin ? 1 : 0, userId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

const setResidentStatus = (userId, isResident) => {
    return new Promise((resolve, reject) => {
        db.run("UPDATE users SET is_resident = ? WHERE telegram_id = ?", [isResident ? 1 : 0, userId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

const getRooms = (activeOnly = true) => {
    return new Promise((resolve, reject) => {
        const sql = activeOnly ? "SELECT * FROM rooms WHERE is_active = 1" : "SELECT * FROM rooms";
        db.all(sql, (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

const getRoom = (id) => {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM rooms WHERE id = ?", [id], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
};

const updateRoom = (id, field, value) => {
    const allowedFields = ['name', 'description', 'price_image', 'is_active'];
    if (!allowedFields.includes(field)) return Promise.reject(new Error(`Invalid field: ${field}`));
    return new Promise((resolve, reject) => {
        db.run(`UPDATE rooms SET ${field} = ? WHERE id = ?`, [value, id], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

const getBookedSlots = (date, roomId) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT time_slots FROM bookings WHERE date = ? AND room_id = ? AND status = 'active'", [date, roomId], (err, rows) => {
            if (err) reject(err);
            let slots = [];
            if (rows) {
                rows.forEach(row => {
                    slots = slots.concat(row.time_slots.split(','));
                });
            }
            resolve(slots);
        });
    });
};

const getBookingsByDate = (date) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM bookings WHERE date = ? AND status = 'active'", [date], (err, rows) => {
            if (err) reject(err);
            resolve(rows || []);
        });
    });
};

const getBookingBySlot = (date, roomId, slot) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM bookings WHERE date = ? AND room_id = ? AND status = 'active'", [date, roomId], (err, rows) => {
            if (err) reject(err);
            const booking = rows ? rows.find(row => row.time_slots.split(',').includes(slot)) : null;
            resolve(booking);
        });
    });
};

const saveBooking = (userId, roomId, roomName, date, slots, equipment, eventId = null, seriesId = null, clientName = null, bandName = null, autoRenew = false, isResidentBooking = false) => {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO bookings (user_id, room_id, room_name, date, time_slots, equipment, google_event_id, series_id, client_name, band_name, auto_renew, is_resident_booking) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, roomId, roomName, date, slots.join(','), equipment, eventId, seriesId, clientName, bandName, autoRenew ? 1 : 0, isResidentBooking ? 1 : 0], function(err) {
            if (err) reject(err);
            resolve(this.lastID);
        });
    });
};

const getUserBookings = (userId) => {
    return new Promise((resolve, reject) => {
        const todayStr = new Date().toISOString().slice(0, 10);
        db.all(`SELECT * FROM bookings WHERE user_id = ? AND status = 'active' AND date >= ? ORDER BY date ASC`, [userId, todayStr], (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

const cancelBooking = (bookingId) => {
    return new Promise((resolve, reject) => {
        db.run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [bookingId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

const getBookingById = (bookingId) => {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM bookings WHERE id = ?", [bookingId], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
};

// --- СЕРІЇ ---
const getActiveSeries = () => {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT series_id, room_name, time_slots, date, client_name, band_name, MAX(auto_renew) as auto_renew, count(*) as count 
            FROM bookings 
            WHERE series_id IS NOT NULL AND status = 'active'
            GROUP BY series_id
            ORDER BY date ASC
        `;
        db.all(sql, (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

const getSeriesBookings = (seriesId) => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM bookings WHERE series_id = ? AND status = 'active'", [seriesId], (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

const getAutoRenewSeries = () => {
    return new Promise((resolve, reject) => {
        const sql = `
            SELECT 
                series_id,
                room_id,
                room_name,
                time_slots,
                client_name,
                band_name,
                MAX(date) as last_date,
                MAX(auto_renew) as auto_renew,
                MAX(is_resident_booking) as is_resident_booking
            FROM bookings
            WHERE series_id IS NOT NULL AND status = 'active' AND auto_renew = 1
            GROUP BY series_id
            ORDER BY last_date ASC
        `;
        db.all(sql, (err, rows) => {
            if (err) reject(err);
            resolve(rows || []);
        });
    });
};

const cancelSeries = (seriesId) => {
    return new Promise((resolve, reject) => {
        db.run("UPDATE bookings SET status = 'cancelled' WHERE series_id = ?", [seriesId], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

// --- СИНХРОНІЗАЦІЯ: Отримати майбутні активні з Google ID ---
const getFutureActiveBookingsWithEvent = () => {
    return new Promise((resolve, reject) => {
        const todayStr = new Date().toISOString().slice(0, 10); 
        const sql = `
            SELECT * FROM bookings 
            WHERE status = 'active' 
            AND google_event_id IS NOT NULL 
            AND date >= ?
        `;
        db.all(sql, [todayStr], (err, rows) => {
            if (err) reject(err);
            resolve(rows || []);
        });
    });
};

const deleteRoom = (id) => {
    return new Promise((resolve, reject) => {
        db.run("DELETE FROM rooms WHERE id = ?", [id], (err) => {
            if (err) reject(err);
            resolve();
        });
    });
};

module.exports = { 
    getUser, getAllUsers, saveUser, toggleBan, setAdminStatus, setResidentStatus,
    getRooms, getRoom, updateRoom, deleteRoom,
    getBookedSlots, getBookingsByDate, getBookingBySlot, 
    saveBooking, getUserBookings, cancelBooking, getBookingById,
    getActiveSeries, getSeriesBookings, getAutoRenewSeries, cancelSeries,
    getFutureActiveBookingsWithEvent
};