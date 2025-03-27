const cameraListDiv = document.getElementById('camera-list');
const videoContainer = document.getElementById('video-container');
const aiStatusDiv = document.getElementById('ai-status');
const errorDiv = document.getElementById('error-message');

let currentCameraId = null;
let aiStatusInterval = null;
let selectedElement = null; // Keep track of the selected camera DOM element

// --- UI Building ---

function buildCameraList(config) {
    if (!config || !config.campuses) {
        cameraListDiv.innerHTML = '<p>Error: Invalid camera configuration received.</p>';
        return;
    }
    if (config.campuses.length === 0) {
        cameraListDiv.innerHTML = '<p>No campuses found in configuration.</p>';
        return;
    }

    const rootUl = document.createElement('ul');
    config.campuses.forEach(campus => {
        const campusLi = document.createElement('li');
        const campusDetails = document.createElement('details');
        const campusSummary = document.createElement('summary');
        campusSummary.textContent = campus.name;
        campusDetails.appendChild(campusSummary);

        const buildingsUl = document.createElement('ul');
        campus.buildings.forEach(building => {
            const buildingLi = document.createElement('li');
            const buildingDetails = document.createElement('details');
            const buildingSummary = document.createElement('summary');
            buildingSummary.textContent = building.name;
            buildingDetails.appendChild(buildingSummary);

            const floorsUl = document.createElement('ul');
            building.floors.forEach(floor => {
                const floorLi = document.createElement('li');
                const floorDetails = document.createElement('details');
                const floorSummary = document.createElement('summary');
                floorSummary.textContent = floor.name;
                floorDetails.appendChild(floorSummary);

                const camerasUl = document.createElement('ul');
                floor.cameras.forEach(camera => {
                    const cameraLi = document.createElement('li');
                    const cameraSpan = document.createElement('span');
                    cameraSpan.textContent = camera.name;
                    cameraSpan.classList.add('camera-item');
                    cameraSpan.dataset.cameraId = camera.id; // Store camera ID
                    cameraSpan.dataset.isClassroom = camera.is_classroom; // Store classroom flag

                    cameraSpan.addEventListener('click', () => {
                        handleCameraClick(camera.id, cameraSpan);
                    });

                    cameraLi.appendChild(cameraSpan);
                    camerasUl.appendChild(cameraLi);
                });
                floorDetails.appendChild(camerasUl);
                floorLi.appendChild(floorDetails);
                floorsUl.appendChild(floorLi);
            });
            buildingDetails.appendChild(floorsUl);
            buildingLi.appendChild(buildingDetails);
            buildingsUl.appendChild(buildingLi);
        });
        campusDetails.appendChild(buildingsUl);
        campusLi.appendChild(campusDetails);
        rootUl.appendChild(campusLi);
    });

    cameraListDiv.innerHTML = ''; // Clear loading message
    cameraListDiv.appendChild(rootUl);
}

// --- Event Handlers ---

function handleCameraClick(cameraId, element) {
    console.log(`Camera clicked: ${cameraId}`);
    clearError(); // Clear previous errors

    if (currentCameraId === cameraId) {
        // Clicked the same camera again, maybe stop viewing?
        // For now, we do nothing, or maybe refresh? Let's just ignore.
        console.log("Same camera clicked, ignoring.");
        return;
    }

     // Deselect previous element
    if (selectedElement) {
        selectedElement.classList.remove('selected');
    }

    // Select new element
    element.classList.add('selected');
    selectedElement = element;


    currentCameraId = cameraId;
    videoContainer.innerHTML = '<p>Connecting to stream...</p>'; // Show loading state
    aiStatusDiv.textContent = 'AI Status: Connecting...';
    aiStatusDiv.className = 'status-bar'; // Reset class

    // Stop previous AI polling if any
    stopAiPolling();

    // Tell main process to start viewing this camera
    window.electronAPI.viewCamera(cameraId);
}

function displayError(message) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

function clearError() {
    errorDiv.textContent = '';
    errorDiv.style.display = 'none';
}


// --- Stream and AI Handling ---

function setStream({ streamUrl, aiStatusUrl, cameraId }) {
     if (cameraId !== currentCameraId) {
        console.log(`Received stream info for ${cameraId}, but currently viewing ${currentCameraId}. Ignoring.`);
        return; // Stale message, ignore
    }
    console.log(`Setting stream source to: ${streamUrl}`);
    videoContainer.innerHTML = `<img src="${streamUrl}" alt="Live Stream for ${cameraId}" onerror="handleStreamError('${cameraId}')" />`;

    // Start polling AI status if it's a classroom camera
    const cameraElement = cameraListDiv.querySelector(`.camera-item[data-camera-id="${cameraId}"]`);
    if (cameraElement && cameraElement.dataset.isClassroom === 'true') {
        startAiPolling(aiStatusUrl, cameraId);
    } else {
        aiStatusDiv.textContent = 'AI Status: N/A (Not a classroom)';
        aiStatusDiv.className = 'status-bar';
    }
}

function handleStreamError(cameraId) {
    // This might be called if the img src fails
    console.error(`Error loading stream image for ${cameraId}`);
     // Check if this is still the current camera before showing error
    if (cameraId === currentCameraId) {
        videoContainer.innerHTML = `<p>Error connecting to stream for ${cameraId}. Check backend and camera.</p>`;
        aiStatusDiv.textContent = 'AI Status: Error';
        aiStatusDiv.className = 'status-bar error';
        displayError(`Failed to load video stream from ${videoContainer.querySelector('img')?.src}. Ensure the backend is running and the camera RTSP URL is correct.`);
        stopAiPolling(); // Stop polling if stream fails
    }
}


function clearStream() {
    console.log("Clearing stream display");
    videoContainer.innerHTML = '<p>Select a camera from the list to view the stream.</p>';
    aiStatusDiv.textContent = 'AI Status: Idle';
    aiStatusDiv.className = 'status-bar';
    currentCameraId = null;
    stopAiPolling();
     if (selectedElement) {
        selectedElement.classList.remove('selected');
        selectedElement = null;
    }
    clearError();
}

function updateAiStatus(statusData, cameraId) {
     if (cameraId !== currentCameraId) {
        console.log(`Received AI status for ${cameraId}, but currently viewing ${currentCameraId}. Ignoring.`);
        return; // Stale status update
    }

    if (statusData.error) {
        aiStatusDiv.textContent = `AI Status: Error (${statusData.error})`;
        aiStatusDiv.className = 'status-bar error';
        console.error(`AI Status Error for ${cameraId}: ${statusData.error}`);
        // Optionally stop polling on certain errors?
        // stopAiPolling();
    } else if (statusData.person_visible === true) {
        aiStatusDiv.textContent = 'AI Status: Teacher Visible';
        aiStatusDiv.className = 'status-bar visible';
    } else if (statusData.person_visible === false) {
        aiStatusDiv.textContent = 'AI Status: Teacher Not Visible';
        aiStatusDiv.className = 'status-bar not-visible';
    } else if (statusData.status === "Processing or N/A") {
         aiStatusDiv.textContent = 'AI Status: Processing...';
         aiStatusDiv.className = 'status-bar'; // Neutral style
    } else {
        aiStatusDiv.textContent = 'AI Status: Unknown';
        aiStatusDiv.className = 'status-bar';
    }
}

function fetchAiStatus(url, cameraId) {
    fetch(url)
        .then(response => {
            if (!response.ok) {
                // Handle HTTP errors (e.g., 404, 500)
                throw new Error(`HTTP error ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            updateAiStatus(data, cameraId);
        })
        .catch(error => {
            console.error(`Error fetching AI status for ${cameraId}:`, error);
             if (cameraId === currentCameraId) { // Only update status if still relevant
                aiStatusDiv.textContent = 'AI Status: Error fetching status';
                aiStatusDiv.className = 'status-bar error';
             }
            // Consider stopping polling if errors persist
            // stopAiPolling();
        });
}

function startAiPolling(aiStatusUrl, cameraId) {
    stopAiPolling(); // Ensure no previous interval is running
    console.log(`Starting AI status polling for ${cameraId} at ${aiStatusUrl}`);
    // Fetch immediately first time
    fetchAiStatus(aiStatusUrl, cameraId);
    // Then fetch every 2 seconds
    aiStatusInterval = setInterval(() => fetchAiStatus(aiStatusUrl, cameraId), 2000);
}

function stopAiPolling() {
    if (aiStatusInterval) {
        console.log("Stopping AI status polling");
        clearInterval(aiStatusInterval);
        aiStatusInterval = null;
    }
}


// --- Initialization ---

async function initialize() {
    try {
        console.log("Requesting camera config from main process...");
        const config = await window.electronAPI.getCameras();
        console.log("Received camera config:", config);
        buildCameraList(config);
        clearError();
    } catch (error) {
        console.error("Failed to initialize:", error);
        cameraListDiv.innerHTML = `<p>Error loading configuration: ${error.error || 'Unknown error'}. Ensure the backend service is running.</p>`;
        displayError(`Failed to load camera list: ${error.error || 'Could not connect to backend.'}`);
    }

    // Setup listeners for events from the main process
    window.electronAPI.onSetStream(setStream);
    window.electronAPI.onClearStream(clearStream);
}

// --- Global Error Handling (Optional) ---
window.addEventListener('error', (event) => {
    console.error('Unhandled error in renderer:', event.error);
    displayError(`An unexpected error occurred: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
     displayError(`An unexpected error occurred: ${event.reason?.message || event.reason || 'Promise rejection'}`);
});


// Start the application logic
initialize();
