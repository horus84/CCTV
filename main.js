const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http'); // To make requests to the backend

// Backend server details
const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 5001; // Must match the port in backend/app.py

let mainWindow;
let currentCameraId = null; // Track the currently viewed camera

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // Recommended for security
      nodeIntegration: false, // Recommended for security
    },
  });

  mainWindow.loadFile('index.html');

  // Open DevTools - remove for production
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Ensure backend stream is stopped when window closes
    stopBackendStream();
  });
}

// --- Backend Communication ---

function stopBackendStream() {
  if (currentCameraId) {
    const options = {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: `/stop_stream/${currentCameraId}`,
      method: 'POST',
    };

    const req = http.request(options, (res) => {
      console.log(`Stop stream response status: ${res.statusCode}`);
      res.on('data', (chunk) => {
        console.log(`Stop stream response body: ${chunk}`);
      });
    });

    req.on('error', (error) => {
      console.error(`Error stopping stream ${currentCameraId}:`, error);
    });

    req.end();
    currentCameraId = null; // Reset tracked camera
  }
}

// --- IPC Handlers (Communication with Renderer Process) ---

// Handle request to get camera config from backend
ipcMain.handle('get-cameras', async () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BACKEND_HOST,
      port: BACKEND_PORT,
      path: '/cameras',
      method: 'GET',
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.error("Failed to parse camera config:", e);
            reject({ error: 'Failed to parse camera config from backend.' });
          }
        } else {
          console.error(`Backend error getting cameras: ${res.statusCode}`, data);
          reject({ error: `Backend error: ${res.statusCode}`, details: data });
        }
      });
    });

    req.on('error', (error) => {
      console.error('Error fetching cameras from backend:', error);
      reject({ error: 'Could not connect to backend service.' });
    });

    req.end();
  });
});

// Handle request to view a specific camera
ipcMain.on('view-camera', (event, cameraId) => {
  console.log(`Main process received view-camera request for: ${cameraId}`);
  // Stop the previous stream before starting a new one
  stopBackendStream();

  currentCameraId = cameraId; // Track the new camera
  const streamUrl = `http://${BACKEND_HOST}:${BACKEND_PORT}/stream/${cameraId}`;
  const aiStatusUrl = `http://${BACKEND_HOST}:${BACKEND_PORT}/ai_status/${cameraId}`;

  // Send the URLs back to the renderer process
  mainWindow.webContents.send('set-stream', { streamUrl, aiStatusUrl, cameraId });
});

// Handle request to stop viewing (e.g., when user deselects or closes)
ipcMain.on('stop-viewing', () => {
  console.log("Main process received stop-viewing request");
  stopBackendStream();
  // Optionally clear the stream in the renderer
  mainWindow.webContents.send('clear-stream');
});


// --- App Lifecycle ---

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Ensure backend stream is stopped
  stopBackendStream();
  // On macOS it's common to stay active until Cmd+Q
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Quit backend process if possible (this might need refinement)
app.on('will-quit', () => {
  stopBackendStream();
  // If the backend was started as a child process, kill it here.
  // Since it's run separately, we can't directly kill it easily.
  console.log("Electron app quitting. Ensure the Python backend is stopped manually if needed.");
});
