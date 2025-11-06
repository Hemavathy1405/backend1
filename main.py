from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import time
import json
import os
import uuid
from datetime import datetime
from typing import List, Dict, Any
import socketio

app = FastAPI()

# --- THIS IS THE FIX ---
# We must define the specific websites that can connect.
origins = [
    "https://policemonitoring.vercel.app",  # Your police dashboard
    "https://sossafety-alert-9ijj.vercel.app", # Your mobile app
    "http://127.0.0.1:5500", # Your local dashboard for testing
    "http://localhost:5500"  # Your local dashboard for testing
]

# Add CORS middleware for FastAPI
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,       # <-- FIX 1: Use the specific list
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- THIS IS THE SECOND FIX ---
# We remove 'cors_allowed_origins' from here.
# We will let the FastAPI middleware handle all CORS.
sio = socketio.AsyncServer(async_mode='asgi')
app.mount("/socket.io", socketio.ASGIApp(sio))
# --- END OF FIX ---


# Simulated alerts storage
camera_alerts: List[Dict[str, Any]] = []
sos_alerts: List[Dict[str, Any]] = []
active_tracking: Dict[str, Dict[str, Any]] = {}

# Connected officers
connected_officers: Dict[str, Dict[str, Any]] = {}

# Ensure snippets directory exists
os.makedirs("snippets", exist_ok=True)

@app.post("/send-alert")
async def send_alert(alert: Dict[str, Any]):
    # Add timestamp if not present
    if "time" not in alert:
        alert["time"] = datetime.now().isoformat()
    
    # Add unique ID if not present
    if "id" not in alert:
        alert["id"] = str(uuid.uuid4())
    
    # Store alert based on type
    if alert.get("type") == "camera":
        camera_alerts.append(alert)
        # Emit to all connected clients
        await sio.emit("new_camera_alert", alert)
    elif alert.get("type") == "sos":
        sos_alerts.append(alert)
        # Emit to all connected clients
        await sio.emit("new_sos_alert", alert)
    
    return {"status": "success", "id": alert["id"]}

@app.get("/alerts")
async def get_alerts():
    return {
        "camera": camera_alerts,
        "sos": sos_alerts,
        "count": len(camera_alerts) + len(sos_alerts)
    }

@app.get("/alerts/camera")
async def get_camera_alerts():
    return {"alerts": camera_alerts, "count": len(camera_alerts)}

@app.get("/alerts/sos")
async def get_sos_alerts():
    return {"alerts": sos_alerts, "count": len(sos_alerts)}

@app.post("/resolve-alert")
async def resolve_alert(data: Dict[str, Any]):
    alert_id = data.get("alertId")
    alert_type = data.get("alertType")
    
    if alert_type == "camera":
        global camera_alerts
        camera_alerts = [a for a in camera_alerts if a.get("id") != alert_id]
        await sio.emit("camera_alert_resolved", {"id": alert_id})
    elif alert_type == "sos":
        global sos_alerts
        sos_alerts = [a for a in sos_alerts if a.get("id") != alert_id]
        await sio.emit("sos_alert_resolved", {"id": alert_id})
    
    return {"status": "success"}

@app.post("/clear-alerts")
async def clear_alerts():
    global camera_alerts, sos_alerts
    camera_alerts = []
    sos_alerts = []
    await sio.emit("alerts_cleared", {})
    return {"status": "success"}

@app.get("/snippets/{filename}")
async def get_snippet(filename: str):
    file_path = os.path.join("snippets", filename)
    if os..path.exists(file_path):
        return FileResponse(file_path)
    else:
        raise HTTPException(status_code=404, detail="Snippet not found")

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "uptime": int(time.time()),
        "alertCount": len(camera_alerts) + len(sos_alerts),
        "connectedClients": len(connected_officers)
    }

# Socket.IO event handlers
@sio.event
async def connect(sid, environ):
    print(f"Client connected: {sid}")

@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")
    # Remove from connected officers if present
    if sid in connected_officers:
        del connected_officers[sid]

@sio.event
async def officer_login(sid, data):
    # Store officer information
    connected_officers[sid] = {
        "name": data.get("name"),
        "lat": data.get("lat"),
        "lng": data.get("lng"),
        "unit": data.get("unit"),
        "sid": sid
    }
    print(f"Officer {data.get('name')} logged in")
    
    # Send current alerts to the officer
    await sio.emit("all_camera_alerts", camera_alerts, room=sid)
    await sio.emit("all_sos_alerts", sos_alerts, room=sid)

@sio.event
async def update_location(sid, data):
    if sid in connected_officers:
        connected_officers[sid]["lat"] = data.get("lat")
        connected_officers[sid]["lng"] = data.get("lng")
        
        # If this officer is tracking an alert, send tracking update
        for tracking_id, tracking in active_tracking.items():
            if tracking.get("officer_sid") == sid:
                await sio.emit("tracking_update", {
                    "trackingId": tracking_id,
                    "trackingData": {
                        "officerLat": data.get("lat"),
                        "officerLng": data.get("lng"),
                        "alertLat": tracking.get("alert_lat"),
                        "alertLng": tracking.get("alert_lng")
                    }
                }, room=sid)

@sio.event
async def start_tracking(sid, data):
    alert_id = data.get("alertId")
    alert_type = data.get("alertType")
    alert_lat = data.get("alertLat")
    alert_lng = data.get("alertLng")
    
    # Create tracking session
    tracking_id = str(uuid.uuid4())
    active_tracking[tracking_id] = {
        "alert_id": alert_id,
        "alert_type": alert_type,
        "alert_lat": alert_lat,
        "alert_lng": alert_lng,
        "officer_sid": sid,
        "start_time": datetime.now().isoformat()
    }
    
    # Send initial tracking data
    if sid in connected_officers:
        await sio.emit("tracking_update", {
            "trackingId": tracking_id,
            "trackingData": {
                "officerLat": connected_officers[sid]["lat"],
                "officerLng": connected_officers[sid]["lng"],
                "alertLat": alert_lat,
                "alertLng": alert_lng
            }
        }, room=sid)
    
    print(f"Tracking started for alert {alert_id} by officer {connected_officers.get(sid, {}).get('name', 'Unknown')}")
    return {"trackingId": tracking_id}

@sio.event
async def stop_tracking(sid, data):
    # Find and remove tracking session for this officer
    tracking_ids_to_remove = []
    for tracking_id, tracking in active_tracking.items():
        if tracking.get("officer_sid") == sid:
            tracking_ids_to_remove.append(tracking_id)
    
    for tracking_id in tracking_ids_to_remove:
        del active_tracking[tracking_id]
    
    print(f"Tracking stopped by officer {connected_officers.get(sid, {}).get('name', 'Unknown')}")
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3000)
