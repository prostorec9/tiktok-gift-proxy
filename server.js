const express = require('express');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Хранилище активных подключений к TikTok
const tiktokConnections = new Map();

app.get('/', (req, res) => {
    res.json({ 
        status: 'running', 
        message: 'TikTok Gift Proxy Server',
        usage: 'Connect via WebSocket: ws://yourserver/ws?username=tiktokuser'
    });
});

// Проверка что стример онлайн
app.get('/check/:username', async (req, res) => {
    const username = req.params.username;
    try {
        const tiktok = new WebcastPushConnection(username);
        const state = await tiktok.getRoomInfo();
        res.json({ online: true, roomId: state.room_id });
    } catch (e) {
        res.json({ online: false, error: e.message });
    }
});

wss.on('connection', (clientWs, req) => {
    // Получаем username из URL параметра
    const url = new URL(req.url, 'http://localhost');
    const username = url.searchParams.get('username');

    if (!username) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'Username не указан' }));
        clientWs.close();
        return;
    }

    console.log(`[+] Клиент подключился для @${username}`);

    // Подключаемся к TikTok LIVE
    const tiktok = new WebcastPushConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: true,
        enableWebsocketUpgrade: true,
        requestPollingIntervalMs: 2000,
        clientParams: {
            app_language: 'ru-RU',
            device_platform: 'web',
        }
    });

    // Сохраняем соединение
    tiktokConnections.set(clientWs, tiktok);

    // Подключаемся к стриму
    tiktok.connect().then(state => {
        console.log(`[✓] Подключено к @${username}, roomId: ${state.roomId}`);
        
        // Уведомляем клиента
        if (clientWs.readyState === 1) {
            clientWs.send(JSON.stringify({ 
                type: 'connected', 
                username: username,
                roomId: state.roomId 
            }));
        }

    }).catch(err => {
        console.error(`[✗] Ошибка подключения к @${username}:`, err.message);
        if (clientWs.readyState === 1) {
            clientWs.send(JSON.stringify({ 
                type: 'error', 
                message: `Стример @${username} не в эфире или ошибка: ${err.message}` 
            }));
        }
    });

    // ── СОБЫТИЯ ПОДАРКОВ ──
    tiktok.on('gift', data => {
        if (clientWs.readyState !== 1) return;

        // Отправляем только финальные подарки (не стрики)
        if (data.giftType === 1 && !data.repeatEnd) return;

        const giftMsg = {
            type: 'gift',
            nickname: data.nickname || data.uniqueId || 'Аноним',
            username: data.uniqueId || '',
            avatarUrl: data.profilePictureUrl || '',
            giftId: data.giftId,
            giftName: data.giftName || 'Gift',
            giftImageUrl: `https://p16-webcast.tiktokcdn.com/img/gift_${data.giftId}~tplv-obj.image`,
            giftCount: data.repeatCount || 1,
            diamondCount: data.diamondCount || 0
        };

        console.log(`[🎁] ${giftMsg.nickname} отправил ${giftMsg.giftName} x${giftMsg.giftCount}`);
        clientWs.send(JSON.stringify(giftMsg));
    });

    // Отключение клиента
    clientWs.on('close', () => {
        console.log(`[-] Клиент отключился от @${username}`);
        const tiktokConn = tiktokConnections.get(clientWs);
        if (tiktokConn) {
            tiktokConn.disconnect();
            tiktokConnections.delete(clientWs);
        }
    });

    clientWs.on('error', (err) => {
        console.error('Client WS error:', err.message);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 TikTok Gift Proxy запущен на порту ${PORT}`);
});
