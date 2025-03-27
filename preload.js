const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Main -> Renderer communication (listening for events)
  onSetStream: (callback) => ipcRenderer.on('set-stream', (event, data) => callback(data)),
  onClearStream: (callback) => ipcRenderer.on('clear-stream', () => callback()),

  // Renderer -> Main communication (invoking handlers/sending messages)
  getCameras: () => ipcRenderer.invoke('get-cameras'),
  viewCamera: (cameraId) => ipcRenderer.send('view-camera', cameraId),
  stopViewing: () => ipcRenderer.send('stop-viewing'),

  // Function to remove listeners (good practice)
  removeListener: (channel, callback) => ipcRenderer.removeListener(channel, callback),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});

console.log('preload.js executed');
