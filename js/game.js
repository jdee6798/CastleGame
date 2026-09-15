// Core game engine: rendering, movement/collision, room transitions, HUD,
// minimap and win condition. Consumes the castle produced by
// generateCastleData() (see js/castle-generator.js).
'use strict';

const TILE = 32;
const HUD_HEIGHT = 48;
const PLAYER_SIZE = 20;
const PLAYER_SPEED = 170; // px / second

class Game {
  constructor(canvas, castle) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.castle = castle;

    this.roomPixelW = castle.roomWidth * TILE;
    this.roomPixelH = castle.roomHeight * TILE;
    canvas.width = this.roomPixelW;
    canvas.height = this.roomPixelH + HUD_HEIGHT;

    this.currentRoomId = castle.startRoomId;
    const start = castle.startTile;
    this.player = {
      x: start.col * TILE + (TILE - PLAYER_SIZE) / 2,
      y: start.row * TILE + (TILE - PLAYER_SIZE) / 2,
      facing: 'S',
    };

    this.keysHeld = new Set(); // inventory of key ids, e.g. 'gold'
    this.collectedItems = new Set(); // item ids already picked up
    this.visitedRooms = new Set([this.currentRoomId]);
    this.score = 0;
    this.treasuresFound = 0;
    this.totalTreasures = castle.stats.totalTreasures;

    this.inputDown = new Set();
    this.showMap = false;
    this.message = null; // {text, until}
    this.won = false;
    this.paused = true;

    this._bindInput();
    this._lastTime = null;
    this._loop = this._loop.bind(this);
  }

  // ---------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------
  _bindInput() {
    const moveKeys = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
    ]);
    window.addEventListener('keydown', (e) => {
      if (moveKeys.has(e.key)) { this.inputDown.add(e.key); e.preventDefault(); }
      if (e.key === 'm' || e.key === 'M') { this.showMap = !this.showMap; }
    });
    window.addEventListener('keyup', (e) => {
      if (moveKeys.has(e.key)) this.inputDown.delete(e.key);
    });
  }

  start() {
    this.paused = false;
    requestAnimationFrame(this._loop);
  }

  // ---------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------
  _loop(timestamp) {
    if (this._lastTime === null) this._lastTime = timestamp;
    const dt = Math.min(0.05, (timestamp - this._lastTime) / 1000);
    this._lastTime = timestamp;

    if (!this.paused && !this.won) {
      this._update(dt);
    }
    this._render();
    requestAnimationFrame(this._loop);
  }

  get room() {
    return this.castle.rooms[this.currentRoomId];
  }

  // ---------------------------------------------------------------
  // Update: movement, collision, transitions, pickups
  // ---------------------------------------------------------------
  _update(dt) {
    if (this.showMap) return; // freeze while map is open

    let dx = 0, dy = 0;
    if (this.inputDown.has('ArrowLeft') || this.inputDown.has('a') || this.inputDown.has('A')) dx -= 1;
    if (this.inputDown.has('ArrowRight') || this.inputDown.has('d') || this.inputDown.has('D')) dx += 1;
    if (this.inputDown.has('ArrowUp') || this.inputDown.has('w') || this.inputDown.has('W')) dy -= 1;
    if (this.inputDown.has('ArrowDown') || this.inputDown.has('s') || this.inputDown.has('S')) dy += 1;

    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      dx = (dx / len) * PLAYER_SPEED * dt;
      dy = (dy / len) * PLAYER_SPEED * dt;
      if (dx < 0) this.player.facing = 'W';
      else if (dx > 0) this.player.facing = 'E';
      if (dy < 0) this.player.facing = 'N';
      else if (dy > 0) this.player.facing = 'S';

      this._tryMove(dx, 0);
      this._tryMove(0, dy);
    }

    this._checkItemPickup();

    if (this.message && performance.now() > this.message.until) this.message = null;
  }

  _isSolidTile(row, col) {
    const room = this.room;
    if (row < 0 || col < 0 || row >= this.castle.roomHeight || col >= this.castle.roomWidth) return true;
    return room.tiles[row][col] === 1;
  }

  // Check whether the box [x,y,w,h] overlaps any solid tile.
  _boxHitsWall(x, y) {
    const left = Math.floor(x / TILE);
    const right = Math.floor((x + PLAYER_SIZE - 1) / TILE);
    const top = Math.floor(y / TILE);
    const bottom = Math.floor((y + PLAYER_SIZE - 1) / TILE);
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        if (this._isSolidTile(r, c)) return true;
      }
    }
    return false;
  }

  _tryMove(dx, dy) {
    const nx = this.player.x + dx;
    const ny = this.player.y + dy;

    // Out-of-room-bounds handling (potential door transition).
    if (nx < 0) { if (this._tryTransition('W')) return; }
    if (nx + PLAYER_SIZE > this.roomPixelW) { if (this._tryTransition('E')) return; }
    if (ny < 0) { if (this._tryTransition('N')) return; }
    if (ny + PLAYER_SIZE > this.roomPixelH) { if (this._tryTransition('S')) return; }

    const clampedX = Math.max(0, Math.min(nx, this.roomPixelW - PLAYER_SIZE));
    const clampedY = Math.max(0, Math.min(ny, this.roomPixelH - PLAYER_SIZE));

    if (dx !== 0 && !this._boxHitsWall(clampedX, this.player.y)) this.player.x = clampedX;
    if (dy !== 0 && !this._boxHitsWall(this.player.x, clampedY)) this.player.y = clampedY;
  }

  _tryTransition(dir) {
    const exit = this.room.exits[dir];
    if (!exit) return false;
    if (exit.type === 'locked' && !this.keysHeld.has(exit.keyId)) {
      this._showLockedMessage(exit.keyId);
      return true; // blocked, but "handled" so caller doesn't fall through to wall clamp oddly
    }
    // Perform the transition.
    const nextRoom = this.castle.rooms[exit.to];
    this.currentRoomId = exit.to;
    this.visitedRooms.add(exit.to);

    const OPP = { N: 'S', S: 'N', E: 'W', W: 'E' };
    const entrySide = OPP[dir];
    const midCol = Math.floor(this.castle.roomWidth / 2);
    const midRow = Math.floor(this.castle.roomHeight / 2);
    if (entrySide === 'N') { this.player.y = 1; this.player.x = midCol * TILE + (TILE - PLAYER_SIZE) / 2; }
    if (entrySide === 'S') { this.player.y = this.roomPixelH - PLAYER_SIZE - 1; this.player.x = midCol * TILE + (TILE - PLAYER_SIZE) / 2; }
    if (entrySide === 'W') { this.player.x = 1; this.player.y = midRow * TILE + (TILE - PLAYER_SIZE) / 2; }
    if (entrySide === 'E') { this.player.x = this.roomPixelW - PLAYER_SIZE - 1; this.player.y = midRow * TILE + (TILE - PLAYER_SIZE) / 2; }

    void nextRoom;
    return true;
  }

  _showLockedMessage(keyId) {
    const kt = this.castle.keyTypes.find((k) => k.id === keyId);
    this.message = { text: `Locked \u2014 requires the ${kt ? kt.label : 'right key'}`, until: performance.now() + 1800 };
  }

  _checkItemPickup() {
    const room = this.room;
    const pRow = Math.floor((this.player.y + PLAYER_SIZE / 2) / TILE);
    const pCol = Math.floor((this.player.x + PLAYER_SIZE / 2) / TILE);
    for (const item of room.items) {
      if (this.collectedItems.has(item.id)) continue;
      if (item.row === pRow && item.col === pCol) {
        this.collectedItems.add(item.id);
        if (item.type === 'key') {
          this.keysHeld.add(item.keyId);
          this.message = { text: `Found the ${item.name}!`, until: performance.now() + 1800 };
        } else {
          this.score += item.value;
          this.treasuresFound += 1;
          this.message = { text: `Found ${item.name} (+${item.value})`, until: performance.now() + 1800 };
          if (item.grand) this._onWin();
        }
      }
    }
  }

  _onWin() {
    this.won = true;
    document.dispatchEvent(new CustomEvent('castle-win', {
      detail: {
        score: this.score,
        treasuresFound: this.treasuresFound,
        totalTreasures: this.totalTreasures,
        roomsVisited: this.visitedRooms.size,
        totalRooms: this.castle.stats.totalRooms,
      },
    }));
  }

  // ---------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------
  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this._renderHUD();
    ctx.save();
    ctx.translate(0, HUD_HEIGHT);
    this._renderRoom();
    this._renderItems();
    this._renderPlayer();
    ctx.restore();

    if (this.message) this._renderMessage();
    if (this.showMap) this._renderMinimap();
  }

  _renderHUD() {
    const ctx = this.ctx;
    ctx.fillStyle = '#1c1622';
    ctx.fillRect(0, 0, this.canvas.width, HUD_HEIGHT);
    ctx.fillStyle = '#f2c40c';
    ctx.font = 'bold 14px Georgia, serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.room.name, 10, HUD_HEIGHT / 2 - 8);

    ctx.fillStyle = '#eee6d8';
    ctx.font = '11px Georgia, serif';
    ctx.fillText(`Treasures ${this.treasuresFound}/${this.totalTreasures}   Score ${this.score}`, 10, HUD_HEIGHT / 2 + 10);

    // Key icons, right-aligned.
    let kx = this.canvas.width - 10;
    for (const kt of [...this.castle.keyTypes].reverse()) {
      if (!this.keysHeld.has(kt.id)) continue;
      kx -= 18;
      ctx.fillStyle = kt.color;
      ctx.beginPath();
      ctx.arc(kx, HUD_HEIGHT / 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1c1622';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  _renderRoom() {
    const ctx = this.ctx;
    const room = this.room;
    for (let r = 0; r < this.castle.roomHeight; r++) {
      for (let c = 0; c < this.castle.roomWidth; c++) {
        const solid = room.tiles[r][c] === 1;
        ctx.fillStyle = solid ? '#3a3444' : '#5b5468';
        ctx.fillRect(c * TILE, r * TILE, TILE, TILE);
        if (!solid) {
          ctx.strokeStyle = 'rgba(0,0,0,0.12)';
          ctx.strokeRect(c * TILE + 0.5, r * TILE + 0.5, TILE - 1, TILE - 1);
        }
      }
    }

    // Draw locked-door overlays across the gap on each border side.
    for (const dir of Object.keys(room.exits)) {
      const exit = room.exits[dir];
      if (exit.type !== 'locked' || this.keysHeld.has(exit.keyId)) continue;
      const kt = this.castle.keyTypes.find((k) => k.id === exit.keyId);
      ctx.fillStyle = kt ? kt.color : '#a33';
      ctx.globalAlpha = 0.85;
      const midCol = Math.floor(this.castle.roomWidth / 2);
      const midRow = Math.floor(this.castle.roomHeight / 2);
      if (dir === 'N') ctx.fillRect((midCol - 1) * TILE, 0, TILE * 3, 6);
      if (dir === 'S') ctx.fillRect((midCol - 1) * TILE, this.roomPixelH - 6, TILE * 3, 6);
      if (dir === 'W') ctx.fillRect(0, (midRow - 1) * TILE, 6, TILE * 3);
      if (dir === 'E') ctx.fillRect(this.roomPixelW - 6, (midRow - 1) * TILE, 6, TILE * 3);
      ctx.globalAlpha = 1;
    }
  }

  _renderItems() {
    const ctx = this.ctx;
    for (const item of this.room.items) {
      if (this.collectedItems.has(item.id)) continue;
      const cx = item.col * TILE + TILE / 2;
      const cy = item.row * TILE + TILE / 2;
      if (item.type === 'key') {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(cx - 4, cy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx - 2, cy - 2, 10, 4);
        ctx.fillRect(cx + 4, cy - 5, 3, 3);
        ctx.fillRect(cx + 4, cy + 2, 3, 3);
      } else {
        ctx.fillStyle = item.grand ? '#ffd700' : '#e8c766';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 9);
        ctx.lineTo(cx + 9, cy);
        ctx.lineTo(cx, cy + 9);
        ctx.lineTo(cx - 9, cy);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#7a5c00';
        ctx.stroke();
      }
    }
  }

  _renderPlayer() {
    const ctx = this.ctx;
    const p = this.player;
    ctx.fillStyle = '#4fb0ff';
    ctx.fillRect(p.x, p.y, PLAYER_SIZE, PLAYER_SIZE);
    ctx.fillStyle = '#0d3a5c';
    const cx = p.x + PLAYER_SIZE / 2;
    const cy = p.y + PLAYER_SIZE / 2;
    const r = 4;
    ctx.beginPath();
    if (p.facing === 'N') ctx.arc(cx, p.y + 2, r, 0, Math.PI * 2);
    if (p.facing === 'S') ctx.arc(cx, p.y + PLAYER_SIZE - 2, r, 0, Math.PI * 2);
    if (p.facing === 'W') ctx.arc(p.x + 2, cy, r, 0, Math.PI * 2);
    if (p.facing === 'E') ctx.arc(p.x + PLAYER_SIZE - 2, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _renderMessage() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    const textWidth = ctx.measureText(this.message.text).width;
    const boxW = Math.min(w - 20, textWidth + 24);
    ctx.fillRect((w - boxW) / 2, this.canvas.height - 46, boxW, 26);
    ctx.fillStyle = '#fff';
    ctx.font = '13px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.message.text, w / 2, this.canvas.height - 33);
    ctx.textAlign = 'left';
  }

  _renderMinimap() {
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.fillStyle = 'rgba(5,3,8,0.92)';
    ctx.fillRect(0, 0, w, h);

    const rooms = Object.values(this.castle.rooms);
    const minX = Math.min(...rooms.map((r) => r.gridX));
    const maxX = Math.max(...rooms.map((r) => r.gridX));
    const minY = Math.min(...rooms.map((r) => r.gridY));
    const maxY = Math.max(...rooms.map((r) => r.gridY));
    const cols = maxX - minX + 1;
    const rowsN = maxY - minY + 1;
    const pad = 20;
    const cell = Math.min((w - pad * 2) / cols, (h - pad * 2) / rowsN);
    const originX = (w - cell * cols) / 2;
    const originY = (h - cell * rowsN) / 2;

    for (const room of rooms) {
      if (!this.visitedRooms.has(room.id)) continue;
      const px = originX + (room.gridX - minX) * cell;
      const py = originY + (room.gridY - minY) * cell;
      ctx.fillStyle = room.id === this.currentRoomId ? '#f2c40c' : '#5b5468';
      ctx.fillRect(px + 2, py + 2, cell - 4, cell - 4);

      for (const dir of Object.keys(room.exits)) {
        const exit = room.exits[dir];
        if (!this.visitedRooms.has(exit.to)) continue;
        const locked = exit.type === 'locked' && !this.keysHeld.has(exit.keyId);
        ctx.strokeStyle = locked ? '#e0115f' : '#c9c2d6';
        ctx.lineWidth = locked ? 3 : 2;
        ctx.setLineDash(locked ? [3, 3] : []);
        ctx.beginPath();
        const cx = px + cell / 2, cy = py + cell / 2;
        if (dir === 'N') { ctx.moveTo(cx, py); ctx.lineTo(cx, py - cell / 2); }
        if (dir === 'S') { ctx.moveTo(cx, py + cell); ctx.lineTo(cx, py + cell + cell / 2); }
        if (dir === 'W') { ctx.moveTo(px, cy); ctx.lineTo(px - cell / 2, cy); }
        if (dir === 'E') { ctx.moveTo(px + cell, cy); ctx.lineTo(px + cell + cell / 2, cy); }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    ctx.fillStyle = '#eee6d8';
    ctx.font = 'bold 15px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.fillText('Castle Map', w / 2, 22);
    ctx.font = '11px Georgia, serif';
    ctx.fillText('Press M to close', w / 2, h - 12);
    ctx.textAlign = 'left';
  }
}
