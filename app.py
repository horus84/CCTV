import cv2
import json
import os
import threading
import time
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # Enable Cross-Origin Resource Sharing for frontend communication

# --- Configuration ---
CONFIG_FILE = '../cameras.json' # Path relative to backend/app.py
cameras_config = {}
active_streams = {} # Dictionary to hold active stream threads {camera_id: thread_object}
latest_frames = {} # Dictionary to hold the latest frame for each active stream {camera_id: frame}
ai_results = {} # Dictionary to hold AI results {camera_id: result}

# --- AI Model Setup (Placeholders) ---
# TODO: Place model files (e.g., .weights, .cfg, .names) in the backend directory or a subdirectory
MODEL_CONFIG = 'yolov4-tiny.cfg' # Example
MODEL_WEIGHTS = 'yolov4-tiny.weights' # Example
CLASS_NAMES_FILE = 'coco.names' # Example
net = None
output_layers = None
classes = []
CONFIDENCE_THRESHOLD = 0.4
NMS_THRESHOLD = 0.3 # Non-Maximum Suppression

def load_ai_model():
    """Loads the person detection AI model."""
    global net, output_layers, classes
    try:
        if os.path.exists(MODEL_CONFIG) and os.path.exists(MODEL_WEIGHTS):
            net = cv2.dnn.readNet(MODEL_WEIGHTS, MODEL_CONFIG)
            net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU) # Use CPU, can change to GPU if available and configured

            layer_names = net.getLayerNames()
            # Get output layer names correctly depending on OpenCV version
            try:
                # OpenCV 4.x
                output_layers = [layer_names[i - 1] for i in net.getUnconnectedOutLayers()]
            except TypeError:
                 # OpenCV 3.x / Older 4.x
                output_layers = [layer_names[i[0] - 1] for i in net.getUnconnectedOutLayers()]


            if os.path.exists(CLASS_NAMES_FILE):
                 with open(CLASS_NAMES_FILE, 'r') as f:
                    classes = [line.strip() for line in f.readlines()]
            print("AI Model loaded successfully.")
        else:
            print(f"AI Model files not found: {MODEL_CONFIG}, {MODEL_WEIGHTS}")
            net = None # Ensure net is None if loading fails
    except Exception as e:
        print(f"Error loading AI model: {e}")
        net = None

def analyze_frame(camera_id, frame):
    """Analyzes a frame for person detection."""
    if net is None or not classes:
        ai_results[camera_id] = {"person_visible": None, "error": "AI model not loaded"}
        return frame # Return original frame if model not loaded

    height, width = frame.shape[:2]
    blob = cv2.dnn.blobFromImage(frame, 1/255.0, (416, 416), swapRB=True, crop=False)
    net.setInput(blob)
    layer_outputs = net.forward(output_layers)

    boxes = []
    confidences = []
    class_ids = []
    person_detected = False

    for output in layer_outputs:
        for detection in output:
            scores = detection[5:]
            class_id = scores.argmax()
            confidence = scores[class_id]
            if classes[class_id] == 'person' and confidence > CONFIDENCE_THRESHOLD:
                center_x = int(detection[0] * width)
                center_y = int(detection[1] * height)
                w = int(detection[2] * width)
                h = int(detection[3] * height)
                x = int(center_x - w / 2)
                y = int(center_y - h / 2)

                boxes.append([x, y, w, h])
                confidences.append(float(confidence))
                class_ids.append(class_id)
                person_detected = True # Found at least one person

    # Apply Non-Maximum Suppression
    indices = cv2.dnn.NMSBoxes(boxes, confidences, CONFIDENCE_THRESHOLD, NMS_THRESHOLD)

    frame_with_boxes = frame.copy()
    person_visible_in_final = False
    if len(indices) > 0:
         # Check if any of the remaining boxes after NMS are persons
        final_indices = indices.flatten() if isinstance(indices, tuple) else indices
        for i in final_indices:
            if classes[class_ids[i]] == 'person':
                person_visible_in_final = True
                box = boxes[i]
                x, y, w, h = box[0], box[1], box[2], box[3]
                # Draw bounding box and label
                color = (0, 255, 0) # Green
                cv2.rectangle(frame_with_boxes, (x, y), (x + w, y + h), color, 2)
                label = f"Person: {confidences[i]:.2f}"
                cv2.putText(frame_with_boxes, label, (x, y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

    ai_results[camera_id] = {"person_visible": person_visible_in_final}
    return frame_with_boxes


# --- RTSP Stream Handling ---
def stream_processor(camera_id, rtsp_url, is_classroom):
    """Connects to RTSP stream, reads frames, and performs AI analysis if needed."""
    global latest_frames, ai_results
    print(f"Starting stream processor for {camera_id} at {rtsp_url}")
    cap = cv2.VideoCapture(rtsp_url)

    if not cap.isOpened():
        print(f"Error: Could not open RTSP stream for {camera_id}: {rtsp_url}")
        ai_results[camera_id] = {"person_visible": None, "error": "Failed to open stream"}
        latest_frames[camera_id] = None # Indicate error or no frame
        # Clean up if thread was created but stream failed
        if camera_id in active_streams:
             del active_streams[camera_id]
        return

    while camera_id in active_streams: # Check if this stream should still be active
        ret, frame = cap.read()
        if not ret:
            print(f"Stream ended or failed for {camera_id}")
            latest_frames[camera_id] = None # Indicate stream ended
            ai_results[camera_id] = {"person_visible": None, "error": "Stream ended or failed"}
            break # Exit loop if stream fails

        try:
            # Resize frame for performance if needed (optional)
            # frame = cv2.resize(frame, (640, 480))

            if is_classroom:
                processed_frame = analyze_frame(camera_id, frame)
                latest_frames[camera_id] = processed_frame
            else:
                latest_frames[camera_id] = frame
                ai_results[camera_id] = {"person_visible": None} # No AI for non-classroom

        except Exception as e:
            print(f"Error processing frame for {camera_id}: {e}")
            latest_frames[camera_id] = frame # Store original frame on error
            ai_results[camera_id] = {"person_visible": None, "error": f"Frame processing error: {e}"}

        # Small delay to prevent excessive CPU usage if needed, adjust as necessary
        time.sleep(0.01)


    cap.release()
    print(f"Stopped stream processor for {camera_id}")
    # Clean up when thread stops naturally or is stopped externally
    if camera_id in latest_frames: del latest_frames[camera_id]
    if camera_id in ai_results: del ai_results[camera_id]
    if camera_id in active_streams: del active_streams[camera_id] # Ensure cleanup if stopped externally


def find_camera(camera_id):
    """Finds camera details by ID from the loaded config."""
    if not cameras_config:
        return None
    for campus in cameras_config.get('campuses', []):
        for building in campus.get('buildings', []):
            for floor in building.get('floors', []):
                for camera in floor.get('cameras', []):
                    if camera.get('id') == camera_id:
                        return camera
    return None

# --- Flask Routes ---
@app.route('/cameras', methods=['GET'])
def get_cameras():
    """Returns the camera configuration."""
    global cameras_config
    try:
        # Use os.path.join for robust path construction
        config_path = os.path.join(os.path.dirname(__file__), CONFIG_FILE)
        with open(config_path, 'r') as f:
            cameras_config = json.load(f)
        return jsonify(cameras_config)
    except FileNotFoundError:
        return jsonify({"error": f"Configuration file not found at {config_path}"}), 404
    except json.JSONDecodeError:
        return jsonify({"error": "Configuration file is not valid JSON"}), 500
    except Exception as e:
        return jsonify({"error": f"An error occurred: {e}"}), 500

def generate_frames(camera_id):
    """Generator function to yield JPEG frames for streaming."""
    while True:
        frame = latest_frames.get(camera_id)
        if frame is None:
            # Handle stream end/error or initial state
            # Optionally, send a placeholder image or just stop
            print(f"No frame available for {camera_id}, stopping generator.")
            break # Stop yielding frames

        try:
            ret, buffer = cv2.imencode('.jpg', frame)
            if not ret:
                print(f"Failed to encode frame for {camera_id}")
                continue # Skip this frame

            frame_bytes = buffer.tobytes()
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        except Exception as e:
             print(f"Error encoding or yielding frame for {camera_id}: {e}")
             # Decide whether to break or continue based on error type

        # Control frame rate if necessary
        time.sleep(1/30) # Aim for ~30 FPS, adjust as needed

@app.route('/stream/<camera_id>', methods=['GET'])
def stream_camera(camera_id):
    """Starts processing and streams video for a given camera ID."""
    if camera_id not in active_streams:
        camera_info = find_camera(camera_id)
        if not camera_info:
            return jsonify({"error": "Camera ID not found"}), 404

        rtsp_url = camera_info.get('rtsp_url')
        is_classroom = camera_info.get('is_classroom', False)
        if not rtsp_url:
             return jsonify({"error": "RTSP URL not found for camera"}), 404

        # Start the stream processing in a separate thread
        thread = threading.Thread(target=stream_processor, args=(camera_id, rtsp_url, is_classroom), daemon=True)
        active_streams[camera_id] = thread
        latest_frames[camera_id] = None # Initialize frame state
        ai_results[camera_id] = {"person_visible": None} # Initialize AI state
        thread.start()
        print(f"Stream thread started for {camera_id}")
        # Give the thread a moment to start and potentially fail opening the stream
        time.sleep(1)
        if latest_frames.get(camera_id) is None and "error" in ai_results.get(camera_id, {}):
             error_msg = ai_results[camera_id]["error"]
             # Clean up failed thread entry
             if camera_id in active_streams: del active_streams[camera_id]
             if camera_id in latest_frames: del latest_frames[camera_id]
             if camera_id in ai_results: del ai_results[camera_id]
             return jsonify({"error": f"Failed to start stream: {error_msg}"}), 500

    # Return the MJPEG stream
    return Response(generate_frames(camera_id),
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route('/stop_stream/<camera_id>', methods=['POST'])
def stop_stream(camera_id):
    """Stops the stream processing thread for a given camera ID."""
    if camera_id in active_streams:
        print(f"Received request to stop stream for {camera_id}")
        # Signal the thread to stop by removing it from active_streams
        thread = active_streams.pop(camera_id, None)
        # Clean up resources immediately
        if camera_id in latest_frames: del latest_frames[camera_id]
        if camera_id in ai_results: del ai_results[camera_id]

        if thread and thread.is_alive():
             print(f"Attempting to join thread for {camera_id} (may block if thread is stuck)")
             # thread.join(timeout=2) # Wait briefly for thread to exit gracefully
             # if thread.is_alive():
             #      print(f"Warning: Thread for {camera_id} did not exit gracefully.")
        print(f"Stream stopped for {camera_id}")
        return jsonify({"message": f"Stream stopped for {camera_id}"}), 200
    else:
        print(f"Received stop request for inactive stream: {camera_id}")
        return jsonify({"message": f"Stream {camera_id} was not active"}), 404


@app.route('/ai_status/<camera_id>', methods=['GET'])
def get_ai_status(camera_id):
    """Returns the latest AI analysis result for a camera."""
    if camera_id in ai_results:
        return jsonify(ai_results[camera_id])
    elif camera_id in active_streams:
         # Stream is active but AI result not yet ready or not applicable
         return jsonify({"person_visible": None, "status": "Processing or N/A"})
    else:
        return jsonify({"error": "Camera stream not active or ID not found"}), 404


# --- Main Execution ---
if __name__ == '__main__':
    print("Loading AI model...")
    load_ai_model() # Load model on startup
    print("Starting Flask server...")
    # Use 0.0.0.0 to make it accessible on the network if needed, otherwise 127.0.0.1
    # Use a specific port, e.g., 5001, to avoid conflicts
    app.run(host='127.0.0.1', port=5001, debug=False, threaded=True) # threaded=True is important for handling multiple requests/streams
