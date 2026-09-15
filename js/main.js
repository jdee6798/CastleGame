// Bootstraps the game: builds the castle, wires up the start/win overlays,
// and starts the render loop.
'use strict';

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('game-canvas');
  const startOverlay = document.getElementById('start-overlay');
  const winOverlay = document.getElementById('win-overlay');
  const startButton = document.getElementById('start-button');
  const restartButton = document.getElementById('restart-button');
  const winStats = document.getElementById('win-stats');

  const castle = generateCastleData();
  console.log(
    `Castle of Shadows ready: ${castle.stats.totalRooms} rooms, ` +
    `${castle.stats.totalLocks} locked doors, ${castle.stats.totalTreasures} treasures.`
  );

  const game = new Game(canvas, castle);
  game.paused = true;
  game.start();

  startButton.addEventListener('click', () => {
    startOverlay.classList.add('hidden');
    game.paused = false;
    canvas.focus();
  });

  document.addEventListener('castle-win', (e) => {
    const { score, treasuresFound, totalTreasures, roomsVisited, totalRooms } = e.detail;
    winStats.textContent =
      `Final Score: ${score}. Treasures found: ${treasuresFound}/${totalTreasures}. ` +
      `Rooms explored: ${roomsVisited}/${totalRooms}.`;
    winOverlay.classList.remove('hidden');
  });

  restartButton.addEventListener('click', () => {
    window.location.reload();
  });
});
