const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const rooms = {};
const RANK_ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUIT_ORDER = ['♣', '♦', '♥', '♠'];

// --- 規則判斷引擎 (維持不變) ---
function getCardValue(card) {
    return RANK_ORDER.indexOf(card.rank) * 4 + SUIT_ORDER.indexOf(card.suit);
}

function checkPattern(cards) {
    const len = cards.length;
    const sorted = [...cards].sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank) || SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit));
    const ranks = sorted.map(c => RANK_ORDER.indexOf(c.rank));
    if (len === 1) return { type: 1, power: getCardValue(sorted[0]), label: "單張" };
    if (len === 2 && sorted[0].rank === sorted[1].rank) return { type: 2, power: getCardValue(sorted[1]), label: "對子" };
    if (len === 5) {
        const isFlush = sorted.every(c => c.suit === sorted[0].suit);
        let isStraight = true;
        for (let i = 0; i < 4; i++) if (ranks[i+1] !== ranks[i] + 1) isStraight = false;
        const counts = {};
        ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
        const freq = Object.values(counts).sort((a,b)=>b-a);
        if (isStraight && isFlush) return { type: 7, power: getCardValue(sorted[4]), label: "同花順" };
        if (freq[0] === 4) return { type: 6, power: ranks.find(r => counts[r] === 4), label: "鐵支" };
        if (freq[0] === 3 && freq[1] === 2) return { type: 5, power: ranks.find(r => counts[r] === 3), label: "葫蘆" };
        if (isFlush) return { type: 4, power: getCardValue(sorted[4]), label: "同花" };
        if (isStraight) return { type: 3, power: getCardValue(sorted[4]), label: "順子" };
    }
    return null;
}

// --- 動態發牌函式 ---
function dealCards(playerCount) {
    let deck = [];
    for(let r of RANK_ORDER) for(let s of SUIT_ORDER) deck.push({rank: r, suit: s});
    deck.sort(() => Math.random() - 0.5);

    const perPlayer = Math.floor(52 / playerCount); // 3人為17張, 4人為13張
    let hands = [];
    for (let i = 0; i < playerCount; i++) {
        hands.push(deck.slice(i * perPlayer, (i + 1) * perPlayer));
    }
    // 剩下的餘牌（例如 3 人時剩 1 張）在大老二通常不處理或歸房主，這裡選擇直接棄用或分給第一位
    return hands;
}

io.on('connection', (socket) => {
    socket.on('createRoom', (name) => {
        const id = Math.floor(1000 + Math.random() * 9000).toString();
        rooms[id] = { players: [], lastPlay: null, turn: 0, started: false, passCount: 0, isOver: false };
        rooms[id].players.push({id: socket.id, name: name, cardCount: 0});
        socket.join(id);
        socket.emit('init', { playerIndex: 0, roomID: id, isHost: true });
    });

    socket.on('joinRoom', (data) => {
        const room = rooms[data.roomID];
        if (room && room.players.length < 4 && !room.started) {
            room.players.push({id: socket.id, name: data.playerName, cardCount: 0});
            socket.join(data.roomID);
            socket.emit('init', { playerIndex: room.players.length - 1, roomID: data.roomID, isHost: false });
            io.to(data.roomID).emit('systemMsg', `👤 ${data.playerName} 加入了房間 (${room.players.length}/4)`);
        } else {
            socket.emit('errorMsg', '房間不存在、人數已滿或已開賽');
        }
    });

    socket.on('startGame', (roomID) => {
        const room = rooms[roomID];
        if (!room) return;
        // 修改門檻：至少 3 人
        if (room.players.length < 3) return socket.emit('errorMsg', '❌ 至少需要 3 位玩家才能開始遊戲');
        
        room.started = true;
        const hands = dealCards(room.players.length);
        
        let firstTurn = 0;
        room.players.forEach((p, i) => {
            const hand = hands[i];
            p.cardCount = hand.length; // 更新每人牌數
            // 檢查誰拿梅花 3
            if (hand.some(c => c.rank === '3' && c.suit === '♣')) firstTurn = i;
            io.to(p.id).emit('receiveCards', hand);
        });

        room.turn = firstTurn;
        io.to(roomID).emit('gameStartSync', { 
            turnIndex: firstTurn,
            counts: room.players.map(p => ({name: p.name, count: p.cardCount}))
        });
    });

    socket.on('playCards', (data) => {
        const room = rooms[data.roomID];
        if (!room || room.isOver || room.turn !== data.playerIndex) return;

        const pattern = checkPattern(data.cards);
        let error = null;
        if (!pattern) error = '不合法的牌型！';
        else if (room.lastPlay && room.passCount < room.players.length - 1) {
            if (pattern.type !== room.lastPlay.type && pattern.type < 6) error = `牌型不符，必須出 ${room.lastPlay.label}`;
            else if (pattern.type === room.lastPlay.type && pattern.power <= room.lastPlay.power) error = '牌不夠大！';
        }

        if (error) return socket.emit('errorMsg', error);

        room.players[data.playerIndex].cardCount -= data.cards.length;
        room.lastPlay = pattern;
        room.passCount = 0;
        room.turn = (data.playerIndex + 1) % room.players.length;

        io.to(data.roomID).emit('playSuccess', { 
            cards: data.cards, 
            turnIndex: room.turn, 
            lastPlayer: data.playerName,
            counts: room.players.map(p => ({name: p.name, count: p.cardCount}))
        });

        if (room.players[data.playerIndex].cardCount === 0) {
            room.isOver = true;
            io.to(data.roomID).emit('gameOver', { winner: data.playerName });
        }
    });

    socket.on('pass', (data) => {
        const room = rooms[data.roomID];
        if (!room || room.turn !== data.playerIndex) return;
        room.passCount++;
        room.turn = (data.playerIndex + 1) % room.players.length;
        if (room.passCount >= room.players.length - 1) room.lastPlay = null;

        io.to(data.roomID).emit('playSuccess', { 
            cards: [], 
            turnIndex: room.turn, 
            lastPlayer: data.playerName + " (Pass)",
            counts: room.players.map(p => ({name: p.name, count: p.cardCount}))
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器運行中：port ${PORT}`)});
