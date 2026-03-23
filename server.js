const express = require('express');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const http = require('http');
const https = require('https');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const tiktokConnections = new Map();

// Кеш картинок подарков — загружаем один раз
const giftImageCache = new Map();

// Не даём серверу засыпать
const SELF_URL = process.env.SERVER_URL || 'https://tiktok-gift-proxy.onrender.com';
setInterval(() => {
    https.get(SELF_URL + '/ping', () => {}).on('error', () => {});
}, 10 * 60 * 1000);

app.get('/ping', (req, res) => res.send('pong'));
app.get('/', (req, res) => res.json({ status: 'running', version: '4.0' }));

// Проксируем картинки — через кеш реальных URL из TikTok API
app.get('/gift-image/:giftId', async (req, res) => {
    const giftId = parseInt(req.params.giftId);
    
    // Если есть реальный URL в кеше — используем его
    if (giftImageCache.has(giftId)) {
        const imageUrl = giftImageCache.get(giftId);
        return proxyImage(imageUrl, res);
    }
    
    // Fallback — стандартные CDN URL
    const urls = [
        `https://p16-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
        `https://p19-webcast.tiktokcdn.com/img/gift_${giftId}~tplv-obj.image`,
    ];
    fetchWithFallback(urls, 0, res);
});

// Проксируем аватарки
app.get('/avatar', (req, res) => {
    const avatarUrl = req.query.url;
    if (!avatarUrl) { res.status(400).send('No URL'); return; }
    proxyImage(decodeURIComponent(avatarUrl), res);
});

function proxyImage(url, res) {
    try {
        const options = {
            headers: {
                'Referer': 'https://www.tiktok.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            }
        };
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, options, (r) => {
            if (r.statusCode === 301 || r.statusCode === 302) {
                return proxyImage(r.headers.location, res);
            }
            if (r.statusCode === 200) {
                res.setHeader('Content-Type', r.headers['content-type'] || 'image/png');
                res.setHeader('Cache-Control', 'public, max-age=86400');
                res.setHeader('Access-Control-Allow-Origin', '*');
                r.pipe(res);
            } else {
                res.status(r.statusCode).send('Image not available');
            }
        }).on('error', () => res.status(500).send('Proxy error'));
    } catch(e) {
        res.status(400).send('Invalid URL');
    }
}

function fetchWithFallback(urls, index, res) {
    if (index >= urls.length) { res.status(404).send('Not found'); return; }
    proxyImage(urls[index], {
        setHeader: res.setHeader.bind(res),
        status: res.status.bind(res),
        send: res.send.bind(res),
        pipe: (stream) => stream.pipe(res),
    });
}

// Загружаем список всех подарков и кешируем картинки
async function preloadGiftImages() {
    try {
        console.log('[*] Загружаем список подарков TikTok...');
        const tempConn = new WebcastPushConnection('_', {
            enableExtendedGiftInfo: true,
        });
        const gifts = await tempConn.getAvailableGifts();
        if (gifts && gifts.length > 0) {
            gifts.forEach(gift => {
                if (gift.id && gift.image && gift.image.url_list && gift.image.url_list.length > 0) {
                    giftImageCache.set(gift.id, gift.image.url_list[0]);
                }
            });
            console.log(`[✓] Загружено ${giftImageCache.size} картинок подарков`);
        }
    } catch(e) {
        console.log('[!] Не удалось загрузить список подарков:', e.message);
    }
}

// Запускаем загрузку при старте
preloadGiftImages();
// Обновляем каждые 6 часов
setInterval(preloadGiftImages, 6 * 60 * 60 * 1000);

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
            console.log(`[✓] Connected @${username} roomId=${state.roomId}`);
            if (clientWs.readyState === 1) {
                clientWs.send(JSON.stringify({ type: 'connected', username, roomId: state.roomId }));
            }
        })
        .catch(err => {
            console.error(`[✗] @${username}: ${err.message}`);
            if (clientWs.readyState === 1) {
                clientWs.send(JSON.stringify({ type: 'error', message: `@${username} не в эфире` }));
            }
        });

    tiktok.on('gift', data => {
        if (clientWs.readyState !== 1) return;
        if (data.giftType === 1 && !data.repeatEnd) return;

        // Берём реальный URL картинки из данных подарка или из кеша
        let giftImageUrl = '';
        if (data.extendedGiftInfo && data.extendedGiftInfo.image && 
            data.extendedGiftInfo.image.url_list && data.extendedGiftInfo.image.url_list.length > 0) {
            // Реальный URL прямо из события!
            const realUrl = data.extendedGiftInfo.image.url_list[0];
            giftImageUrl = `${SELF_URL}/avatar?url=${encodeURIComponent(realUrl)}`;
        } else if (giftImageCache.has(data.giftId)) {
            const realUrl = giftImageCache.get(data.giftId);
            giftImageUrl = `${SELF_URL}/avatar?url=${encodeURIComponent(realUrl)}`;
        } else {
            giftImageUrl = `${SELF_URL}/gift-image/${data.giftId}`;
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
        console.log(`[🎁] ${msg.nickname} → ${msg.giftName} x${msg.giftCount} | img: ${giftImageUrl.substring(0, 60)}`);
        clientWs.send(JSON.stringify(msg));
    });

    tiktok.on('error', err => console.error(`[!] ${err.message}`));

    clientWs.on('close', () => {
        const conn = tiktokConnections.get(clientWs);
        if (conn) { conn.disconnect(); tiktokConnections.delete(clientWs); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server v4 on port ${PORT}`));
