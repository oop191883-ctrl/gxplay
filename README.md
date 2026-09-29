# GXPLAY backend + Admin panel

## Chalane ka tarika (Node 22.13+ chahiye, koi npm install nahi)
    cp .env.example .env      # ADMIN_USER / ADMIN_PASS badal lein
    node --disable-warning=ExperimentalWarning server.js
- Website:  http://localhost:3000
- Admin:    http://localhost:3000/admin

Aapki index.html `public/` folder me hai aur pehle se `/api/...` use karti hai, isliye usme koi change nahi chahiye.
Data `data/gxplay.db` (SQLite) me save hota hai - isko backup rakhein.

## Deploy (mobile se aasan): Render.com / Railway / VPS
- Start command: `npm start`
- Env vars: ADMIN_USER, ADMIN_PASS, (optional) TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
- IMPORTANT: ek persistent disk lagayein aur `DATA_DIR` uss disk ke path par set karein, warna redeploy par users/balance delete ho jayenge.
- HTTPS zaroor use karein (Render/Railway automatic dete hain).

## Admin panel me kya hai
Home (stats) - Users (search, edit, balance add/remove, block, password reset, user ka address change, delete, CSV)
Deposits (approve = balance auto add / reject) - Addresses (website ke deposit addresses badlein, turant live)
More (Telegram alert, admin password, activity log)
Naya user register hone par admin page par alert + beep, aur Telegram set ho to phone par message.
