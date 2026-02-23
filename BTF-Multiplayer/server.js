const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const http = require('http');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Use environment variable for public tunnel URL
const TUNNEL_URL = process.env.API_URL || 'https://your-tunnel.trycloudflare.com';

// Middleware
app.use(cors());
app.use(express.json());

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// In-memory storage (replace with database in production)
const players = new Map(); // username -> { username, password_hash, coins, inventory, fruits, ws, online }
const tradeOffers = new Map(); // tradeId -> { from, to, fromItems, toItems, status, timestamp }

// Password hashing helper (simple SHA256, use bcrypt in production)
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Generate unique IDs
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Broadcast to specific player (by username)
function sendToPlayer(username, message) {
    const player = players.get(username);
    if (player && player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(message));
    }
}

// Broadcast to all connected players
function broadcast(message, excludeUsername = null) {
    players.forEach((player, username) => {
        if (username !== excludeUsername && player.ws && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    let username = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            switch (msg.type) {
                case 'register':
                    // Get username from message or from auth header
                    username = msg.username;
                    if (!username || !players.has(username)) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Invalid or unregistered username'
                        }));
                        break;
                    }

                    const player = players.get(username);
                    player.ws = ws;
                    player.online = true;

                    ws.send(JSON.stringify({
                        type: 'registered',
                        username: username,
                        message: 'Connected to BTF Server'
                    }));

                    const playerList = Array.from(players.values())
                        .filter(p => p.online)
                        .map(p => ({
                            username: p.username,
                            online: p.online
                        }));
                    broadcast({ type: 'playerList', players: playerList });
                    break;

                case 'getPlayers':
                    const onlinePlayers = Array.from(players.values())
                        .filter(p => p.online && p.username !== username)
                        .map(p => ({
                            username: p.username
                        }));
                    ws.send(JSON.stringify({
                        type: 'playerList',
                        players: onlinePlayers
                    }));
                    break;

                case 'proposeTrade':
                    const fromPlayer = players.get(username);
                    const toPlayer = players.get(msg.toUsername);

                    if (!fromPlayer || !toPlayer) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Player not found' }));
                        break;
                    }

                    const tradeId = generateId();
                    tradeOffers.set(tradeId, {
                        id: tradeId,
                        from: username,
                        to: msg.toUsername,
                        fromItems: msg.fromItems || { pets: {}, fruits: {}, coins: 0 },
                        toItems: msg.toItems || { pets: {}, fruits: {}, coins: 0 },
                        status: 'pending',
                        timestamp: Date.now()
                    });

                    sendToPlayer(msg.toUsername, {
                        type: 'tradeReceived',
                        trade: {
                            id: tradeId,
                            from: { username: fromPlayer.username },
                            fromItems: msg.fromItems,
                            toItems: msg.toItems
                        }
                    });

                    ws.send(JSON.stringify({
                        type: 'tradeSent',
                        tradeId: tradeId,
                        message: 'Trade offer sent'
                    }));
                    break;

                case 'saveState':
                    if (username && players.has(username)) {
                        const player = players.get(username);
                        Object.assign(player, msg.state || {});
                        ws.send(JSON.stringify({
                            type: 'stateSaved',
                            success: true
                        }));
                    }
                    break;

                case 'loadState':
                    if (username && players.has(username)) {
                        const player = players.get(username);
                        ws.send(JSON.stringify({
                            type: 'stateLoaded',
                            state: {
                                coins: player.coins || 0,
                                inventory: player.inventory || {},
                                fruits: player.fruits || {}
                            }
                        }));
                    }
                    break;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Invalid message format'
            }));
        }
    });

    ws.on('close', () => {
        if (username && players.has(username)) {
            players.get(username).online = false;
            broadcast({ type: 'playerOffline', username: username });
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// REST API endpoints

app.get('/', (req, res) => res.send('BTF backend is running!'));

// Authentication endpoint
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    // Validation
    if (!username || !password) {
        return res.json({ success: false, message: 'Username and password are required.' });
    }

    if (username.length < 3) {
        return res.json({ success: false, message: 'Username must be at least 3 characters.' });
    }

    if (password.length < 4) {
        return res.json({ success: false, message: 'Password must be at least 4 characters.' });
    }

    const passwordHash = hashPassword(password);

    // Check if user exists
    if (players.has(username)) {
        const player = players.get(username);
        // Verify password
        if (player.password_hash === passwordHash) {
            res.json({ success: true, message: 'Logged in successfully!' });
        } else {
            res.json({ success: false, message: 'Incorrect password.' });
        }
    } else {
        // Create new account
        players.set(username, {
            username: username,
            password_hash: passwordHash,
            coins: 2000,
            enchantPoints: 0,
            inventory: {},
            fruits: {},
            petEnchantments: {},
            petNames: {},
            ws: null,
            online: false
        });
        res.json({ success: true, message: 'Account created successfully!' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        players: players.size,
        trades: tradeOffers.size,
        uptime: process.uptime()
    });
});

app.get('/api/players', (req, res) => {
    const playerList = Array.from(players.values())
        .filter(p => p.online)
        .map(p => ({
            username: p.username,
            online: p.online
        }));
    res.json({ players: playerList });
});

app.get('/health', (req, res) => res.json({ status: 'OK' }));
// Start server
server.listen(PORT, () => { 
    console.log(` BTF Server running on port ${PORT}`);
    console.log(`   WebSocket: wss://${TUNNEL_URL.replace(/^https?:\/\//, '')}`);
    console.log(`   HTTP API: ${TUNNEL_URL}`);
});

// Cleanup old trades every 5 minutes
setInterval(() => {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    tradeOffers.forEach((trade, id) => {
        if (now - trade.timestamp > fiveMinutes && trade.status !== 'completed') {
            tradeOffers.delete(id);
        }
    });
}, fiveMinutes);