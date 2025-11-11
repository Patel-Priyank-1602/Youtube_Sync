# 📺 Real-Time YouTube Sync Server (Local Network)

This is a simple, self-hosted Node.js server designed to synchronize YouTube video playback across multiple clients on a local network 🏠. It's perfect for creating a shared viewing experience where one person can control the video (play, pause, seek, load) for everyone else, all in real-time.

It features a web-based controller that generates QR codes 📱 for easy connection to your WiFi hotspot and for accessing the client/controller pages.

---

## 🚀 Features

* **Real-Time Sync:** Control multiple clients from a single controller page.
* **Core Controls:** Supports **Play** ▶️, **Pause** ⏸️, **Seek** ⏩, and **Restart** ⏮️.
* **Load New Videos:** Easily load any YouTube video using its URL or 11-character Video ID.
* **Easy Setup:** Uses a simple `config.json` file to manage WiFi credentials.
* **QR Code Access:**
    * Generates a QR code for your WiFi hotspot so clients can connect easily.
    * Generates QR codes for both the `controller.html` and `client.html` pages.
* **Status Dashboard:** The controller page shows a live count of connected clients 👥.

---

## 🛠️ Tech Stack

* **Server:** Node.js, Express, Socket.io
* **Client:** HTML, CSS, JavaScript (Socket.io client)
* **Utilities:** `qrcode` (for generating QR codes)

---

## 📦 Prerequisites

* [Node.js](https://nodejs.org/) (which includes npm)
* A local WiFi network or mobile hotspot 📶 that all your devices can connect to.

---

## ⚙️ Installation & Setup

1.  **Download Files:**
    Download the project files (`server.js`, `package.json`, etc.) and place them in a new directory 📁.

2.  **Create `public` folder:**
    You must create a folder named `public` and place your `controller.html` and `client.html` files inside it.

    ```
    /your-project
    ├── node_modules/
    ├── public/
    │   ├── client.html      <-- The video player page 💻
    │   └── controller.html  <-- The remote control page 📱
    ├── config.json
    ├── package.json
    └── server.js
    ```

3.  **Install Dependencies:**
    Open a terminal in the project directory and run:
    ```sh
    npm install
    ```
    This will install `express`, `socket.io`, `qrcode`, and other necessary packages.

4.  **Configure WiFi:**
    Create a file named `config.json` in the same directory as `server.js`. This is where you will set the WiFi credentials that the server will share via QR code.

    **`config.json`**
    ```json
    {
      "WIFI_SSID": "Your_Hotspot_Name",
      "WIFI_PASSWORD": "Your_Hotspot_Password"
    }
    ```

---

## ▶️ How to Use

1.  **Start the Server:**
    Run the server from your terminal:
    ```sh
    node server.js
    ```
    A banner will appear in your console showing the server's IP address, port, and the URLs for the controller and client pages.

    ```
    ══════════════════════════════════════════════════════════════════
    YOUTUBE SYNC SERVER 
    ══════════════════════════════════════════════════════════════════
    Status:        Running
    Local Time:    date/month/year, time in am/pm
    Server IP:     10.x.x.x
    Port:          8000

    WiFi Network: WIFI_SSID
    Password:     WIFI_PASSWORD

    Controller URL:
    http://10.x.x.x:8000/controller.html

    Client URL:
    http://10.x.x.x:8000/client.html

    Supports: YouTube Videos
    ══════════════════════════════════════════════════════════════════
    Waiting for connections...
    ...
    ```
    You should either copy the URL from your terminal or scan the QR code.

2.  **Connect Devices:**
    * On your "controller" device (e.g., your phone), open a browser and go to the **Controller URL** printed in the terminal.
    * On your "viewer" devices (e.g., laptops, tablets), connect them to the WiFi hotspot. You can use the "WiFi Connection" QR code on the controller page for this.
    * Once connected, have the viewer devices open the **Client URL**.

3.  **Control Playback:**
    * You should see the "Connected Clients" count increase on the controller page.
    * Paste a YouTube URL or Video ID into the input box on the controller page and click "Load Video".
    * Use the Play, Pause, and Seek buttons to control all connected clients at once. Enjoy the show! 🍿

---

## 🐛 Troubleshooting

* **Clients are out of sync?**
    If a client's video gets out of sync (often due to network lag or video buffering), you can easily force a resync.
    1.  On the **Controller** page, type a time (in seconds) into the **Seek** box.
    2.  Press the **Seek to Time** button.
    3.  You may need to press it **1-2 times** to ensure all clients receive the command and catch up.
