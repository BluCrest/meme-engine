const { startExitManager, stopExitManager } = require('./exit-manager');

// Re-export for backward compatibility
function startPositionMonitor() {
  startExitManager();
}

function stopPositionMonitor() {
  stopExitManager();
}

module.exports = { startPositionMonitor, stopPositionMonitor };