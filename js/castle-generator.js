// Builds a solvable, maze-like castle layout entirely in the browser at
// startup. The seed is fixed, so every player sees the exact same castle
// (rooms, keys, locks and treasure never change between play sessions).
'use strict';

function generateCastleData() {
  // -------------------------------------------------------------------
  // Deterministic PRNG (mulberry32).
  // -------------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SEED = 20240914;
  const rng = mulberry32(SEED);
  const randInt = (n) => Math.floor(rng() * n);
  const pick = (arr) => arr[randInt(arr.length)];
  const shuffle = (arr) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // -------------------------------------------------------------------
  // 1. Grid footprint: rectangle with some cells knocked out so the
  //    castle has an irregular outline.
  // -------------------------------------------------------------------
  const COLS = 7;
  const ROWS = 6;
  const key = (x, y) => `${x},${y}`;

  let active = new Set();
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) active.add(key(x, y));

  const START = { x: 0, y: Math.floor(ROWS / 2) };

  function isConnected(cells, removed) {
    const set = new Set(cells);
    removed.forEach((c) => set.delete(c));
    if (set.size === 0) return false;
    const startKey = key(START.x, START.y);
    if (!set.has(startKey)) return false;
    const seen = new Set([startKey]);
    const stack = [startKey];
    while (stack.length) {
      const cur = stack.pop();
      const [cx, cy] = cur.split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = key(cx + dx, cy + dy);
        if (set.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    return seen.size === set.size;
  }

  const allCells = [...active];
  const removalCandidates = shuffle(allCells.filter((c) => c !== key(START.x, START.y)));
  const removed = new Set();
  const TARGET_REMOVE = 10;
  for (const c of removalCandidates) {
    if (removed.size >= TARGET_REMOVE) break;
    removed.add(c);
    if (!isConnected(allCells, removed)) removed.delete(c);
  }
  removed.forEach((c) => active.delete(c));

  // -------------------------------------------------------------------
  // 2. Spanning tree over the active grid cells (randomized DFS).
  // -------------------------------------------------------------------
  const nodes = [...active];
  const adj = new Map(nodes.map((n) => [n, []]));
  const DIRS = [['N', 0, -1, 'S'], ['S', 0, 1, 'N'], ['E', 1, 0, 'W'], ['W', -1, 0, 'E']];

  function neighborsOf(n) {
    const [x, y] = n.split(',').map(Number);
    const out = [];
    for (const [dir, dx, dy, back] of DIRS) {
      const nk = key(x + dx, y + dy);
      if (active.has(nk)) out.push({ to: nk, dir, back });
    }
    return out;
  }

  const visited = new Set([key(START.x, START.y)]);
  const stack = [key(START.x, START.y)];
  const treeEdges = [];
  while (stack.length) {
    const cur = stack[stack.length - 1];
    const options = shuffle(neighborsOf(cur)).filter((o) => !visited.has(o.to));
    if (options.length === 0) { stack.pop(); continue; }
    const chosen = options[0];
    visited.add(chosen.to);
    adj.get(cur).push({ to: chosen.to, dir: chosen.dir });
    adj.get(chosen.to).push({ to: cur, dir: chosen.back });
    treeEdges.push({ a: cur, b: chosen.to, dir: chosen.dir });
    stack.push(chosen.to);
  }

  const depth = new Map([[key(START.x, START.y), 0]]);
  {
    const q = [key(START.x, START.y)];
    while (q.length) {
      const cur = q.shift();
      for (const { to } of adj.get(cur)) {
        if (!depth.has(to)) { depth.set(to, depth.get(cur) + 1); q.push(to); }
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Choose lock edges (gates) from the tree, shallow -> deep.
  // -------------------------------------------------------------------
  const KEY_TYPES = [
    { id: 'bronze', label: 'Bronze Key', color: '#b08d57' },
    { id: 'iron', label: 'Iron Key', color: '#9aa0a6' },
    { id: 'silver', label: 'Silver Key', color: '#d7d9dd' },
    { id: 'gold', label: 'Gold Key', color: '#f2c40c' },
    { id: 'ruby', label: 'Ruby Key', color: '#e0115f' },
  ];

  const edgeDepth = (e) => Math.max(depth.get(e.a), depth.get(e.b));
  const lockCandidates = shuffle(
    treeEdges.filter((e) => e.a !== key(START.x, START.y) && e.b !== key(START.x, START.y))
  ).sort((e1, e2) => edgeDepth(e1) - edgeDepth(e2));

  const chosenLocks = [];
  const lockedEdgeSet = new Set();
  for (const e of lockCandidates) {
    if (chosenLocks.length >= KEY_TYPES.length) break;
    const far = depth.get(e.a) > depth.get(e.b) ? e.a : e.b;
    const near = far === e.a ? e.b : e.a;
    chosenLocks.push({ near, far });
    lockedEdgeSet.add(`${e.a}|${e.b}`);
    lockedEdgeSet.add(`${e.b}|${e.a}`);
  }
  chosenLocks.sort((l1, l2) => depth.get(l1.far) - depth.get(l2.far));

  function subtreeBeyond(nearNode, farNode) {
    const seen = new Set([farNode]);
    const q = [farNode];
    while (q.length) {
      const cur = q.shift();
      for (const { to } of adj.get(cur)) {
        if (to === nearNode && cur === farNode) continue;
        if (!seen.has(to)) { seen.add(to); q.push(to); }
      }
    }
    return seen;
  }

  const gatedRooms = new Map();
  for (const lock of chosenLocks) {
    const beyond = subtreeBeyond(lock.near, lock.far);
    for (const r of beyond) if (!gatedRooms.has(r)) gatedRooms.set(r, lock);
  }

  function reachableSet(unlockedLocks) {
    const passable = (a, b) => {
      const found = chosenLocks.find(
        (l) => (l.near === a && l.far === b) || (l.near === b && l.far === a)
      );
      if (!found) return true;
      return unlockedLocks.has(found);
    };
    const seen = new Set([key(START.x, START.y)]);
    const q = [key(START.x, START.y)];
    while (q.length) {
      const cur = q.shift();
      for (const { to } of adj.get(cur)) {
        if (!seen.has(to) && passable(cur, to)) { seen.add(to); q.push(to); }
      }
    }
    return seen;
  }

  const unlocked = new Set();
  const keyPlacements = [];
  for (let i = 0; i < chosenLocks.length; i++) {
    const lock = chosenLocks[i];
    lock.keyType = KEY_TYPES[i];
    const reachableNow = [...reachableSet(unlocked)].filter((r) => r !== key(START.x, START.y));
    const placementPool = reachableNow.length ? reachableNow : [key(START.x, START.y)];
    const room = pick(shuffle(placementPool));
    keyPlacements.push({ roomId: room, keyId: lock.keyType.id });
    unlocked.add(lock);
  }

  const fullyReachable = reachableSet(unlocked);
  if (fullyReachable.size !== nodes.length) {
    throw new Error('Generated castle is not fully solvable — adjust SEED.');
  }

  // -------------------------------------------------------------------
  // 4. Extra loop edges between rooms that require the identical set of
  //    locks to reach (so a shortcut can never bypass a gate).
  // -------------------------------------------------------------------
  function requiredLocksFor(room) {
    const req = [];
    let node = room;
    const seenLocks = new Set();
    while (true) {
      const g = gatedRooms.get(node);
      if (!g || seenLocks.has(g.keyType.id)) break;
      seenLocks.add(g.keyType.id);
      req.push(g.keyType.id);
      node = g.near;
    }
    return req.sort().join(',');
  }
  const lockSig = new Map(nodes.map((n) => [n, requiredLocksFor(n)]));

  const existingEdgeSet = new Set(treeEdges.map((e) => `${e.a}|${e.b}`).concat(treeEdges.map((e) => `${e.b}|${e.a}`)));
  const extraEdges = [];
  for (const n of nodes) {
    for (const { to, dir } of neighborsOf(n)) {
      if (n >= to) continue;
      if (existingEdgeSet.has(`${n}|${to}`)) continue;
      if (lockSig.get(n) === lockSig.get(to)) {
        extraEdges.push({ a: n, b: to, dir });
        existingEdgeSet.add(`${n}|${to}`); existingEdgeSet.add(`${to}|${n}`);
      }
    }
  }
  const loopEdges = shuffle(extraEdges).slice(0, 6);

  // -------------------------------------------------------------------
  // 5. Build the exits table per room (open / locked) from tree edges +
  //    chosen locks + loop edges.
  // -------------------------------------------------------------------
  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const exitsByRoom = new Map(nodes.map((n) => [n, {}]));

  function isLockedEdge(a, b) {
    return chosenLocks.find((l) => (l.near === a && l.far === b) || (l.near === b && l.far === a));
  }

  for (const e of treeEdges) {
    const lock = isLockedEdge(e.a, e.b);
    exitsByRoom.get(e.a)[e.dir] = { type: lock ? 'locked' : 'open', to: e.b, keyId: lock ? lock.keyType.id : undefined };
    exitsByRoom.get(e.b)[OPPOSITE[e.dir]] = { type: lock ? 'locked' : 'open', to: e.a, keyId: lock ? lock.keyType.id : undefined };
  }
  for (const e of loopEdges) {
    exitsByRoom.get(e.a)[e.dir] = { type: 'open', to: e.b };
    exitsByRoom.get(e.b)[OPPOSITE[e.dir]] = { type: 'open', to: e.a };
  }

  // -------------------------------------------------------------------
  // 6. Room names + treasures.
  // -------------------------------------------------------------------
  const NAME_POOL = [
    'Guard Room', 'Great Hall', 'Armoury', 'Kitchen', 'Pantry',
    'Scullery', 'Banquet Hall', 'Chapel', 'Sacristy', 'Library', 'Study',
    'Solar', 'Long Gallery', 'Music Room', 'Wine Cellar', 'Root Cellar',
    'Dungeon', 'Oubliette', 'Torture Chamber', 'North Tower', 'South Tower',
    'East Tower', 'West Tower', 'Watchtower', 'Battlements', 'Armoury Vault',
    "Servants' Quarters", "Steward's Office", 'Throne Room', 'Antechamber',
    'Treasury', 'Vault', 'Crypt', 'Ossuary', 'Courtyard', 'Well Room',
    'Stables', 'Falconry', 'Map Room', 'Alchemy Lab', 'Scriptorium',
    "Chamberlain's Room", 'Nursery', 'Bedchamber', 'Privy Council Chamber',
  ];
  const namePool = shuffle(NAME_POOL);
  const nameByRoom = new Map();
  nameByRoom.set(key(START.x, START.y), 'Entrance Hall');
  for (const n of nodes) if (!nameByRoom.has(n)) nameByRoom.set(n, namePool.pop() || `Chamber ${n}`);

  let deepest = key(START.x, START.y);
  for (const n of nodes) if (depth.get(n) > depth.get(deepest)) deepest = n;
  nameByRoom.set(deepest, 'Royal Treasury');

  const MINOR_TREASURES = [
    { name: 'Gold Goblet', value: 50 }, { name: 'Silver Candlestick', value: 30 },
    { name: 'Pearl Necklace', value: 60 }, { name: 'Ancient Coin', value: 20 },
    { name: 'Jeweled Dagger', value: 70 }, { name: 'Ornate Mirror', value: 40 },
    { name: 'Sapphire Ring', value: 65 }, { name: 'Ivory Comb', value: 25 },
    { name: 'Emerald Brooch', value: 75 }, { name: 'Painted Vase', value: 35 },
    { name: 'Silk Tapestry', value: 45 }, { name: 'Bronze Statuette', value: 30 },
  ];

  const keyRoomSet = new Set(keyPlacements.map((k) => k.roomId));
  const treasurePool = shuffle(
    nodes.filter((n) => n !== key(START.x, START.y) && n !== deepest && !keyRoomSet.has(n))
  );
  const NUM_MINOR = Math.min(MINOR_TREASURES.length, treasurePool.length, 12);
  const treasureRooms = treasurePool.slice(0, NUM_MINOR);

  // -------------------------------------------------------------------
  // 7. Tile grid per room (13 x 9), with door gaps + validated obstacles.
  // -------------------------------------------------------------------
  const ROOM_W = 13, ROOM_H = 9;
  const DOOR_COL = Math.floor(ROOM_W / 2);
  const DOOR_ROW = Math.floor(ROOM_H / 2);

  function doorGapCells(dir) {
    if (dir === 'N') return [[0, DOOR_COL - 1], [0, DOOR_COL], [0, DOOR_COL + 1]].map(([r, c]) => ({ r, c }));
    if (dir === 'S') return [[ROOM_H - 1, DOOR_COL - 1], [ROOM_H - 1, DOOR_COL], [ROOM_H - 1, DOOR_COL + 1]].map(([r, c]) => ({ r, c }));
    if (dir === 'W') return [[DOOR_ROW - 1, 0], [DOOR_ROW, 0], [DOOR_ROW + 1, 0]].map(([r, c]) => ({ r, c }));
    if (dir === 'E') return [[DOOR_ROW - 1, ROOM_W - 1], [DOOR_ROW, ROOM_W - 1], [DOOR_ROW + 1, ROOM_W - 1]].map(([r, c]) => ({ r, c }));
    return [];
  }
  function doorTile(dir) {
    if (dir === 'N') return { r: 0, c: DOOR_COL };
    if (dir === 'S') return { r: ROOM_H - 1, c: DOOR_COL };
    if (dir === 'W') return { r: DOOR_ROW, c: 0 };
    if (dir === 'E') return { r: DOOR_ROW, c: ROOM_W - 1 };
  }

  function floodFillReachable(grid, startR, startC) {
    const seen = new Set([`${startR},${startC}`]);
    const q = [[startR, startC]];
    while (q.length) {
      const [r, c] = q.shift();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= ROOM_H || nc >= ROOM_W) continue;
        if (grid[nr][nc] !== 0) continue;
        const k = `${nr},${nc}`;
        if (!seen.has(k)) { seen.add(k); q.push([nr, nc]); }
      }
    }
    return seen;
  }

  function buildRoomTiles(exits, localSeed) {
    const localRng = mulberry32(localSeed);
    const localRandInt = (n) => Math.floor(localRng() * n);
    const dirs = Object.keys(exits);
    let attempt = 0;
    while (true) {
      attempt++;
      const grid = [];
      for (let r = 0; r < ROOM_H; r++) {
        const row = [];
        for (let c = 0; c < ROOM_W; c++) {
          const isBorder = r === 0 || c === 0 || r === ROOM_H - 1 || c === ROOM_W - 1;
          row.push(isBorder ? 1 : 0);
        }
        grid.push(row);
      }
      for (const dir of dirs) for (const { r, c } of doorGapCells(dir)) grid[r][c] = 0;
      const numPillars = 2 + localRandInt(4);
      for (let i = 0; i < numPillars && attempt < 40; i++) {
        const r = 2 + localRandInt(ROOM_H - 4);
        const c = 2 + localRandInt(ROOM_W - 4);
        if (r === DOOR_ROW && (c <= 1 || c >= ROOM_W - 2)) continue;
        if (c === DOOR_COL && (r <= 1 || r >= ROOM_H - 2)) continue;
        grid[r][c] = 1;
      }
      const doorTiles = dirs.map((d) => doorTile(d));
      const first = doorTiles[0] || { r: Math.floor(ROOM_H / 2), c: Math.floor(ROOM_W / 2) };
      const reach = floodFillReachable(grid, first.r, first.c);
      const ok = doorTiles.every((d) => reach.has(`${d.r},${d.c}`));
      if (ok || attempt > 40) return { grid, reach };
    }
  }

  // -------------------------------------------------------------------
  // 8. Assemble final room objects.
  // -------------------------------------------------------------------
  const rooms = {};
  let seedCounter = 1;
  for (const n of nodes) {
    const [gx, gy] = n.split(',').map(Number);
    const exits = exitsByRoom.get(n);
    const { grid, reach } = buildRoomTiles(exits, SEED + (seedCounter++) * 7919);

    const freeCells = [];
    for (let r = 1; r < ROOM_H - 1; r++) {
      for (let c = 1; c < ROOM_W - 1; c++) {
        if (grid[r][c] === 0 && reach.has(`${r},${c}`)) freeCells.push({ r, c });
      }
    }

    const items = [];
    const keyHere = keyPlacements.find((k) => k.roomId === n);
    if (keyHere) {
      const kt = KEY_TYPES.find((k) => k.id === keyHere.keyId);
      const cell = freeCells.length ? freeCells[randInt(freeCells.length)] : { r: 4, c: 6 };
      items.push({ type: 'key', id: `key-${kt.id}`, keyId: kt.id, name: kt.label, color: kt.color, row: cell.r, col: cell.c });
    }
    if (n === deepest) {
      const usedCells = new Set(items.map((it) => `${it.row},${it.col}`));
      const cell = freeCells.find((f) => !usedCells.has(`${f.row},${f.col}`)) || freeCells[randInt(freeCells.length)] || { r: 4, c: 6 };
      items.push({ type: 'treasure', id: 'grand-prize', name: 'Crown Jewels', value: 500, grand: true, row: cell.r, col: cell.c });
    }
    const tIdx = treasureRooms.indexOf(n);
    if (tIdx !== -1) {
      const t = MINOR_TREASURES[tIdx % MINOR_TREASURES.length];
      const usedCells = new Set(items.map((it) => `${it.row},${it.col}`));
      const cell = freeCells.find((f) => !usedCells.has(`${f.row},${f.col}`)) || freeCells[randInt(freeCells.length)] || { r: 3, c: 3 };
      items.push({ type: 'treasure', id: `treasure-${n}`, name: t.name, value: t.value, row: cell.r, col: cell.c });
    }

    rooms[n] = {
      id: n,
      gridX: gx,
      gridY: gy,
      name: nameByRoom.get(n),
      depth: depth.get(n),
      exits,
      tiles: grid,
      items,
    };
  }

  const startDoor = { row: Math.floor(ROOM_H / 2), col: Math.floor(ROOM_W / 2) };

  return {
    seed: SEED,
    roomWidth: ROOM_W,
    roomHeight: ROOM_H,
    startRoomId: key(START.x, START.y),
    startTile: startDoor,
    keyTypes: KEY_TYPES,
    rooms,
    stats: {
      totalRooms: nodes.length,
      totalLocks: chosenLocks.length,
      totalTreasures: NUM_MINOR + 1,
    },
  };
}
