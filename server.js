'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

const MAP_W = 1000;
const MAP_H = 650;
const PLAYER_RADIUS = 15;
const PLAYER_SPEED = 180;
const BULLET_SPEED = 520;
const BULLET_RADIUS = 5;
const BULLET_DAMAGE = 25;
const BULLET_LIFETIME = 1800;
const RESPAWN_MS = 3000;
const SHOOT_COOLDOWN_MS = 280;
const MAX_PLAYERS = 4;
const TICK_MS = 1000 / 60;

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f'];
const COLOR_NAMES = ['Red', 'Blue', 'Green', 'Yellow'];

const WALLS = [
  { x: 440, y: 275, w: 120, h: 100 },  // center block
  { x: 130, y: 130, w: 80,  h: 25  },  // TL cover
  { x: 790, y: 130, w: 80,  h: 25  },  // TR cover
  { x: 130, y: 495, w: 80,  h: 25  },  // BL cover
  { x: 790, y: 495, w: 80,  h: 25  },  // BR cover
];

const SPAWNS = [
  { x: 80,         y: 80          },
  { x: MAP_W - 80, y: MAP_H - 80  },
  { x: MAP_W - 80, y: 80          },
  { x: 80,         y: MAP_H - 80  },
];

const players = {};
const bullets = [];
let bulletId = 0;
let nextColorIdx = 0;
let nextSpawnIdx = 0;

// Circle vs AABB: push player out if overlapping a wall
function resolveWalls(p) {
  for (const w of WALLS) {
    const cx = Math.max(w.x, Math.min(p.x, w.x + w.w));
    const cy = Math.max(w.y, Math.min(p.y, w.y + w.h));
    const dx = p.x - cx;
    const dy = p.y - cy;
    const distSq = dx * dx + dy * dy;
    if (distSq < PLAYER_RADIUS * PLAYER_RADIUS) {
      const dist = Math.sqrt(distSq) || 0.001;
      p.x = cx + (dx / dist) * PLAYER_RADIUS;
      p.y = cy + (dy / dist) * PLAYER_RADIUS;
    }
  }
}

function inWall(x, y) {
  for (const w of WALLS) {
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return true;
  }
  return false;
}

function respawn(p) {
  const s = SPAWNS[Math.floor(Math.random() * SPAWNS.length)];
  p.x = s.x;
  p.y = s.y;
  p.health = 100;
  p.alive = true;
  p.respawnTimer = 0;
}

io.on('connection', (socket) => {
  if (Object.keys(players).length >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect(true);
    return;
  }

  const colorIdx = nextColorIdx % COLORS.length;
  const spawn = SPAWNS[nextSpawnIdx % SPAWNS.length];
  nextColorIdx++;
  nextSpawnIdx++;

  players[socket.id] = {
    id: socket.id,
    x: spawn.x,
    y: spawn.y,
    angle: 0,
    health: 100,
    maxHealth: 100,
    color: COLORS[colorIdx],
    name: COLOR_NAMES[colorIdx],
    alive: true,
    respawnTimer: 0,
    score: 0,
    lastShot: 0,
    input: { up: false, down: false, left: false, right: false, angle: 0 },
  };

  socket.emit('init', { playerId: socket.id, mapW: MAP_W, mapH: MAP_H, walls: WALLS });

  socket.on('input', (input) => {
    const p = players[socket.id];
    if (p) p.input = input;
  });

  socket.on('shoot', (angle) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    const now = Date.now();
    if (now - p.lastShot < SHOOT_COOLDOWN_MS) return;
    p.lastShot = now;
    bullets.push({
      id: bulletId++,
      x: p.x + Math.cos(angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2),
      y: p.y + Math.sin(angle) * (PLAYER_RADIUS + BULLET_RADIUS + 2),
      vx: Math.cos(angle) * BULLET_SPEED,
      vy: Math.sin(angle) * BULLET_SPEED,
      ownerId: socket.id,
      life: BULLET_LIFETIME,
    });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
  });
});

let lastTick = Date.now();

setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.05);
  lastTick = now;

  for (const p of Object.values(players)) {
    if (!p.alive) {
      p.respawnTimer -= dt * 1000;
      if (p.respawnTimer <= 0) respawn(p);
      continue;
    }

    let dx = 0, dy = 0;
    if (p.input.up)    dy -= 1;
    if (p.input.down)  dy += 1;
    if (p.input.left)  dx -= 1;
    if (p.input.right) dx += 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

    p.x = Math.max(PLAYER_RADIUS, Math.min(MAP_W - PLAYER_RADIUS, p.x + dx * PLAYER_SPEED * dt));
    p.y = Math.max(PLAYER_RADIUS, Math.min(MAP_H - PLAYER_RADIUS, p.y + dy * PLAYER_SPEED * dt));
    p.angle = p.input.angle;

    resolveWalls(p);
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt * 1000;

    if (b.life <= 0 || b.x < 0 || b.x > MAP_W || b.y < 0 || b.y > MAP_H || inWall(b.x, b.y)) {
      bullets.splice(i, 1);
      continue;
    }

    let hit = false;
    for (const p of Object.values(players)) {
      if (!p.alive || p.id === b.ownerId) continue;
      if (Math.hypot(b.x - p.x, b.y - p.y) < PLAYER_RADIUS + BULLET_RADIUS) {
        p.health -= BULLET_DAMAGE;
        if (p.health <= 0) {
          p.health = 0;
          p.alive = false;
          p.respawnTimer = RESPAWN_MS;
          const killer = players[b.ownerId];
          if (killer) killer.score++;
        }
        bullets.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;
  }

  const state = {
    players: {},
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y })),
  };
  for (const [id, p] of Object.entries(players)) {
    state.players[id] = {
      id: p.id, x: p.x, y: p.y, angle: p.angle,
      health: p.health, maxHealth: p.maxHealth,
      color: p.color, name: p.name,
      alive: p.alive, respawnTimer: p.respawnTimer, score: p.score,
    };
  }
  io.emit('gameState', state);

}, TICK_MS);

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Arena Shooter running at http://localhost:${PORT}`);
});
