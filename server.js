const express = require('express');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const http = require('http');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const tiktokConnections = new Map();

const SELF_URL = process.env.SERVER_URL || 'https://tiktok-gift-proxy.onrender.com';
const giftUrlCache = new Map();
let lastGiftDebug = null; // Сохраняем последний подарок для диагностики

setInterval(() => {
    https.get(SELF_URL + '/ping', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.json({ status: 'running', version: '8.0' }));

// Диагностика — показывает структуру последнего подарка
app.get('/debug', (req, res) => {
    res.json({ lastGift: lastGiftDebug });
});

function proxyUrl(imageUrl, res) {
    if (!imageUrl) return res.status(404).send('No URL');
    const options = {
        headers: {
            'Referer': 'https://www.tiktok.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/webp,image/apng,image/*,*/*',
        }
    };
    const getter = imageUrl.startsWith('https://') ? https : http;
    getter.get(imageUrl, options, (upstream) => {
        if (upstream.statusCode === 301 || upstream.statusCode === 302) {
            return proxyUrl(upstream.headers.location, res);
        }
        if (upstream.statusCode !== 200) {
            upstream.resume();
            return res.status(upstream.statusCode).send('Not found: ' + upstream.statusCode);
        }
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        upstream.pipe(res);
    }).on('error', (e) => {
        if (!res.headersSent) res.status(500).send('Error: ' + e.message);
    });
}

app.get('/gift-image/:giftId', (req, res) => {
    const giftId = req.params.giftId;
    if (giftUrlCache.has(giftId)) {
        return proxyUrl(giftUrlCache.get(giftId), res);
    }
    // Пробуем CDN напрямую
    proxyUrl(`https://p16-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`, res);
});

app.get('/avatar', (req, res) => {
    const avatarUrl = req.query.url;
    if (!avatarUrl) return res.status(400).send('No URL');
    proxyUrl(decodeURIComponent(avatarUrl), res);
});

wss.on('connection', (clientWs, req) => {
    const url = new URL(req.url, 'http://localhost');
    const username = url.searchParams.get('username');
    if (!username) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Username не указан' }));
        clientWs.close();
        return;
    }

    console.log(`[+] @${username}`);

    const tiktok = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000,
    });

    tiktokConnections.set(clientWs, tiktok);

    tiktok.connect()
        .then(state => {
            console.log(`[✓] @${username} roomId=${state.roomId}`);
            if (clientWs.readyState === 1)
                clientWs.send(JSON.stringify({ type: 'connected', username, roomId: state.roomId }));
        })
        .catch(err => {
            console.error(`[✗] @${username}: ${err.message}`);
            if (clientWs.readyState === 1)
                clientWs.send(JSON.stringify({ type: 'error', message: `@${username} не в эфире` }));
        });

    tiktok.on('gift', data => {
        if (clientWs.readyState !== 1) return;
        if (data.giftType === 1 && !data.repeatEnd) return;

        // Сохраняем для диагностики
        lastGiftDebug = {
            giftId: data.giftId,
            giftName: data.giftName,
            extendedGiftInfo: data.extendedGiftInfo,
            giftPictureUrl: data.giftPictureUrl,
            allKeys: Object.keys(data),
        };

        // Ищем URL картинки во всех возможных местах
        let realImageUrl = null;

        if (data.giftPictureUrl) {
            realImageUrl = data.giftPictureUrl;
        } else if (data.extendedGiftInfo) {
            const ext = data.extendedGiftInfo;
            if (ext.image) {
                if (ext.image.url_list && ext.image.url_list.length > 0) realImageUrl = ext.image.url_list[0];
                else if (ext.image.uri) realImageUrl = `https://p16-webcast.tiktokcdn.com/img/${ext.image.uri}~tplv-obj.image`;
                else if (typeof ext.image === 'string') realImageUrl = ext.image;
            }
            if (!realImageUrl && ext.icon) {
                if (ext.icon.url_list && ext.icon.url_list.length > 0) realImageUrl = ext.icon.url_list[0];
            }
        }

        if (realImageUrl) {
            giftUrlCache.set(String(data.giftId), realImageUrl);
            console.log(`[IMG] Found real URL for gift ${data.giftId}: ${realImageUrl.substring(0, 80)}`);
        }

        const giftImageUrl = `${SELF_URL}/gift-image/${data.giftId}`;
        const avatarUrl = data.profilePictureUrl
            ? `${SELF_URL}/avatar?url=${encodeURIComponent(data.profilePictureUrl)}`
            : '';

        const msg = {
            type: 'gift',
            nickname: data.nickname || data.uniqueId || 'User',
            username: data.uniqueId || '',
            avatarUrl,
            giftId: data.giftId,
            giftName: data.giftName || 'Gift',
            giftImageUrl,
            giftCount: data.repeatCount || 1,
        };

        console.log(`[🎁] ${msg.nickname} → ${msg.giftName} x${msg.giftCount}`);
        clientWs.send(JSON.stringify(msg));
    });

    tiktok.on('error', err => console.error(`[!] ${err.message}`));

    clientWs.on('close', () => {
        const conn = tiktokConnections.get(clientWs);
        if (conn) { conn.disconnect(); tiktokConnections.delete(clientWs); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server v7 on port ${PORT}`));
```

**Commit** → подожди 2 минуты → подключись к стримеру → дождись любого подарка → зайди в браузере на:
```
https://tiktok-gift-proxy.onrender.com/debug
