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
    this.unlockedEdges = new Set(); // door edges the player has actually unlocked in person
    this.visitedRooms = new Set([this.currentRoomId]);
    this.decorCache = new Map(); // per-room decor placement + solidity, computed once
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
    if (room.tiles[row][col] === 1) return true;
    const decor = this._getRoomDecor(room);
    return decor.solidSpots.some((s) => s.r === row && s.c === col);
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

  // A physical door is shared by two rooms (each keeps its own exit entry
  // for it), so its "unlocked" state is tracked per undirected edge rather
  // than per room, keeping both sides in sync.
  _edgeId(a, b) {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  _tryTransition(dir) {
    const exit = this.room.exits[dir];
    if (!exit) return false;
    if (exit.type === 'locked') {
      const edgeId = this._edgeId(this.currentRoomId, exit.to);
      if (!this.unlockedEdges.has(edgeId)) {
        if (!this.keysHeld.has(exit.keyId)) {
          this._showLockedMessage(exit.keyId);
          return true;
        }
        // Player has the key and has just walked up to this specific door:
        // unlock it now rather than the moment the key was picked up.
        this.unlockedEdges.add(edgeId);
        this._showUnlockedMessage(exit.keyId);
        return true; // door swings open this step; step through on the next
      }
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

  _showUnlockedMessage(keyId) {
    const kt = this.castle.keyTypes.find((k) => k.id === keyId);
    this.message = { text: `Unlocked with the ${kt ? kt.label : 'key'} \u2014 the door swings open!`, until: performance.now() + 2000 };
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
        if (solid) this._drawBrickTile(ctx, c * TILE, r * TILE);
        else this._drawFloorTile(ctx, c * TILE, r * TILE, r, c);
      }
    }

    this._renderRoomTheme();
    this._renderTorches();

    // Draw a door across the gap on each border side: an open frame for
    // passable exits, or a locked, padlocked door until the player has
    // personally unlocked it with the matching key.
    for (const dir of Object.keys(room.exits)) {
      const exit = room.exits[dir];
      const edgeId = this._edgeId(this.currentRoomId, exit.to);
      const isLocked = exit.type === 'locked' && !this.unlockedEdges.has(edgeId);
      if (isLocked) {
        const kt = this.castle.keyTypes.find((k) => k.id === exit.keyId);
        this._drawLockedDoor(dir, kt ? kt.color : '#a33');
      } else {
        this._drawOpenDoorway(dir);
      }
    }
  }

  // Continuous running-bond brick pattern, aligned to the world so it
  // reads as one wall rather than per-tile blocks.
  _drawBrickTile(ctx, x, y) {
    const BRICK_H = 8;
    const BRICK_W = 16;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, TILE, TILE);
    ctx.clip();
    ctx.fillStyle = '#241f2b';
    ctx.fillRect(x, y, TILE, TILE);
    const rowStart = Math.floor(y / BRICK_H);
    const rowEnd = Math.ceil((y + TILE) / BRICK_H);
    for (let ry = rowStart; ry < rowEnd; ry++) {
      const rowY = ry * BRICK_H;
      const offset = ry % 2 === 0 ? 0 : BRICK_W / 2;
      const colStart = Math.floor((x - offset) / BRICK_W) - 1;
      const colEnd = Math.ceil((x + TILE - offset) / BRICK_W) + 1;
      for (let cxi = colStart; cxi < colEnd; cxi++) {
        const bx = cxi * BRICK_W + offset;
        const shade = ((ry * 31 + cxi * 17) % 3 + 3) % 3;
        ctx.fillStyle = shade === 0 ? '#564a68' : shade === 1 ? '#4c4160' : '#453a58';
        ctx.fillRect(bx + 1, rowY + 1, BRICK_W - 2, BRICK_H - 2);
      }
    }
    ctx.restore();
  }

  // Deterministic flagstone floor: a few tone variants plus the occasional
  // hairline crack, keyed off the tile coordinates so it never flickers.
  _drawFloorTile(ctx, x, y, r, c) {
    const shades = ['#5b5468', '#5e5770', '#585165', '#5c556a', '#5a5369'];
    const hash = (r * 131 + c * 977) % shades.length;
    ctx.fillStyle = shades[hash];
    ctx.fillRect(x, y, TILE, TILE);
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    if ((r * 7 + c * 3) % 11 === 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      ctx.moveTo(x + 6, y + 6);
      ctx.lineTo(x + TILE - 8, y + TILE - 10);
      ctx.stroke();
    }
  }

  _drawOpenDoorway(dir) {
    const ctx = this.ctx;
    const midCol = Math.floor(this.castle.roomWidth / 2);
    const midRow = Math.floor(this.castle.roomHeight / 2);
    ctx.fillStyle = '#241f2b';
    if (dir === 'N') ctx.fillRect((midCol - 1) * TILE, 0, TILE * 3, 3);
    if (dir === 'S') ctx.fillRect((midCol - 1) * TILE, this.roomPixelH - 3, TILE * 3, 3);
    if (dir === 'W') ctx.fillRect(0, (midRow - 1) * TILE, 3, TILE * 3);
    if (dir === 'E') ctx.fillRect(this.roomPixelW - 3, (midRow - 1) * TILE, 3, TILE * 3);
  }

  // A wooden door with a padlock tinted to match the key that opens it.
  _drawLockedDoor(dir, color) {
    const ctx = this.ctx;
    const midCol = Math.floor(this.castle.roomWidth / 2);
    const midRow = Math.floor(this.castle.roomHeight / 2);
    let rx, ry, rw, rh;
    if (dir === 'N') { rx = (midCol - 1) * TILE; ry = 0; rw = TILE * 3; rh = TILE * 0.4; }
    if (dir === 'S') { rx = (midCol - 1) * TILE; ry = this.roomPixelH - TILE * 0.4; rw = TILE * 3; rh = TILE * 0.4; }
    if (dir === 'W') { rx = 0; ry = (midRow - 1) * TILE; rw = TILE * 0.4; rh = TILE * 3; }
    if (dir === 'E') { rx = this.roomPixelW - TILE * 0.4; ry = (midRow - 1) * TILE; rw = TILE * 0.4; rh = TILE * 3; }

    ctx.fillStyle = '#3d2a1a';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = '#1e140c';
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, rw - 2, rh - 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    if (dir === 'N' || dir === 'S') {
      ctx.beginPath(); ctx.moveTo(rx + rw / 3, ry); ctx.lineTo(rx + rw / 3, ry + rh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx + (rw * 2) / 3, ry); ctx.lineTo(rx + (rw * 2) / 3, ry + rh); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(rx, ry + rh / 3); ctx.lineTo(rx + rw, ry + rh / 3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(rx, ry + (rh * 2) / 3); ctx.lineTo(rx + rw, ry + (rh * 2) / 3); ctx.stroke();
    }

    const cx = rx + rw / 2;
    const cy = ry + rh / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy + 3, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy - 3, 4.5, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#1e140c';
    ctx.fillRect(cx - 1.5, cy + 1, 3, 4);
  }

  // Two flickering wall sconces near the top corners of every room, for a
  // bit of ambient life regardless of theme.
  _renderTorches() {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    const flicker = (seed) => 0.75 + 0.25 * Math.sin(t * 6 + seed);
    this._drawTorch(ctx, TILE * 1.1, TILE * 0.9, flicker(0));
    this._drawTorch(ctx, this.roomPixelW - TILE * 1.1, TILE * 0.9, flicker(2));
  }

  _drawTorch(ctx, x, y, flame) {
    ctx.fillStyle = '#3a2a18';
    ctx.fillRect(x - 2, y - 4, 4, 14);
    ctx.save();
    ctx.globalAlpha = flame;
    ctx.fillStyle = '#f2a63c';
    ctx.beginPath();
    ctx.moveTo(x, y - 18);
    ctx.quadraticCurveTo(x + 6, y - 8, x, y - 4);
    ctx.quadraticCurveTo(x - 6, y - 8, x, y - 18);
    ctx.fill();
    ctx.fillStyle = '#fddc7a';
    ctx.beginPath();
    ctx.arc(x, y - 10, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Maps a room's flavour name to a decor theme so it visually matches
  // what it's called (a bedroom looks slept-in, a cellar looks cobwebbed).
  _roomTheme(name) {
    if (/bed|nursery/i.test(name)) return 'bed';
    if (/cellar|crypt|ossuary|dungeon|oubliette|torture/i.test(name)) return 'cobweb';
    if (/kitchen|pantry|scullery/i.test(name)) return 'kitchen';
    if (/library|study|scriptorium|map room|alchemy/i.test(name)) return 'library';
    if (/armoury|guard room/i.test(name)) return 'armoury';
    if (/chapel|sacristy/i.test(name)) return 'chapel';
    if (/hall|throne|antechamber|council/i.test(name)) return 'banner';
    if (/treasury|vault/i.test(name)) return 'chest';
    if (/courtyard|well|stable|falconry/i.test(name)) return 'hay';
    return null;
  }

  // Finds a free, non-door floor tile near the given preferred spot so
  // decor never overlaps a pillar, a doorway, or an item that's sitting
  // on the floor (otherwise solid furniture could seal off a key/treasure).
  _decorSpot(room, rowPref, colPref, avoid) {
    const candidates = [
      [rowPref, colPref], [rowPref + 1, colPref], [rowPref, colPref + 1],
      [rowPref + 1, colPref + 1], [rowPref - 1, colPref], [rowPref, colPref - 1],
    ];
    for (const [r, c] of candidates) {
      if (r <= 0 || c <= 0 || r >= this.castle.roomHeight - 1 || c >= this.castle.roomWidth - 1) continue;
      if (room.tiles[r][c] === 0 && !avoid.has(`${r},${c}`)) return { r, c };
    }
    return null;
  }

  _doorTileFor(dir) {
    const midCol = Math.floor(this.castle.roomWidth / 2);
    const midRow = Math.floor(this.castle.roomHeight / 2);
    if (dir === 'N') return { r: 0, c: midCol };
    if (dir === 'S') return { r: this.castle.roomHeight - 1, c: midCol };
    if (dir === 'W') return { r: midRow, c: 0 };
    if (dir === 'E') return { r: midRow, c: this.castle.roomWidth - 1 };
    return null;
  }

  // Confirms that treating `spot` as solid still leaves every door in the
  // room mutually reachable, so furniture never seals off part of a room.
  _tileSafeToBlock(room, spot) {
    const doorTiles = Object.keys(room.exits).map((d) => this._doorTileFor(d)).filter(Boolean);
    if (!doorTiles.length) return true;
    const start = doorTiles[0];
    const seen = new Set([`${start.r},${start.c}`]);
    const q = [start];
    while (q.length) {
      const cur = q.shift();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = cur.r + dr, nc = cur.c + dc;
        if (nr < 0 || nc < 0 || nr >= this.castle.roomHeight || nc >= this.castle.roomWidth) continue;
        if (nr === spot.r && nc === spot.c) continue;
        if (room.tiles[nr][nc] !== 0) continue;
        const k = `${nr},${nc}`;
        if (!seen.has(k)) { seen.add(k); q.push({ r: nr, c: nc }); }
      }
    }
    return doorTiles.every((d) => seen.has(`${d.r},${d.c}`));
  }

  // Decor placement is computed once per room and cached, so the exact
  // same tile is used for both rendering and collision every frame.
  _getRoomDecor(room) {
    if (this.decorCache.has(room.id)) return this.decorCache.get(room.id);
    const theme = this._roomTheme(room.name);
    const result = { theme, spot: null, solidSpots: [] };
    if (theme && theme !== 'cobweb') {
      const avoid = new Set(room.items.map((it) => `${it.row},${it.col}`));
      const spot = this._decorSpot(room, 2, 2, avoid) || this._decorSpot(room, this.castle.roomHeight - 3, this.castle.roomWidth - 3, avoid);
      if (spot) {
        result.spot = spot;
        if (this._tileSafeToBlock(room, spot)) result.solidSpots.push(spot);
      }
    }
    this.decorCache.set(room.id, result);
    return result;
  }

  _renderRoomTheme() {
    const ctx = this.ctx;
    const room = this.room;
    const decor = this._getRoomDecor(room);
    if (!decor.theme) return;

    if (decor.theme === 'cobweb') {
      this._drawCobweb(ctx, 0, 0, 1, 1);
      this._drawCobweb(ctx, this.roomPixelW, 0, -1, 1);
      return;
    }

    if (!decor.spot) return;
    this._drawFurnitureBase(ctx, decor.spot);
    if (decor.theme === 'bed') this._drawBed(ctx, decor.spot);
    if (decor.theme === 'kitchen') this._drawCauldron(ctx, decor.spot);
    if (decor.theme === 'library') this._drawBookshelf(ctx, decor.spot);
    if (decor.theme === 'armoury') this._drawWeaponRack(ctx, decor.spot);
    if (decor.theme === 'chapel') this._drawCandle(ctx, decor.spot);
    if (decor.theme === 'banner') this._drawBanner(ctx, decor.spot);
    if (decor.theme === 'chest') this._drawChest(ctx, decor.spot);
    if (decor.theme === 'hay') this._drawHay(ctx, decor.spot);
  }

  // A grounded shadow + floor plinth under every furniture piece, so it
  // reads immediately as a solid, immovable obstacle rather than a
  // collectible sitting loose on the floor.
  _drawFurnitureBase(ctx, spot) {
    const x = spot.c * TILE, y = spot.r * TILE;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x + TILE / 2, y + TILE - 4, TILE / 2 - 2, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 1.5, y + 1.5, TILE - 3, TILE - 3);
  }

  _drawCobweb(ctx, x, y, scaleX, scaleY) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scaleX, scaleY);
    ctx.strokeStyle = 'rgba(225,225,235,0.55)';
    ctx.lineWidth = 1;
    const length = 30;
    const radials = 4;
    for (let i = 0; i <= radials; i++) {
      const angle = (Math.PI / 2) * (i / radials);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * length, Math.sin(angle) * length);
      ctx.stroke();
    }
    for (let r = 10; r <= length; r += 10) {
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI / 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawBed(ctx, spot) {
    const x = spot.c * TILE, y = spot.r * TILE;
    ctx.fillStyle = '#6b4423';
    ctx.fillRect(x + 3, y + 3, TILE - 6, TILE - 6);
    ctx.fillStyle = '#8a2b3d';
    ctx.fillRect(x + 4, y + 12, TILE - 8, TILE - 16);
    ctx.fillStyle = '#eee6d8';
    ctx.fillRect(x + 5, y + 4, TILE - 10, 7);
  }

  _drawCauldron(ctx, spot) {
    const cx = spot.c * TILE + TILE / 2, cy = spot.r * TILE + TILE / 2;
    ctx.fillStyle = '#22222a';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 4, 11, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 11, cy);
    ctx.quadraticCurveTo(cx, cy - 14, cx + 11, cy);
    ctx.stroke();
  }

  _drawBookshelf(ctx, spot) {
    const x = spot.c * TILE, y = spot.r * TILE;
    ctx.fillStyle = '#3e2b1f';
    ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
    const colors = ['#7a2e2e', '#2e4a7a', '#2e7a4a', '#7a6a2e', '#5a2e7a'];
    const bw = (TILE - 8) / 6;
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(x + 4 + i * bw, y + 5, bw - 1, TILE - 10);
    }
  }

  _drawWeaponRack(ctx, spot) {
    const cx = spot.c * TILE + TILE / 2, cy = spot.r * TILE + TILE / 2;
    ctx.strokeStyle = '#c9c2d6';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 10, cy - 10); ctx.lineTo(cx - 10, cy + 10); ctx.stroke();
    ctx.fillStyle = '#8a6d3a';
    ctx.fillRect(cx - 3, cy - 3, 6, 6);
  }

  _drawCandle(ctx, spot) {
    const x = spot.c * TILE + TILE / 2, y = spot.r * TILE + TILE / 2;
    ctx.fillStyle = '#eee6d8';
    ctx.fillRect(x - 3, y - 2, 6, 14);
    ctx.fillStyle = '#f2a63c';
    ctx.beginPath();
    ctx.moveTo(x, y - 14);
    ctx.quadraticCurveTo(x + 4, y - 6, x, y - 2);
    ctx.quadraticCurveTo(x - 4, y - 6, x, y - 14);
    ctx.fill();
  }

  _drawBanner(ctx, spot) {
    const x = spot.c * TILE;
    ctx.fillStyle = '#7a1f2b';
    ctx.fillRect(x + 6, 0, TILE - 12, TILE * 1.4);
    ctx.fillStyle = '#f2c40c';
    ctx.beginPath();
    ctx.arc(x + TILE / 2, TILE * 0.9, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawChest(ctx, spot) {
    const x = spot.c * TILE, y = spot.r * TILE;
    ctx.fillStyle = '#3a2515';
    ctx.fillRect(x + 4, y + 8, TILE - 8, 6);
    ctx.fillStyle = '#5c3b22';
    ctx.fillRect(x + 4, y + 10, TILE - 8, TILE - 14);
    ctx.fillStyle = '#f2c40c';
    ctx.fillRect(x + TILE / 2 - 2, y + 12, 4, 4);
  }

  _drawHay(ctx, spot) {
    const cx = spot.c * TILE + TILE / 2, cy = spot.r * TILE + TILE / 2;
    ctx.fillStyle = '#c9a227';
    ctx.beginPath();
    ctx.ellipse(cx, cy, 12, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8a6d1a';
    ctx.lineWidth = 1;
    for (let i = -8; i <= 8; i += 6) {
      ctx.beginPath();
      ctx.moveTo(cx + i, cy - 9);
      ctx.lineTo(cx + i, cy + 9);
      ctx.stroke();
    }
  }

  // Value colors for treasure glow/accents, keyed by icon so each piece
  // glows roughly the color of the material it's made from.
  _treasureColor(item) {
    if (item.grand) return '#ffd700';
    const byIcon = {
      goblet: '#e8c766', candlestick: '#d7d9dd', necklace: '#f2f0ea',
      coin: '#e8c766', dagger: '#c9c2d6', mirror: '#cfe8ff',
      ring: '#5fb0ff', comb: '#f2ead6', brooch: '#3fd17a',
      vase: '#e07a9a', tapestry: '#c76b3f', statuette: '#c9863f',
    };
    return byIcon[item.icon] || '#e8c766';
  }

  _renderItems() {
    const ctx = this.ctx;
    const t = performance.now() / 1000;
    for (const item of this.room.items) {
      if (this.collectedItems.has(item.id)) continue;
      const cx = item.col * TILE + TILE / 2;
      const baseCy = item.row * TILE + TILE / 2;
      const bob = Math.sin(t * 2.6 + item.row * 7 + item.col * 3) * 2.5;
      const cy = baseCy + bob;
      const glowColor = item.type === 'key' ? item.color : this._treasureColor(item);

      // A soft, fixed contact shadow anchors the item to the floor tile
      // while the item itself floats and glows above it — the opposite
      // treatment from the grounded, static furniture pieces.
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(cx, baseCy + 10, 7, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.save();
      ctx.shadowColor = glowColor;
      ctx.shadowBlur = 12;
      if (item.type === 'key') {
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(cx - 4, cy, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(cx - 2, cy - 2, 10, 4);
        ctx.fillRect(cx + 4, cy - 5, 3, 3);
        ctx.fillRect(cx + 4, cy + 2, 3, 3);
      } else if (item.grand) {
        this._drawCrownIcon(ctx, cx, cy);
      } else {
        this._drawTreasureIcon(ctx, item.icon, cx, cy);
      }
      ctx.restore();
    }
  }

  // Small, recognisable silhouettes for each minor treasure so it reads
  // as the object it's named after rather than a generic gem shape.
  _drawTreasureIcon(ctx, icon, cx, cy) {
    switch (icon) {
      case 'goblet':
        ctx.fillStyle = '#e8c766';
        // Wide bowl narrowing into a stem, standing on a small round base.
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy - 9);
        ctx.lineTo(cx + 6, cy - 9);
        ctx.lineTo(cx + 2, cy - 1);
        ctx.lineTo(cx + 2, cy + 4);
        ctx.lineTo(cx - 2, cy + 4);
        ctx.lineTo(cx - 2, cy - 1);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(cx - 5, cy + 6, 10, 2.5);
        ctx.strokeStyle = '#a8842e'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx - 6, cy - 9); ctx.lineTo(cx + 6, cy - 9); ctx.stroke();
        break;
      case 'candlestick':
        ctx.fillStyle = '#d7d9dd';
        ctx.fillRect(cx - 5, cy + 5, 10, 3);
        ctx.fillRect(cx - 1.5, cy - 6, 3, 11);
        ctx.beginPath(); ctx.moveTo(cx - 4, cy - 6); ctx.lineTo(cx + 4, cy - 6); ctx.lineTo(cx, cy - 10); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#f2a63c'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy - 14); ctx.stroke();
        break;
      case 'necklace': {
        // A draped chain with a gem pendant hanging from its lowest point.
        ctx.strokeStyle = '#e8c766';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx - 9, cy - 8);
        ctx.quadraticCurveTo(cx, cy + 4, cx + 9, cy - 8);
        ctx.stroke();
        ctx.fillStyle = '#e8c766';
        for (const f of [-0.9, -0.55, -0.2, 0.2, 0.55, 0.9]) {
          const px = cx + f * 9;
          const py = cy - 8 + (1 - f * f) * 12;
          ctx.beginPath();
          ctx.arc(px, py, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#7fd8ff';
        ctx.beginPath();
        ctx.moveTo(cx, cy + 2);
        ctx.lineTo(cx + 3, cy + 7);
        ctx.lineTo(cx, cy + 11);
        ctx.lineTo(cx - 3, cy + 7);
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'coin':
        ctx.fillStyle = '#e8c766';
        ctx.beginPath();
        ctx.arc(cx, cy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#a8842e';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'dagger':
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 4);
        // Blade tapering to a point, a crossguard, a wrapped hilt, and a pommel.
        ctx.fillStyle = '#e8ecf2';
        ctx.beginPath();
        ctx.moveTo(0, -11); ctx.lineTo(2.2, -1); ctx.lineTo(-2.2, -1); ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#9aa0a6'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(0, -1); ctx.stroke();
        ctx.fillStyle = '#8a6d3a';
        ctx.fillRect(-4.5, -1, 9, 2);
        ctx.fillStyle = '#5c3b22';
        ctx.fillRect(-1.6, 1, 3.2, 6);
        ctx.fillStyle = '#e8c766';
        ctx.beginPath(); ctx.arc(0, 8.5, 1.8, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        break;
      case 'mirror':
        ctx.strokeStyle = '#8a6d3a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(cx, cy - 2, 6, 8, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(207,232,255,0.85)';
        ctx.beginPath(); ctx.ellipse(cx, cy - 2, 4.5, 6.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#8a6d3a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx, cy + 6); ctx.lineTo(cx, cy + 11); ctx.stroke();
        break;
      case 'ring':
        ctx.strokeStyle = '#e8c766'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(cx, cy + 2, 6, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#5fb0ff';
        ctx.beginPath(); ctx.moveTo(cx, cy - 7); ctx.lineTo(cx + 3, cy - 3); ctx.lineTo(cx, cy - 1); ctx.lineTo(cx - 3, cy - 3); ctx.closePath(); ctx.fill();
        break;
      case 'comb':
        ctx.fillStyle = '#f2ead6';
        ctx.fillRect(cx - 6, cy - 6, 12, 3);
        ctx.lineWidth = 1.3; ctx.strokeStyle = '#f2ead6';
        for (let i = -5; i <= 5; i += 2.5) {
          ctx.beginPath(); ctx.moveTo(cx + i, cy - 3); ctx.lineTo(cx + i, cy + 7); ctx.stroke();
        }
        break;
      case 'brooch':
        ctx.fillStyle = '#3fd17a';
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const ang = (Math.PI / 4) * i;
          const r = i % 2 === 0 ? 8 : 4;
          const px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#1c1622';
        ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
        break;
      case 'vase':
        ctx.fillStyle = '#e07a9a';
        ctx.beginPath();
        ctx.moveTo(cx - 3, cy - 9); ctx.lineTo(cx + 3, cy - 9);
        ctx.quadraticCurveTo(cx + 6, cy - 4, cx + 4, cy + 2);
        ctx.quadraticCurveTo(cx + 3, cy + 9, cx, cy + 9);
        ctx.quadraticCurveTo(cx - 3, cy + 9, cx - 4, cy + 2);
        ctx.quadraticCurveTo(cx - 6, cy - 4, cx - 3, cy - 9);
        ctx.closePath(); ctx.fill();
        break;
      case 'tapestry':
        ctx.fillStyle = '#c76b3f';
        ctx.fillRect(cx - 7, cy - 9, 14, 16);
        ctx.strokeStyle = '#f2c40c'; ctx.lineWidth = 1;
        ctx.strokeRect(cx - 5, cy - 7, 10, 12);
        break;
      case 'statuette':
      default:
        ctx.fillStyle = '#c9863f';
        ctx.beginPath();
        ctx.ellipse(cx, cy + 7, 6, 2.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(cx - 3, cy - 4, 6, 11);
        ctx.beginPath(); ctx.arc(cx, cy - 6, 3.5, 0, Math.PI * 2); ctx.fill();
        break;
    }
  }

  _drawCrownIcon(ctx, cx, cy) {
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.moveTo(cx - 9, cy + 6);
    ctx.lineTo(cx - 9, cy - 2);
    ctx.lineTo(cx - 4.5, cy + 2);
    ctx.lineTo(cx, cy - 6);
    ctx.lineTo(cx + 4.5, cy + 2);
    ctx.lineTo(cx + 9, cy - 2);
    ctx.lineTo(cx + 9, cy + 6);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#a8842e';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#e0115f';
    ctx.beginPath(); ctx.arc(cx, cy - 4, 1.6, 0, Math.PI * 2); ctx.fill();
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
        const locked = exit.type === 'locked' && !this.unlockedEdges.has(this._edgeId(room.id, exit.to));
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
