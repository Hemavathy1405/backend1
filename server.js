const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: 25000,
  pingTimeout: 60000
});

// CORS for all routes
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Create snippets directory if it doesn't exist
const snippetsDir = path.join(__dirname, 'snippets');
if (!fs.existsSync(snippetsDir)) {
  fs.mkdirSync(snippetsDir, { recursive: true });
  console.log('✅ Created snippets directory:', snippetsDir);
}

// Serve snippets with proper headers
app.use('/snippets', express.static(snippetsDir, {
  setHeaders: (res, filepath) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Disposition', 'inline');
    
    const ext = path.extname(filepath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') {
      res.set('Content-Type', 'image/jpeg');
    } else if (ext === '.mp4' || ext === '.avi' || ext === '.mov') {
      res.set('Content-Type', 'video/mp4');
    }
  }
}));

// Serve dashboard
app.use(express.static(path.join(__dirname, '../dashboard')));

// Security
const API_KEY = "secure_key_123";

// Store alerts and tracking
const cameraAlerts = [];
const sosAlerts = [];
const activeTracking = new Map();
const MAX_ALERTS = 200;

// Connected officers
const connectedOfficers = new Map();

// WebSocket connection
io.on('connection', (socket) => {
  console.log('✅ Dashboard connected:', socket.id);
  
  // Send all previous alerts immediately
  socket.emit('all_camera_alerts', cameraAlerts);
  socket.emit('all_sos_alerts', sosAlerts);
  
  socket.on('officer_login', (officer) => {
    connectedOfficers.set(socket.id, {
      name: officer.name || 'Officer',
      lat: officer.lat || 11.1085,
      lng: officer.lng || 77.3411,
      unit: officer.unit || 'Unit-01',
      status: 'available',
      loginTime: new Date()
    });
    console.log(`👮 Officer logged in: ${officer.name}`);
    io.emit('officers_updated', Array.from(connectedOfficers.values()));
  });
  
  socket.on('start_tracking', (data) => {
    const { alertId, alertLat, alertLng, alertType } = data;
    console.log(`🗺️ Tracking started for alert: ${alertId}`);
    
    const officer = connectedOfficers.get(socket.id);
    
    activeTracking.set(socket.id, {
      alertId,
      alertLat: parseFloat(alertLat),
      alertLng: parseFloat(alertLng),
      alertType: alertType || 'camera',
      officerLat: officer?.lat || 11.1085,
      officerLng: officer?.lng || 77.3411,
      startTime: new Date(),
      status: 'tracking'
    });
    
    socket.emit('tracking_started', {
      success: true,
      message: 'Tracking activated',
      alertId
    });
    
    io.emit('tracking_update', {
      officerId: socket.id,
      trackingData: activeTracking.get(socket.id)
    });
  });
  
  socket.on('update_location', (location) => {
    if (connectedOfficers.has(socket.id)) {
      const officer = connectedOfficers.get(socket.id);
      officer.lat = parseFloat(location.lat);
      officer.lng = parseFloat(location.lng);
      
      if (activeTracking.has(socket.id)) {
        const tracking = activeTracking.get(socket.id);
        tracking.officerLat = parseFloat(location.lat);
        tracking.officerLng = parseFloat(location.lng);
        
        io.emit('tracking_update', {
          officerId: socket.id,
          trackingData: tracking
        });
      }
    }
  });
  
  socket.on('stop_tracking', (data) => {
    console.log('🛑 Tracking stopped');
    activeTracking.delete(socket.id);
    io.emit('tracking_stopped', { officerId: socket.id });
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Dashboard disconnected:', socket.id);
    connectedOfficers.delete(socket.id);
    activeTracking.delete(socket.id);
  });
});

// Receive alerts from AI camera system
app.post('/send-alert', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    console.log('❌ Unauthorized alert attempt');
    return res.status(403).json({ success: false, message: "Unauthorized: Invalid API key" });
  }
  
  try {
    const a = req.body;
    console.log('📨 Camera Alert received:', a.place, a.severity);
    
    const alert = {
      id: `CAM-ALERT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'camera',
      severity: (a.severity || 'MEDIUM').toUpperCase(),
      place: a.place || 'Unknown Location',
      alertType: a.type || 'Safety Alert',
      cameraId: a.cameraId || 'CAM-000',
      description: a.description || 'No details',
      lat: parseFloat(a.lat) || 11.1085,
      lng: parseFloat(a.lng) || 77.3411,
      time: a.time || new Date().toISOString(),
      snippet: a.snippet || null,
      personCount: parseInt(a.personCount) || 0,
      threatLevel: a.threatLevel || 'unknown',
      riskFactors: a.riskFactors || 'None',
      motionIntensity: parseFloat(a.motionIntensity) || 0,
      lighting: a.lighting || 'Unknown',
      brightnessLevel: parseInt(a.brightnessLevel) || 0,
      behavior: a.behavior || a.threatLevel || 'suspicious',
      status: 'active',
      receivedAt: new Date().toISOString(),
      respondedBy: null,
      respondedAt: null
    };
    
    cameraAlerts.unshift(alert);
    if (cameraAlerts.length > MAX_ALERTS) cameraAlerts.pop();
    
    console.log(`🚨 NEW CAMERA ALERT [${alert.severity}] ${alert.place}`);
    console.log(`   Snippet: ${alert.snippet ? 'YES' : 'NO'}`);
    console.log(`   Threat: ${alert.threatLevel}`);
    console.log(`   Location: ${alert.lat}, ${alert.lng}`);
    
    // Emit to all connected clients
    io.emit('new_camera_alert', alert);
    
    res.status(200).json({ success: true, alert });
  } catch (error) {
    console.error('❌ Error processing alert:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Receive SOS alerts
app.post('/send-sos-alert', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(403).json({ success: false, message: "Unauthorized" });
  }
  
  try {
    const a = req.body;
    
    const alert = {
      id: `SOS-ALERT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: 'sos',
      severity: 'CRITICAL',
      place: a.place || 'Unknown Location',
      alertType: 'SOS Emergency',
      userName: a.userName || 'Anonymous',
      userPhone: a.userPhone || 'N/A',
      description: a.description || 'SOS button pressed',
      lat: parseFloat(a.lat) || 11.1085,
      lng: parseFloat(a.lng) || 77.3411,
      time: a.time || new Date().toISOString(),
      status: 'active',
      receivedAt: new Date().toISOString()
    };
    
    sosAlerts.unshift(alert);
    if (sosAlerts.length > MAX_ALERTS) sosAlerts.pop();
    
    console.log(`🚨 NEW SOS ALERT from ${alert.userName}`);
    
    io.emit('new_sos_alert', alert);
    
    res.status(200).json({ success: true, alert });
  } catch (error) {
    console.error('❌ Error processing SOS alert:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Resolve alert
app.post('/resolve-alert', (req, res) => {
  const { alertId, alertType } = req.body;
  
  const alerts = alertType === 'sos' ? sosAlerts : cameraAlerts;
  const index = alerts.findIndex(a => a.id === alertId);
  
  if (index === -1) {
    return res.status(404).json({ success: false, message: "Alert not found" });
  }
  
  const alert = alerts[index];
  alert.status = 'resolved';
  alert.respondedAt = new Date().toISOString();
  
  io.emit('alert_resolved', { alert, alertType });
  console.log(`✅ Alert resolved: ${alertId}`);
  
  res.json({ success: true, alert });
});

// Get all alerts
app.get('/alerts', (req, res) => {
  res.json({ 
    success: true, 
    cameraAlerts: {
      count: cameraAlerts.length,
      data: cameraAlerts
    },
    sosAlerts: {
      count: sosAlerts.length,
      data: sosAlerts
    },
    activeTracking: Array.from(activeTracking.values())
  });
});

// Clear alerts
app.post('/clear-alerts', (req, res) => {
  const { alertType } = req.body;
  
  if (alertType === 'camera') {
    const count = cameraAlerts.length;
    cameraAlerts.length = 0;
    io.emit('camera_alerts_cleared');
    res.json({ success: true, cleared: count, type: 'camera' });
  } else if (alertType === 'sos') {
    const count = sosAlerts.length;
    sosAlerts.length = 0;
    io.emit('sos_alerts_cleared');
    res.json({ success: true, cleared: count, type: 'sos' });
  } else {
    const totalCount = cameraAlerts.length + sosAlerts.length;
    cameraAlerts.length = 0;
    sosAlerts.length = 0;
    io.emit('all_alerts_cleared');
    res.json({ success: true, cleared: totalCount, type: 'all' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'running', 
    uptime: process.uptime(), 
    cameraAlertCount: cameraAlerts.length,
    sosAlertCount: sosAlerts.length,
    activeTracking: activeTracking.size,
    connectedOfficers: connectedOfficers.size,
    connectedClients: io.engine.clientsCount,
    timestamp: new Date().toISOString()
  });
});

// Get tracking data
app.get('/tracking-data', (req, res) => {
  res.json({
    success: true,
    tracking: Array.from(activeTracking.entries()).map(([id, data]) => ({
      officerId: id,
      ...data
    })),
    officers: Array.from(connectedOfficers.entries()).map(([id, data]) => ({
      id,
      ...data
    }))
  });
});

// List snippets
app.get('/snippets-list', (req, res) => {
  try {
    const files = fs.readdirSync(snippetsDir);
    res.json({ success: true, files });
  } catch (error) {
    res.json({ success: false, files: [] });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n' + '='.repeat(70));
  console.log('  🚨 WOMEN SAFETY MONITORING - ENHANCED BACKEND');
  console.log('='.repeat(70));
  console.log(`✅ Running on http://localhost:${PORT}`);
  console.log(`📁 Serving snippets from /snippets`);
  console.log(`🗺️  Real-time location tracking enabled`);
  console.log(`📡 WebSocket communication active`);
  console.log(`📱 SOS alerts support ready`);
  console.log(`📹 Video/Image snapshot support`);
  console.log('='.repeat(70) + '\n');
});