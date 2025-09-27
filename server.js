// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Server Status (false = rot, true = grün)
let serverStatus = {
  status: false,
  lastUpdate: new Date().toISOString(),
  source: 'server'
};

// API Routes
app.get('/api/status', (req, res) => {
  console.log('GET /api/status - Current status:', serverStatus.status ? 'GRÜN' : 'ROT');
  res.json(serverStatus);
});

app.post('/api/status', (req, res) => {
  const { status, timestamp, source } = req.body;
  
  if (typeof status !== 'boolean') {
    return res.status(400).json({ error: 'Status must be boolean' });
  }
  
  serverStatus = {
    status: status,
    lastUpdate: timestamp || new Date().toISOString(),
    source: source || 'unknown'
  };
  
  console.log(`POST /api/status - Status geändert zu: ${status ? 'GRÜN' : 'ROT'} (von ${source || 'unknown'})`);
  
  res.json({
    success: true,
    status: serverStatus.status,
    message: `Status auf ${status ? 'GRÜN' : 'ROT'} gesetzt`
  });
});

// Webinterface Route
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QField Server Status</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .container {
            background: white;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            text-align: center;
            min-width: 400px;
        }
        
        h1 {
            color: #333;
            margin-bottom: 30px;
            font-size: 2.5em;
        }
        
        .status-display {
            font-size: 3em;
            font-weight: bold;
            padding: 30px;
            border-radius: 15px;
            margin: 20px 0;
            transition: all 0.3s ease;
        }
        
        .status-green {
            background: linear-gradient(45deg, #4CAF50, #45a049);
            color: white;
            box-shadow: 0 10px 30px rgba(76, 175, 80, 0.3);
        }
        
        .status-red {
            background: linear-gradient(45deg, #f44336, #d32f2f);
            color: white;
            box-shadow: 0 10px 30px rgba(244, 67, 54, 0.3);
        }
        
        .toggle-button {
            background: linear-gradient(45deg, #2196F3, #1976D2);
            color: white;
            border: none;
            padding: 15px 30px;
            font-size: 1.2em;
            border-radius: 50px;
            cursor: pointer;
            margin: 20px 10px;
            transition: all 0.3s ease;
            box-shadow: 0 5px 15px rgba(33, 150, 243, 0.3);
        }
        
        .toggle-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 7px 20px rgba(33, 150, 243, 0.4);
        }
        
        .info {
            background: #f5f5f5;
            padding: 20px;
            border-radius: 10px;
            margin-top: 20px;
            text-align: left;
        }
        
        .info h3 {
            margin-top: 0;
            color: #333;
        }
        
        .timestamp {
            color: #666;
            font-size: 0.9em;
            margin-top: 10px;
        }
        
        .source {
            display: inline-block;
            background: #e0e0e0;
            padding: 5px 10px;
            border-radius: 15px;
            font-size: 0.8em;
            margin-top: 10px;
        }
        
        .api-info {
            background: #e3f2fd;
            border-left: 4px solid #2196F3;
            padding: 15px;
            margin-top: 20px;
            border-radius: 5px;
        }
        
        .auto-refresh {
            background: #4CAF50;
            color: white;
            padding: 10px 20px;
            border: none;
            border-radius: 25px;
            margin: 10px;
            cursor: pointer;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌐 Server Status Dashboard</h1>
        
        <div id="statusDisplay" class="status-display">
            Lädt...
        </div>
        
        <button class="toggle-button" onclick="toggleStatus()">
            Status umschalten
        </button>
        
        <button class="auto-refresh" onclick="toggleAutoRefresh()" id="autoRefreshBtn">
            Auto-Refresh: AUS
        </button>
        
        <div class="info">
            <h3>📊 Status Information</h3>
            <div id="lastUpdate">Letztes Update: -</div>
            <div id="source" class="source">Quelle: -</div>
            <div class="timestamp" id="currentTime"></div>
        </div>
        
        <div class="api-info">
            <h3>🔗 API Endpoints</h3>
            <strong>GET</strong> /api/status - Status abrufen<br>
            <strong>POST</strong> /api/status - Status setzen<br>
            <small>Body: {"status": true/false, "source": "qfield_plugin"}</small>
        </div>
    </div>

    <script>
        let autoRefreshInterval = null;
        let isAutoRefresh = false;
        
        function updateTime() {
            document.getElementById('currentTime').textContent = 
                'Aktuelle Zeit: ' + new Date().toLocaleString('de-DE');
        }
        
        function loadStatus() {
            fetch('/api/status')
                .then(response => response.json())
                .then(data => {
                    const statusDisplay = document.getElementById('statusDisplay');
                    const isGreen = data.status;
                    
                    statusDisplay.textContent = isGreen ? '🟢 GRÜN' : '🔴 ROT';
                    statusDisplay.className = 'status-display ' + (isGreen ? 'status-green' : 'status-red');
                    
                    document.getElementById('lastUpdate').textContent = 
                        'Letztes Update: ' + new Date(data.lastUpdate).toLocaleString('de-DE');
                    document.getElementById('source').textContent = 'Quelle: ' + data.source;
                })
                .catch(error => {
                    console.error('Fehler beim Laden:', error);
                    document.getElementById('statusDisplay').textContent = '❌ FEHLER';
                    document.getElementById('statusDisplay').className = 'status-display status-red';
                });
        }
        
        function toggleStatus() {
            fetch('/api/status')
                .then(response => response.json())
                .then(currentData => {
                    const newStatus = !currentData.status;
                    
                    return fetch('/api/status', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            status: newStatus,
                            timestamp: new Date().toISOString(),
                            source: 'webinterface'
                        })
                    });
                })
                .then(response => response.json())
                .then(data => {
                    console.log('Status geändert:', data);
                    loadStatus(); // Status neu laden
                })
                .catch(error => {
                    console.error('Fehler beim Umschalten:', error);
                    alert('Fehler beim Umschalten des Status');
                });
        }
        
        function toggleAutoRefresh() {
            const btn = document.getElementById('autoRefreshBtn');
            
            if (isAutoRefresh) {
                clearInterval(autoRefreshInterval);
                btn.textContent = 'Auto-Refresh: AUS';
                btn.style.background = '#4CAF50';
            } else {
                autoRefreshInterval = setInterval(loadStatus, 1000); // Jede Sekunde
                btn.textContent = 'Auto-Refresh: AN';
                btn.style.background = '#f44336';
            }
            
            isAutoRefresh = !isAutoRefresh;
        }
        
        // Initial laden
        loadStatus();
        updateTime();
        setInterval(updateTime, 1000);
    </script>
</body>
</html>
  `);
});

// Server starten
app.listen(PORT, () => {
  console.log(`
🚀 Server läuft auf http://localhost:${PORT}
📊 Webinterface: http://localhost:${PORT}
🔗 API Status: http://localhost:${PORT}/api/status
  `);
  console.log(`Aktueller Status: ${serverStatus.status ? 'GRÜN' : 'ROT'}`);
});

module.exports = app;
