import express from "express";
import http from "http";
import { Server } from "socket.io";
import os from "os";
import qrcode from "qrcode";
import fs from "fs"; // Added fs

// --- LOAD CONFIG ---
// Reads settings from config.json
let config;
try {
  const configData = fs.readFileSync("config.json", "utf8");
  config = JSON.parse(configData);
} catch (err) {
  console.error("[FATAL] Could not read config.json.", err);
  process.exit(1);
}
// --- END LOAD CONFIG ---

// Helper: Get local IPv4 address (non-internal)
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

// Initialize Express + HTTP + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Serve static files from 'public' folder
app.use(express.static("public"));
app.use(express.json());

// Track connected clients and controllers
const clients = new Map();
const controllers = new Map();

// --- WiFi Configuration (NOW FROM config.json) ---
const WIFI_CONFIG = {
  ssid: process.env.WIFI_SSID || config.WIFI_SSID,
  password: process.env.WIFI_PASSWORD || config.WIFI_PASSWORD,
  security: "WPA"
};

// Unified Media State (YouTube Only)
let currentMediaState = {
  mediaType: "youtube",
  videoId: null,   // YouTube ID
  time: 0,
  isPlaying: false,
  volume: 100,
  isMuted: false,
  lastUpdate: Date.now()
};

// Graceful console banner
function printBanner(ip, port) {
  console.clear();
  console.log("\n");
  console.log("═".repeat(66));
  console.log("   YOUTUBE SYNC SERVER - PROFESSIONAL v2.5");
  console.log("═".repeat(66));
  console.log(`   Status:       Running`);
  console.log(`   Local Time:   ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`);
  console.log(`   Server IP:     ${ip}`);
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
  console.log("   Supports: YouTube Videos");
  console.log("═".repeat(66));
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
    const ip = getLocalIP();
    const port = process.env.PORT || 8000;
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

    console.log(`[COMMAND] ${data.type.toUpperCase()} | ID: ${data.videoId || 'N/A'}`);

    // Handle load (YouTube only)
    if (data.type === "load") {
      let videoId = null;

      if (data.url) {
        if (data.url.includes("youtube.com") || data.url.includes("youtu.be")) {
          const ytMatch = data.url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
          videoId = ytMatch ? ytMatch[1] : null;
          if (!videoId) {
            socket.emit("error", { message: "Invalid YouTube URL" });
            return;
          }
        }
      } else if (data.videoId) {
        videoId = data.videoId;
      }
      
      if (!videoId) {
          socket.emit("error", { message: "Invalid YouTube URL or ID" });
          return;
      }

      currentMediaState = {
        ...currentMediaState,
        mediaType: "youtube",
        videoId,
        time: 0,
        isPlaying: true,
        lastUpdate: Date.now()
      };

      const broadcastData = {
        type: "load",
        mediaType: "youtube",
        videoId,
        time: 0
      };
      socket.broadcast.emit("command", broadcastData);
      io.emit("current_state", currentMediaState); // Update all
      return;
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
╔══════════════════════════════════════════════════════════╗
  YOUTUBE SYNC SERVER ACTIVE
  Controller: http://${getLocalIP()}:${process.env.PORT || 8000}/controller.html
  Client:     http://${getLocalIP()}:${process.env.PORT || 8000}/client.html
  WiFi: ${WIFI_CONFIG.ssid} | Pass: ${WIFI_CONFIG.password}
  Supports: YouTube Links
╚══════════════════════════════════════════════════════════╝
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
    media: currentMediaState.videoId ? "youtube" : "none"
  });
});

// Start Server
const PORT = process.env.PORT || 8000;
const IP = getLocalIP();

server.listen(PORT, IP, () => {
  printBanner(IP, PORT);
});