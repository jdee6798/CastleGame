# Castle of Shadows — Treasure Hunt

A small, self-contained browser game built with plain HTML, CSS and
JavaScript (no build step, no dependencies). Explore a procedurally
generated castle, collect keys to unlock locked doors, gather treasure,
and recover the Crown Jewels hidden deep within the Royal Treasury.

The castle layout is deterministic: every player who opens the game sees
the exact same rooms, keys, locks and treasure, because the layout is
generated from a fixed random seed rather than at random on each load.

## Playing

Since this is a static site with no dependencies, you can open
[index.html](./index.html) directly in a browser, or serve the folder
with any static file server, for example:

```powershell
python -m http.server 8000
```

Then browse to `http://localhost:8000/index.html`.

### Controls

| Action        | Keys                          |
|---------------|--------------------------------|
| Move          | Arrow keys or `W` `A` `S` `D`  |
| Toggle map    | `M`                            |

### Objective

- Explore the castle room by room.
- Doors are sometimes locked and require a matching key (bronze, iron,
  silver, gold or ruby) — every key is always reachable before the door
  it opens, so the castle is always solvable.
- Walk up to a locked door while holding its key to unlock it; the door
  then stays open for the rest of the run.
- Collect minor treasures for points, and find the Crown Jewels in the
  Royal Treasury to win the game.
- Press `M` at any time to check the castle map and see which rooms
  you've visited and which doors are still locked.

## Project structure

```
index.html               Page shell, start/win overlays, hint text
css/style.css            Visual styling for the page, HUD and overlays
js/castle-generator.js   Procedural castle layout generator
js/game.js               Core game engine: rendering, movement, HUD, map
js/main.js               Bootstraps the game and wires up the UI
```

### `js/castle-generator.js`

Generates the entire castle layout deterministically from a fixed seed
(via a small mulberry32 PRNG) so every playthrough is identical. At a
high level it:

1. Carves an irregular room grid out of a rectangle.
2. Builds a spanning tree of rooms (guaranteeing every room is
   reachable) plus a handful of extra loop connections.
3. Chooses a handful of tree edges to gate behind locked doors, then
   places each door's key in a room that is guaranteed reachable
   *before* that door is required — the castle is always solvable.
4. Names rooms, and scatters minor treasures and the Crown Jewels
   through the castle, avoiding key/lock rooms where appropriate.
5. Builds the per-room tile grid (walls, pillars, doors) and validates
   that every door is reachable within the room.

The result is a single in-memory data structure describing every room,
its exits (open/locked + required key), its tile layout, and its items
— consumed by `js/game.js`.

### `js/game.js`

Implements the `Game` class: keyboard input, per-frame movement and
collision, room-to-room transitions through doors, item pickups,
themed room decor (furniture that visually and physically matches a
room's name, e.g. a bed in a bedchamber or cobwebs in a cellar), the
HUD (treasures/score/keys), the on-canvas locked/unlocked messaging,
and the toggleable castle map.

### `js/main.js`

Bootstraps everything on page load: generates the castle, constructs
the `Game`, and wires up the start button and win overlay.

## Development notes

- No build tools, package manager or external libraries are required —
  everything runs directly in the browser from static files.
- The castle seed is fixed in `js/castle-generator.js`; changing the
  `SEED` constant will produce a different (still guaranteed solvable)
  castle layout.
