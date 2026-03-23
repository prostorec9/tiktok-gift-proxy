const express = require('express');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const tiktokConnections = new Map();

const SELF_URL = process.env.SERVER_URL || 'https://tiktok-gift-proxy.onrender.com';

// Папка для кеша картинок
const CACHE_DIR = path.join('/tmp', 'gift_images');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Кеш URL картинок из extendedGiftInfo
const giftImageUrlCache = new Map();

// Пинг чтобы не засыпал
setInterval(() => {
    https.get(SELF_URL + '/ping', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.json({ status: 'running', version: '5.0' }));

// Отдаём картинку подарка — сначала из кеша файлов, потом проксируем
app.get('/gift-image/:giftId', async (req, res) => {
    const giftId = req.params.giftId;
    const cachePath = path.join(CACHE_DIR, `${giftId}.png`);

    // Если есть в файловом кеше — отдаём сразу
    if (fs.existsSync(cachePath)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return fs.createReadStream(cachePath).pipe(res);
    }

    // Если есть реальный URL из TikTok API
    if (giftImageUrlCache.has(giftId)) {
        const url = giftImageUrlCache.get(giftId);
        return proxyAndCache(url, cachePath, res);
    }

    // Пробуем разные CDN URL
    const urls = [
        `https://p16-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
        `https://p19-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
        `https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/gift_${giftId}~tplv-obj.image`,
    ];

    tryUrls(urls, 0, cachePath, res);
});

function tryUrls(urls, idx, cachePath, res) {
    if (idx >= urls.length) {
        return res.status(404).send('Gift image not found');
    }
    proxyAndCache(urls[idx], cachePath, res, () => {
        tryUrls(urls, idx + 1, cachePath, res);
    });
}

function proxyAndCache(url, cachePath, res, onError) {
    const options = {
        headers: {
            'Referer': 'https://www.tiktok.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'image/webp,image/apng,image/*,*/*',
        }
    };

    const get = url.startsWith('https') ? https.get : http.get;
    const req = get(url, options, (r) => {
        if (r.statusCode === 301 || r.statusCode === 302) {
            return proxyAndCache(r.headers.location, cachePath, res, onError);
        }
        if (r.statusCode !== 200) {
            r.resume();
            if (onError) return onError();
            return res.status(r.statusCode).send('Not found');
        }

        const contentType = r.headers['content-type'] || 'image/png';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Пишем в файл и одновременно отдаём клиенту
        const fileStream = fs.createWriteStream(cachePath);
        r.pipe(fileStream);
        r.pipe(res);

        fileStream.on('error', () => {});
    });
    req.on('error', () => {
        if (onError) onError();
        else res.status(500).send('Proxy error');
    });
}

// Проксируем аватарки
app.get('/avatar', (req, res) => {
    const avatarUrl = req.query.url;
    if (!avatarUrl) return res.status(400).send('No URL');
    proxyAndCache(decodeURIComponent(avatarUrl), null, res);
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

        // Сохраняем реальный URL картинки из extendedGiftInfo
        let giftImageUrl = `${SELF_URL}/gift-image/${data.giftId}`;

        if (data.extendedGiftInfo) {
            const ext = data.extendedGiftInfo;
            let realUrl = null;

            if (ext.image) {
                if (ext.image.url_list && ext.image.url_list.length > 0) {
                    realUrl = ext.image.url_list[0];
                } else if (typeof ext.image === 'string') {
                    realUrl = ext.image;
                }
            }

            if (realUrl) {
                // Кешируем реальный URL
                giftImageUrlCache.set(String(data.giftId), realUrl);
                // Предзагружаем в файловый кеш
                const cachePath = path.join(CACHE_DIR, `${data.giftId}.png`);
                if (!fs.existsSync(cachePath)) {
                    proxyAndCache(realUrl, cachePath, { setHeader: () => {}, pipe: () => {} }, () => {});
                }
            }
        }

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
server.listen(PORT, () => console.log(`🚀 Server v5 on port ${PORT}`));
