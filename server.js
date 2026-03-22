const express = require('express');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const http = require('http');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const tiktokConnections = new Map();

// Проксируем картинки подарков с TikTok CDN
app.get('/gift-image/:giftId', (req, res) => {
    const giftId = req.params.giftId;
    const urls = [
        `https://p16-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
        `https://p19-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
        `https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/gift_${giftId}~tplv-obj.image`,
    ];
    fetchWithFallback(urls, 0, res);
});

// Проксируем аватарки
app.get('/avatar', (req, res) => {
    const avatarUrl = req.query.url;
    if (!avatarUrl) { res.status(400).send('No URL'); return; }
    try {
        https.get(decodeURIComponent(avatarUrl), {
            headers: { 'Referer': 'https://www.tiktok.com/', 'User-Agent': 'Mozilla/5.0' }
        }, (r) => {
            res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            r.pipe(res);
        }).on('error', () => res.status(500).send('Failed'));
    } catch(e) { res.status(400).send('Invalid URL'); }
});

function fetchWithFallback(urls, index, res) {
    if (index >= urls.length) { res.status(404).send('Not found'); return; }
    https.get(urls[index], {
        headers: { 'Referer': 'https://www.tiktok.com/', 'User-Agent': 'Mozilla/5.0' }
    }, (r) => {
        if (r.statusCode === 200) {
            res.setHeader('Content-Type', r.headers['content-type'] || 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.setHeader('Access-Control-Allow-Origin', '*');
            r.pipe(res);
        } else {
            fetchWithFallback(urls, index + 1, res);
        }
    }).on('error', () => fetchWithFallback(urls, index + 1, res));
}

app.get('/', (req, res) => res.json({ status: 'running', version: '2.0' }));

wss.on('connection', (clientWs, req) => {
    const url = new URL(req.url, 'http://localhost');
    const username = url.searchParams.get('username');
    if (!username) { clientWs.send(JSON.stringify({ type: 'error', message: 'Username не указан' })); clientWs.close(); return; }

    console.log(`[+] @${username}`);
    const tiktok = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000,
    });
    tiktokConnections.set(clientWs, tiktok);

    tiktok.connect().then(state => {
        console.log(`[✓] Connected @${username}`);
        if (clientWs.readyState === 1)
            clientWs.send(JSON.stringify({ type: 'connected', username, roomId: state.roomId }));
    }).catch(err => {
        console.error(`[✗] @${username}:`, err.message);
        if (clientWs.readyState === 1)
            clientWs.send(JSON.stringify({ type: 'error', message: `Стример @${username} не в эфире` }));
    });

    tiktok.on('gift', data => {
        if (clientWs.readyState !== 1) return;
        if (data.giftType === 1 && !data.repeatEnd) return;

        const base = process.env.SERVER_URL || 'https://tiktok-gift-proxy.onrender.com';
        const giftImageUrl = `${base}/gift-image/${data.giftId}`;
        const avatarUrl = data.profilePictureUrl
            ? `${base}/avatar?url=${encodeURIComponent(data.profilePictureUrl)}`
            : '';

        const msg = {
            type: 'gift',
            nickname: data.nickname || data.uniqueId || 'Аноним',
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

    clientWs.on('close', () => {
        const conn = tiktokConnections.get(clientWs);
        if (conn) { conn.disconnect(); tiktokConnections.delete(clientWs); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server v2 on port ${PORT}`));
