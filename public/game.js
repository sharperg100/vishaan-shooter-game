'use strict';

const socket = io();

let playerId = null;
let mapW = 1000;
let mapH = 650;
let gameWalls = [];
let latestState = { players: {}, bullets: [] };
let lastShot = 0;
const SHOOT_COOLDOWN = 280;

socket.on('serverFull', () => {
  document.body.innerHTML =
    '<p style="color:#e74c3c;font:bold 24px Arial;text-align:center;margin-top:40vh">Game is full (max 4 players). Try again later.</p>';
});

socket.on('init', ({ playerId: id, mapW: w, mapH: h, walls }) => {
  playerId = id;
  mapW = w;
  mapH = h;
  gameWalls = walls;
  startGame();
});

socket.on('gameState', (state) => {
  latestState = state;
});

// --- Phaser setup ---

let gfx, wallGfx, scoreText, statusText;
let wasd, arrows;

function startGame() {
  new Phaser.Game({
    type: Phaser.AUTO,
    width: mapW,
    height: mapH,
    backgroundColor: '#16213e',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
    scene: { create, update },
  });
}

function create() {
  // Floor grid
  wallGfx = this.add.graphics();
  wallGfx.lineStyle(1, 0x1e2a3a, 1);
  for (let x = 0; x <= mapW; x += 50) wallGfx.lineBetween(x, 0, x, mapH);
  for (let y = 0; y <= mapH; y += 50) wallGfx.lineBetween(0, y, mapW, y);

  // Walls
  wallGfx.fillStyle(0x3a3a5c, 1);
  for (const w of gameWalls) wallGfx.fillRect(w.x, w.y, w.w, w.h);
  wallGfx.lineStyle(2, 0x6a6a9c, 1);
  for (const w of gameWalls) wallGfx.strokeRect(w.x, w.y, w.w, w.h);

  // Map border
  wallGfx.lineStyle(3, 0x4a4a7c, 1);
  wallGfx.strokeRect(0, 0, mapW, mapH);

  // Dynamic game objects drawn each frame
  gfx = this.add.graphics();

  // Scoreboard top-left
  scoreText = this.add.text(10, 10, '', {
    fontSize: '13px',
    fontFamily: 'monospace',
    color: '#ffffff',
    backgroundColor: '#00000088',
    padding: { x: 8, y: 6 },
  }).setDepth(10);

  // Centre status (death / waiting)
  statusText = this.add.text(mapW / 2, mapH / 2, '', {
    fontSize: '30px',
    fontFamily: 'Arial',
    color: '#ffffff',
    align: 'center',
    backgroundColor: '#000000bb',
    padding: { x: 20, y: 12 },
  }).setOrigin(0.5).setDepth(10).setVisible(false);

  // Keyboard
  wasd = this.input.keyboard.addKeys({
    up:    Phaser.Input.Keyboard.KeyCodes.W,
    down:  Phaser.Input.Keyboard.KeyCodes.S,
    left:  Phaser.Input.Keyboard.KeyCodes.A,
    right: Phaser.Input.Keyboard.KeyCodes.D,
  });
  arrows = this.input.keyboard.createCursorKeys();

  // Shoot on click / hold
  this.input.on('pointerdown', (ptr) => tryShoot(ptr));
  this.input.on('pointermove', (ptr) => { if (ptr.isDown) tryShoot(ptr); });
}

function tryShoot(ptr) {
  const now = Date.now();
  if (now - lastShot < SHOOT_COOLDOWN) return;
  const me = latestState.players[playerId];
  if (!me || !me.alive) return;
  lastShot = now;
  const angle = Math.atan2(ptr.y - me.y, ptr.x - me.x);
  socket.emit('shoot', angle);
}

function update() {
  if (!playerId) return;

  const me = latestState.players[playerId];
  const ptr = this.input.activePointer;
  const aimAngle = me ? Math.atan2(ptr.y - me.y, ptr.x - me.x) : 0;

  // Send input every frame
  socket.emit('input', {
    up:    wasd.up.isDown    || arrows.up.isDown,
    down:  wasd.down.isDown  || arrows.down.isDown,
    left:  wasd.left.isDown  || arrows.left.isDown,
    right: wasd.right.isDown || arrows.right.isDown,
    angle: aimAngle,
  });

  gfx.clear();

  const playerList = Object.values(latestState.players);

  // Bullets
  gfx.fillStyle(0xffee66, 1);
  for (const b of latestState.bullets) {
    gfx.fillCircle(b.x, b.y, 5);
  }

  // Players
  for (const p of playerList) {
    if (!p.alive) continue;

    const col = parseInt(p.color.replace('#', ''), 16);
    const isMe = p.id === playerId;

    // Gun barrel (drawn behind body)
    const gunTipX = p.x + Math.cos(p.angle) * 24;
    const gunTipY = p.y + Math.sin(p.angle) * 24;
    gfx.lineStyle(4, 0x888899, 1);
    gfx.beginPath();
    gfx.moveTo(p.x, p.y);
    gfx.lineTo(gunTipX, gunTipY);
    gfx.strokePath();

    // Body
    gfx.fillStyle(col, 1);
    gfx.fillCircle(p.x, p.y, 15);

    // White ring for local player, dark ring for others
    gfx.lineStyle(2, isMe ? 0xffffff : 0x000000, isMe ? 1 : 0.5);
    gfx.strokeCircle(p.x, p.y, 15);

    // Health bar background
    const bw = 34, bh = 5;
    const bx = p.x - bw / 2, by = p.y - 27;
    gfx.fillStyle(0x222222, 0.85);
    gfx.fillRect(bx, by, bw, bh);

    // Health bar fill
    const frac = p.health / p.maxHealth;
    const hcol = frac > 0.5 ? 0x27ae60 : frac > 0.25 ? 0xf39c12 : 0xe74c3c;
    gfx.fillStyle(hcol, 1);
    gfx.fillRect(bx, by, bw * frac, bh);
  }

  // Scoreboard
  const sorted = playerList.slice().sort((a, b) => b.score - a.score);
  let board = 'SCORES\n';
  for (const p of sorted) {
    const arrow = p.id === playerId ? '>' : ' ';
    board += `${arrow} ${p.name.padEnd(7)} ${String(p.score).padStart(2)}\n`;
  }
  if (playerList.length === 1) board += '\nWaiting for players\nto join...';
  scoreText.setText(board);

  // Death / respawn overlay
  if (me && !me.alive) {
    const secs = Math.ceil(me.respawnTimer / 1000);
    statusText.setText(`YOU DIED\nRespawning in ${secs}s`).setVisible(true);
  } else {
    statusText.setVisible(false);
  }
}
