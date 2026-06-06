const { invoke } = window.__TAURI__.core;

let localIp = "127.0.0.1";
const webServerPort = 5173;
const wsPort = 5175;

let ws = null;
let pc = null;
let isAlwaysOnTop = true; // Enabled by default in configuration

const videoEl = document.getElementById("stream-video");
const placeholderEl = document.getElementById("placeholder-overlay");
const urlEl = document.getElementById("receiver-url");
const contextMenu = document.getElementById("context-menu");
const topCheck = document.getElementById("menu-top-check");

// Initialize application
async function init() {
  // 1. Fetch Local IP and construct URL
  try {
    localIp = await invoke("get_local_ip");
  } catch (err) {
    console.error("Failed to get local IP:", err);
    localIp = "unknown";
  }
  
  const clientUrl = `http://${localIp}:${webServerPort}`;
  urlEl.textContent = clientUrl;
  
  // Copy URL on click
  urlEl.addEventListener("click", copyUrl);

  // 2. Setup Signaling WebSocket connection
  connectSignaling();

  // 3. Setup window event listeners
  setupWindowControls();
}

// Copy URL helper
async function copyUrl() {
  const url = urlEl.textContent;
  try {
    await navigator.clipboard.writeText(url);
    const originalText = urlEl.textContent;
    urlEl.textContent = "已複製 URL 到剪貼簿！";
    urlEl.style.color = "#10b981";
    setTimeout(() => {
      urlEl.textContent = originalText;
      urlEl.style.color = "";
    }, 2000);
  } catch (err) {
    console.error("Copy failed:", err);
  }
}

// Connect to local WebSocket signaling server
function connectSignaling() {
  const wsUrl = `ws://localhost:${wsPort}`;
  console.log(`Connecting to signaling server: ${wsUrl}`);
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log("Connected to signaling server.");
    // Register as receiver
    ws.send(JSON.stringify({ type: "register", role: "receiver" }));
  };
  
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log("Signaling message received:", data.type);
      
      switch (data.type) {
        case "offer":
          await handleOffer(data.offer);
          break;
        case "candidate":
          if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
          break;
        case "peer_connected":
          console.log("Sender connected, waiting for WebRTC offer...");
          break;
        case "peer_disconnected":
          console.log("Sender disconnected, resetting peer connection.");
          resetPeerConnection();
          break;
      }
    } catch (err) {
      console.error("Error processing signaling message:", err);
    }
  };
  
  ws.onclose = () => {
    console.log("Signaling connection closed. Retrying in 3 seconds...");
    resetPeerConnection();
    setTimeout(connectSignaling, 3000);
  };

  ws.onerror = (err) => {
    console.error("Signaling error:", err);
  };
}

// Reset WebRTC and UI
function resetPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
  videoEl.srcObject = null;
  videoEl.style.display = "none";
  placeholderEl.style.display = "flex";
  document.querySelector(".status-text").textContent = "等待連線";
}

// Handle incoming WebRTC offer from phone
async function handleOffer(offerSdp) {
  resetPeerConnection();
  
  console.log("Creating peer connection...");
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
    ]
  });
  
  // Forward local ICE candidates to the phone
  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "candidate",
        candidate: event.candidate
      }));
    }
  };
  
  // Render incoming video tracks
  pc.ontrack = (event) => {
    console.log("Track received!", event.streams);
    if (event.streams && event.streams[0]) {
      videoEl.srcObject = event.streams[0];
      videoEl.style.display = "block";
      placeholderEl.style.display = "none";
      document.querySelector(".status-text").textContent = "直播中";
    }
  };

  pc.onconnectionstatechange = () => {
    console.log("WebRTC Connection State changed:", pc.connectionState);
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
      resetPeerConnection();
    }
  };
  
  // Set remote offer, create answer, set local answer
  await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  
  // Send answer back to signaling server
  ws.send(JSON.stringify({
    type: "answer",
    answer: answer
  }));
  console.log("Sent answer to sender.");
}

// Setup custom Frameless controls
function setupWindowControls() {
  // Always-on-top initial UI checkmark
  topCheck.style.display = isAlwaysOnTop ? "inline" : "none";
  
  // Double-click to toggle size between compact 640x360 and HD 1280x720
  let isHD = false;
  document.body.addEventListener("dblclick", async (e) => {
    // Avoid double clicks on buttons
    if (e.target.closest("button") || e.target.closest(".context-menu")) return;
    
    // Toggle window dimensions directly
    try {
      // In Tauri v2 we can invoke window methods, but doing it natively is easier.
      // Let's use simple toggling size in the frontend if needed, but since it is resizable by borders,
      // native borders are the primary way. We can also let the window toggle fullscreen.
    } catch (err) {
      console.error(err);
    }
  });

  // Right click custom menu
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    
    // Position menu at cursor coordinates
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.display = "block";
  });

  // Close context menu when clicking outside
  window.addEventListener("click", (e) => {
    if (!e.target.closest(".context-menu")) {
      contextMenu.style.display = "none";
    }
  });

  // Top-right controls bind
  document.getElementById("btn-top").addEventListener("click", toggleAlwaysOnTop);
  document.getElementById("btn-close").addEventListener("click", closeApp);

  // Context menu item actions
  document.getElementById("menu-top").addEventListener("click", toggleAlwaysOnTop);
  document.getElementById("menu-copy-url").addEventListener("click", () => {
    copyUrl();
    contextMenu.style.display = "none";
  });
  document.getElementById("menu-close").addEventListener("click", closeApp);
}

// Toggle Always On Top
async function toggleAlwaysOnTop() {
  isAlwaysOnTop = !isAlwaysOnTop;
  try {
    await invoke("set_always_on_top", { alwaysOnTop: isAlwaysOnTop });
    topCheck.style.display = isAlwaysOnTop ? "inline" : "none";
    console.log(`Always-on-top toggled: ${isAlwaysOnTop}`);
  } catch (err) {
    console.error("Failed to set always on top:", err);
    isAlwaysOnTop = !isAlwaysOnTop; // revert on fail
  }
  contextMenu.style.display = "none";
}

// Close App
async function closeApp() {
  try {
    await invoke("close_app");
  } catch (err) {
    console.error("Failed to close app:", err);
  }
}

// Run init on DOM load
window.addEventListener("DOMContentLoaded", init);
