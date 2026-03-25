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

// Не засыпаем
setInterval(() => {
    https.get(SELF_URL + '/ping', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.json({ status: 'ok', version: '9.0' }));

// Универсальный прокси для ЛЮБОГО изображения
app.get('/img', (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('No URL');
    fetchImage(decodeURIComponent(url), res);
});

function fetchImage(url, res, redirectCount = 0) {
    if (redirectCount > 5) return res.status(500).send('Too many redirects');
    if (!url) return res.status(404).send('No URL');

    const getter = url.startsWith('https') ? https : http;
    const opts = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://www.tiktok.com/',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        }
    };

    getter.get(url, opts, (r) => {
        if (r.statusCode === 301 || r.statusCode === 302) {
            r.resume();
            return fetchImage(r.headers.location, res, redirectCount + 1);
        }
        if (r.statusCode !== 200) {
            r.resume();
            return res.status(r.statusCode).send('Upstream error: ' + r.statusCode);
        }
        res.setHeader('Content-Type', r.headers['content-type'] || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');
        r.pipe(res);
    }).on('error', (e) => {
        if (!res.headersSent) res.status(500).send('Error: ' + e.message);
    });
}

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

        // Получаем реальный URL картинки из разных мест
        let realPictureUrl = null;

        // Вариант 1: giftPictureUrl — самый надёжный
        if (data.giftPictureUrl && data.giftPictureUrl.length > 0) {
            realPictureUrl = data.giftPictureUrl;
        }
        // Вариант 2: extendedGiftInfo
        else if (data.extendedGiftInfo) {
            const ext = data.extendedGiftInfo;
            if (ext.image && ext.image.url_list && ext.image.url_list.length > 0) {
                realPictureUrl = ext.image.url_list[0];
            } else if (ext.image && ext.image.uri) {
                realPictureUrl = `https://p16-webcast.tiktokcdn.com/img/${ext.image.uri}~tplv-obj.image`;
            }
        }

        // Формируем URL через наш прокси
        const giftImageUrl = realPictureUrl
            ? `${SELF_URL}/img?url=${encodeURIComponent(realPictureUrl)}`
            : '';

        const avatarUrl = data.profilePictureUrl
            ? `${SELF_URL}/img?url=${encodeURIComponent(data.profilePictureUrl)}`
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

        console.log(`[🎁] ${msg.nickname} → ${msg.giftName} | imgUrl: ${realPictureUrl ? realPictureUrl.substring(0, 60) : 'NONE'}`);
        clientWs.send(JSON.stringify(msg));
    });

    tiktok.on('error', err => console.error(`[!] ${err.message}`));

    clientWs.on('close', () => {
        const conn = tiktokConnections.get(clientWs);
        if (conn) { conn.disconnect(); tiktokConnections.delete(clientWs); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server v9 port ${PORT}`));
