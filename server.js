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

// Кеш: giftId -> реальный URL картинки
const giftUrlCache = new Map();

// Не засыпаем
setInterval(() => {
    https.get(SELF_URL + '/ping', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.json({ status: 'running', version: '6.0' }));

// Простое проксирование картинки по URL
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
            return res.status(upstream.statusCode).send('Not found');
        }
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        upstream.pipe(res);
    }).on('error', (e) => {
        console.error('Proxy error:', e.message);
        if (!res.headersSent) res.status(500).send('Proxy error');
    });
}

// Картинка подарка
app.get('/gift-image/:giftId', (req, res) => {
    const giftId = req.params.giftId;

    if (giftUrlCache.has(giftId)) {
        return proxyUrl(giftUrlCache.get(giftId), res);
    }

    // Пробуем стандартные CDN
    const urls = [
        `https://p16-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
        `https://p19-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
    ];

    tryNextUrl(urls, 0, res);
});

function tryNextUrl(urls, idx, res) {
    if (idx >= urls.length) return res.status(404).send('Not found');

    const options = {
        headers: {
            'Referer': 'https://www.tiktok.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        }
    };

    https.get(urls[idx], options, (upstream) => {
        if (upstream.statusCode === 200) {
            res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.setHeader('Access-Control-Allow-Origin', '*');
            upstream.pipe(res);
        } else {
            upstream.resume();
            tryNextUrl(urls, idx + 1, res);
        }
    }).on('error', () => tryNextUrl(urls, idx + 1, res));
}

// Аватарки
app.get('/avatar', (req, res) => {
    const avatarUrl = req.query.url;
    if (!avatarUrl) return res.status(400).send('No URL');
    proxyUrl(decodeURIComponent(avatarUrl), res);
});

// WebSocket
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

        // Получаем реальный URL картинки из extendedGiftInfo
        let giftImageUrl = `${SELF_URL}/gift-image/${data.giftId}`;

        try {
            if (data.extendedGiftInfo && data.extendedGiftInfo.image) {
                const img = data.extendedGiftInfo.image;
                let realUrl = null;
                if (img.url_list && img.url_list.length > 0) realUrl = img.url_list[0];
                else if (img.uri) realUrl = `https://p16-webcast.tiktokcdn.com/img/${img.uri}~tplv-obj.image`;
                else if (typeof img === 'string') realUrl = img;

                if (realUrl) {
                    giftUrlCache.set(String(data.giftId), realUrl);
                    giftImageUrl = `${SELF_URL}/gift-image/${data.giftId}`;
                }
            }
        } catch(e) {}

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
server.listen(PORT, () => console.log(`🚀 Server v6 on port ${PORT}`));
