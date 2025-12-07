import express from "express";
import http from "http";
import { Server } from "socket.io";
import os from "os";
import qrcode from "qrcode";
import fs from "fs";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- LOAD CONFIG ---
let config;
try {
  const configData = fs.readFileSync("config.json", "utf8");
  config = JSON.parse(configData);
} catch (err) {
  console.error("[FATAL] Could not read config.json.", err);
  process.exit(1);
}

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Load existing files from uploads directory on startup
function loadExistingFiles() {
  try {
    const files = fs.readdirSync(uploadsDir);
    let loadedCount = 0;
    
    files.forEach(filename => {
      const filePath = path.join(uploadsDir, filename);
      
      // Skip if file doesn't exist (race condition)
      if (!fs.existsSync(filePath)) return;
      
      const stats = fs.statSync(filePath);
      
      if (stats.isFile()) {
        const ext = path.extname(filename).toLowerCase();
        const videoExts = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.3gp'];
        const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
        
        let fileType = null;
        if (videoExts.includes(ext)) {
          fileType = 'local_video';
        } else if (audioExts.includes(ext)) {
          fileType = 'local_audio';
        }
        
        if (fileType && !uploadedFiles.has(filename)) {
          const fileInfo = {
            id: filename,
            originalName: filename,
            url: `/uploads/${filename}`,
            type: fileType,
            size: stats.size,
            uploadedAt: stats.birthtime.toISOString()
          };
          
          uploadedFiles.set(filename, fileInfo);
          loadedCount++;
        }
      }
    });
    
    if (loadedCount > 0) {
      console.log(`[STARTUP] Loaded ${loadedCount} existing file(s) from uploads directory`);
    }
  } catch (error) {
    console.error('[ERROR] Failed to load existing files:', error);
  }
}

// Watch uploads directory for changes
function watchUploadsDirectory() {
  console.log('[WATCHER] Monitoring /uploads folder for changes...');
  
  fs.watch(uploadsDir, (eventType, filename) => {
    if (!filename) return;
    
    const filePath = path.join(uploadsDir, filename);
    
    // File added or modified
    if (eventType === 'rename' || eventType === 'change') {
      // Use setTimeout to avoid catching incomplete file writes
      setTimeout(() => {
        if (fs.existsSync(filePath)) {
          const stats = fs.statSync(filePath);
          
          if (stats.isFile() && !uploadedFiles.has(filename)) {
            const ext = path.extname(filename).toLowerCase();
            const videoExts = ['.mp4', '.webm', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.3gp'];
            const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'];
            
            let fileType = null;
            if (videoExts.includes(ext)) {
              fileType = 'local_video';
            } else if (audioExts.includes(ext)) {
              fileType = 'local_audio';
            }
            
            if (fileType) {
              const fileInfo = {
                id: filename,
                originalName: filename,
                url: `/uploads/${filename}`,
                type: fileType,
                size: stats.size,
                uploadedAt: stats.birthtime.toISOString()
              };
              
              uploadedFiles.set(filename, fileInfo);
              console.log(`[WATCHER] New file detected: ${filename} (${fileType})`);
              
              // Notify all controllers about new file
              io.to('controllers').emit('file_added', fileInfo);
            }
          }
        } else {
          // File deleted
          if (uploadedFiles.has(filename)) {
            console.log(`[WATCHER] File removed: ${filename}`);
            uploadedFiles.delete(filename);
            
            // Check if deleted file is currently playing
            if (currentMediaState.fileUrl && currentMediaState.fileUrl.includes(filename)) {
              console.log(`[WATCHER] Currently playing file deleted, stopping playback`);
              
              currentMediaState = {
                mediaType: null,
                videoId: null,
                fileUrl: null,
                fileName: null,
                time: 0,
                isPlaying: false,
                volume: currentMediaState.volume,
                isMuted: currentMediaState.isMuted,
                lastUpdate: Date.now()
              };
              
              io.emit("command", { type: "stop" });
              io.emit("current_state", currentMediaState);
            }
            
            // Notify controllers about file removal
            io.to('controllers').emit('file_removed', { filename });
          }
        }
      }, 500); // Wait 500ms to ensure file write is complete
    }
  });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500MB limit
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mp3|webm|ogg|wav|m4a|mkv|avi|mov|flv|wmv|m4v|3gp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = file.mimetype.startsWith('video/') || file.mimetype.startsWith('audio/');
    
    if (mimetype || extname) {
      return cb(null, true);
    }
    cb(new Error("Invalid file type. Only video and audio files are allowed."));
  }
});

// Helper: Get local IPv4 address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const SERVER_IP = config.HOTSPOT_IP || getLocalIP();
const PORT = process.env.PORT || 8000;

// Initialize Express + HTTP + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8 // 100MB for large file transfers
});

// Serve static files
app.use(express.static("public"));
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

// Track connected clients and controllers
const clients = new Map();
const controllers = new Map();
const uploadedFiles = new Map(); // Track uploaded files

// WiFi Configuration
const WIFI_CONFIG = {
  ssid: process.env.WIFI_SSID || config.WIFI_SSID,
  password: process.env.WIFI_PASSWORD || config.WIFI_PASSWORD,
  security: "WPA"
};

// Unified Media State
let currentMediaState = {
  mediaType: null, // "youtube", "local_video", "local_audio"
  videoId: null, // For YouTube
  fileUrl: null, // For local files
  fileName: null, // Original file name
  time: 0,
  isPlaying: false,
  volume: 100,
  isMuted: false,
  lastUpdate: Date.now()
};

// Banner
function printBanner(ip, port) {
  console.clear();
  console.log("\n");
  console.log("═".repeat(70));
  console.log("   MULTI-MEDIA SYNC SERVER");
  console.log("═".repeat(70));
  console.log(`   Status:       Running`);
  console.log(`   Local Time:   ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  console.log(`   Server IP:    ${ip} (Manual: ${!!config.HOTSPOT_IP})`);
  console.log(`   Port:         ${port}`);
  console.log("");
  console.log(`   WiFi Network: ${WIFI_CONFIG.ssid}`);
  console.log(`   Password:     ${WIFI_CONFIG.password}`);
  console.log("");
  console.log(`   Controller URL:`);
  console.log(`   http://${ip}:${port}/controller.html`);
  console.log("");
  console.log(`   Client URL:`);
  console.log(`   http://${ip}:${port}/client.html`);
  console.log("");
  console.log("   Supports: YouTube Videos | Local Videos | Local Audio");
  console.log("═".repeat(70));
  console.log("   Waiting for connections...\n");
}

// Generate WiFi QR code
function generateWiFiQR(ssid, password, security = "WPA") {
  return `WIFI:T:${security};S:${ssid};P:${password};;`;
}

// API Endpoints
app.get("/api/wifi-qr", async (req, res) => {
  try {
    const wifiString = generateWiFiQR(WIFI_CONFIG.ssid, WIFI_CONFIG.password, WIFI_CONFIG.security);
    const qrDataURL = await qrcode.toDataURL(wifiString, {
      errorCorrectionLevel: "H",
      type: "image/png",
      quality: 0.95,
      margin: 1,
      color: { dark: "#000000", light: "#FFFFFF" },
      width: 300
    });
    res.json({ qrCode: qrDataURL, ssid: WIFI_CONFIG.ssid });
  } catch (error) {
    console.error("[ERROR] QR generation failed:", error);
    res.status(500).json({ error: "QR code generation failed" });
  }
});

app.get("/api/connection-qr", async (req, res) => {
  try {
    const ip = SERVER_IP;
    const port = PORT;
    const urls = {
      controller: `http://${ip}:${port}/controller.html`,
      client: `http://${ip}:${port}/client.html`
    };

    const controllerQR = await qrcode.toDataURL(urls.controller, { width: 250 });
    const clientQR = await qrcode.toDataURL(urls.client, { width: 250 });

    res.json({ controllerQR, clientQR, urls });
  } catch (error) {
    res.status(500).json({ error: "QR code generation failed" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    clients: clients.size,
    controllers: controllers.size,
    currentMedia: currentMediaState,
    uploadedFiles: uploadedFiles.size,
    uptime: process.uptime(),
    serverTime: new Date().toISOString()
  });
});

app.get("/api/clients", (req, res) => {
  const clientList = Array.from(clients.values()).map(c => ({
    id: c.id,
    ip: c.ip,
    connectedAt: c.connectedAt,
    lastSeen: c.lastSeen
  }));
  res.json({ clients: clientList, count: clients.size });
});

// File upload endpoint
app.post("/api/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const fileUrl = `/uploads/${req.file.filename}`;
    const fileType = req.file.mimetype.startsWith("video") ? "local_video" : "local_audio";
    
    const fileInfo = {
      id: req.file.filename,
      originalName: req.file.originalname,
      url: fileUrl,
      type: fileType,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    uploadedFiles.set(req.file.filename, fileInfo);

    console.log(`[UPLOAD] ${fileType.toUpperCase()}: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(2)}MB)`);

    res.json({
      success: true,
      file: fileInfo
    });
  } catch (error) {
    console.error("[ERROR] Upload failed:", error);
    res.status(500).json({ error: "Upload failed" });
  }
});

// Get list of uploaded files
app.get("/api/files", (req, res) => {
  const fileList = Array.from(uploadedFiles.values());
  res.json({ files: fileList, count: fileList.length });
});

// Force re-scan uploads directory
app.post("/api/files/rescan", (req, res) => {
  try {
    console.log('[RESCAN] Manually rescanning uploads directory...');
    const beforeCount = uploadedFiles.size;
    
    loadExistingFiles(); // Re-run the scan
    
    const afterCount = uploadedFiles.size;
    const newFiles = afterCount - beforeCount;
    
    console.log(`[RESCAN] Complete. Total files: ${afterCount} (${newFiles >= 0 ? '+' : ''}${newFiles} change)`);
    
    const fileList = Array.from(uploadedFiles.values());
    res.json({ 
      success: true, 
      files: fileList, 
      count: afterCount,
      newFiles: newFiles
    });
  } catch (error) {
    console.error('[ERROR] Rescan failed:', error);
    res.status(500).json({ error: 'Rescan failed' });
  }
});

// Delete uploaded file
app.delete("/api/files/:filename", (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      const deletedFile = uploadedFiles.get(filename);
      uploadedFiles.delete(filename);
      console.log(`[DELETE] File removed: ${filename}`);
      
      // Notify all clients if this file is currently playing
      if (currentMediaState.fileUrl && currentMediaState.fileUrl.includes(filename)) {
        console.log(`[DELETE] Currently playing file deleted, stopping playback on all clients`);
        
        // Reset media state
        currentMediaState = {
          mediaType: null,
          videoId: null,
          fileUrl: null,
          fileName: null,
          time: 0,
          isPlaying: false,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };
        
        // Broadcast stop command to all clients
        io.emit("command", { type: "stop" });
        io.emit("current_state", currentMediaState);
      }
      
      res.json({ success: true, message: "File deleted" });
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch (error) {
    console.error("[ERROR] Delete failed:", error);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Socket.IO Connection Handling
io.on("connection", (socket) => {
  const clientIP = socket.handshake.headers["x-forwarded-for"]?.split(',')[0] || socket.conn.remoteAddress;
  const userAgent = socket.handshake.headers["user-agent"] || "Unknown";

  console.log(`[CONNECTION] New socket: ${socket.id} | IP: ${clientIP}`);

  socket.on("identify", (data) => {
    const role = data?.role === "controller" ? "controller" : "client";
    const metadata = {
      id: socket.id,
      ip: clientIP,
      userAgent,
      connectedAt: new Date().toISOString(),
      lastSeen: Date.now()
    };

    if (role === "controller") {
      controllers.set(socket.id, metadata);
      socket.join('controllers'); // Join controllers room for targeted broadcasts
      console.log(`[CONTROLLER] Registered: ${socket.id}`);
      socket.emit("current_state", currentMediaState);
    } else {
      clients.set(socket.id, metadata);
      console.log(`[CLIENT] Registered: ${socket.id} | Total: ${clients.size}`);
      socket.emit("current_state", currentMediaState);
    }

    io.emit("clients_count", { clients: clients.size, controllers: controllers.size });
  });

  socket.on("command", (data) => {
    if (!controllers.has(socket.id)) {
      console.log(`[WARNING] Command ignored from non-controller: ${socket.id}`);
      return;
    }

    console.log(`[COMMAND] ${data.type.toUpperCase()} | Type: ${data.mediaType || 'N/A'}`);

    // Handle load
    if (data.type === "load") {
      if (data.mediaType === "youtube") {
        let videoId = null;

        if (data.url) {
          const ytMatch = data.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          videoId = ytMatch ? ytMatch[1] : null;
          if (!videoId) {
            socket.emit("error", { message: "Invalid YouTube URL" });
            return;
          }
        } else if (data.videoId) {
          videoId = data.videoId;
        }

        if (!videoId) {
          socket.emit("error", { message: "Invalid YouTube URL or ID" });
          return;
        }

        currentMediaState = {
          mediaType: "youtube",
          videoId,
          fileUrl: null,
          fileName: null,
          time: 0,
          isPlaying: true,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };

        const broadcastData = {
          type: "load",
          mediaType: "youtube",
          videoId,
          time: 0
        };
        socket.broadcast.emit("command", broadcastData);
        io.emit("current_state", currentMediaState);
        return;
      } 
      else if (data.mediaType === "local_video" || data.mediaType === "local_audio") {
        if (!data.fileUrl) {
          socket.emit("error", { message: "File URL is required" });
          return;
        }

        currentMediaState = {
          mediaType: data.mediaType,
          videoId: null,
          fileUrl: data.fileUrl,
          fileName: data.fileName || "Unknown",
          time: 0,
          isPlaying: true,
          volume: currentMediaState.volume,
          isMuted: currentMediaState.isMuted,
          lastUpdate: Date.now()
        };

        const broadcastData = {
          type: "load",
          mediaType: data.mediaType,
          fileUrl: data.fileUrl,
          fileName: data.fileName,
          time: 0
        };
        socket.broadcast.emit("command", broadcastData);
        io.emit("current_state", currentMediaState);
        return;
      }
    }

    // Handle other commands
    updateMediaState(data);
    socket.broadcast.emit("command", data);
  });

  socket.on("heartbeat", () => {
    const update = (map) => {
      if (map.has(socket.id)) {
        const item = map.get(socket.id);
        item.lastSeen = Date.now();
        map.set(socket.id, item);
      }
    };
    update(clients);
    update(controllers);
  });

  socket.on("request_sync", () => {
    if (clients.has(socket.id)) {
      socket.emit("current_state", currentMediaState);
    }
  });

  socket.on("disconnect", (reason) => {
    const wasClient = clients.delete(socket.id);
    const wasController = controllers.delete(socket.id);

    if (wasClient) console.log(`[CLIENT] Left: ${socket.id} | ${reason} | Remaining: ${clients.size}`);
    if (wasController) console.log(`[CONTROLLER] Disconnected: ${socket.id}`);

    io.emit("clients_count", { clients: clients.size, controllers: controllers.size });
  });

  socket.on("error", (err) => {
    console.error(`[SOCKET ERROR] ${socket.id}:`, err.message);
  });
});

// Update media state
function updateMediaState(data) {
  switch (data.type) {
    case "play":
      currentMediaState.isPlaying = true;
      break;
    case "pause":
      currentMediaState.isPlaying = false;
      break;
    case "seek":
      currentMediaState.time = data.time || 0;
      break;
    case "restart":
      currentMediaState.time = 0;
      currentMediaState.isPlaying = true;
      break;
    case "volume":
      currentMediaState.volume = data.volume;
      break;
    case "mute":
      currentMediaState.isMuted = data.muted;
      break;
  }
  currentMediaState.lastUpdate = Date.now();
}

// Cleanup stale connections
setInterval(() => {
  const now = Date.now();
  const timeout = 120000;

  for (const [id, client] of clients.entries()) {
    if (now - client.lastSeen > timeout) {
      console.log(`[CLEANUP] Stale client removed: ${id}`);
      clients.delete(id);
    }
  }
  io.emit("clients_count", { clients: clients.size, controllers: controllers.size });
}, 60000);

// 404 Fallback
app.use((req, res) => {
  res.status(404).send(`
    <pre style="font-family: monospace; color: white; background: #000; padding: 40px; text-align: center; font-size: 14px;">
╔══════════════════════════════════════════════════════════════╗
  MULTI-MEDIA SYNC SERVER ACTIVE
  Controller: http://${SERVER_IP}:${PORT}/controller.html
  Client:     http://${SERVER_IP}:${PORT}/client.html
  WiFi: ${WIFI_CONFIG.ssid} | Pass: ${WIFI_CONFIG.password}
  Supports: YouTube | Local Video | Local Audio
╚══════════════════════════════════════════════════════════════╝
    </pre>
  `);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[SHUTDOWN] Stopping server...");
  io.emit("server_shutdown", { message: "Server shutting down" });
  server.close(() => process.exit(0));
});

process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled Rejection:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err);
  process.exit(1);
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    uptime: process.uptime(),
    clients: clients.size,
    controllers: controllers.size,
    media: currentMediaState.mediaType || "none",
    uploadedFiles: uploadedFiles.size
  });
});

// Start Server
server.listen(PORT, SERVER_IP, () => {
  printBanner(SERVER_IP, PORT);
});