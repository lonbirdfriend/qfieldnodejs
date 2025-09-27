// server.js
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Für große Geometrie-Daten
app.use(express.static('public'));

// Server Status (false = rot, true = grün)
let serverStatus = {
  status: false,
  lastUpdate: new Date().toISOString(),
  source: 'server'
};

// Polygon data storage
let polygonDatabase = {
  tables: {},
  lastSync: null
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

// Synchronisation Endpoint
app.post('/api/sync', (req, res) => {
  const { action, layerName, data, timestamp, source } = req.body;
  
  console.log(`POST /api/sync - Layer: ${layerName}, Action: ${action}, Polygons: ${data ? data.length : 0}`);
  
  if (!layerName || !data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'LayerName and data array required' });
  }
  
  try {
    // Initialisiere Tabelle falls sie nicht existiert
    if (!polygonDatabase.tables[layerName]) {
      polygonDatabase.tables[layerName] = [];
      console.log(`Neue Tabelle '${layerName}' erstellt`);
    }
    
    let existingData = polygonDatabase.tables[layerName];
    let mergedData = [];
    let newCount = 0;
    let updatedCount = 0;
    
    // Erstelle Map für schnellen Zugriff auf existierende Daten
    let existingMap = {};
    existingData.forEach(item => {
      if (item.id) {
        existingMap[item.id] = item;
      }
    });
    
    // Verarbeite eingehende Daten
    data.forEach(incomingPolygon => {
      if (!incomingPolygon.id) return;
      
      let existingPolygon = existingMap[incomingPolygon.id];
      
      if (existingPolygon) {
        // Merge: Fülle leere Felder mit vorhandenen Daten
        let merged = {
          id: incomingPolygon.id,
          flaeche_ha: incomingPolygon.flaeche_ha || existingPolygon.flaeche_ha || 0,
          bearbeitet: incomingPolygon.bearbeitet || existingPolygon.bearbeitet || "",
          datum: incomingPolygon.datum || existingPolygon.datum || "",
          farbe: incomingPolygon.farbe || existingPolygon.farbe || "",
          geometry: incomingPolygon.geometry || existingPolygon.geometry || "",
          lastUpdate: timestamp || new Date().toISOString(),
          source: source || 'unknown'
        };
        
        // Prüfe ob sich etwas geändert hat
        if (JSON.stringify(merged) !== JSON.stringify(existingPolygon)) {
          updatedCount++;
        }
        
        mergedData.push(merged);
      } else {
        // Neues Polygon
        mergedData.push({
          id: incomingPolygon.id,
          flaeche_ha: incomingPolygon.flaeche_ha || 0,
          bearbeitet: incomingPolygon.bearbeitet || "",
          datum: incomingPolygon.datum || "",
          farbe: incomingPolygon.farbe || "",
          geometry: incomingPolygon.geometry || "",
          lastUpdate: timestamp || new Date().toISOString(),
          source: source || 'unknown'
        });
        newCount++;
      }
    });
    
    // Füge bestehende Polygone hinzu, die nicht in den neuen Daten waren
    existingData.forEach(existing => {
      let found = data.find(incoming => incoming.id === existing.id);
      if (!found) {
        mergedData.push(existing);
      }
    });
    
    // Aktualisiere die Datenbank
    polygonDatabase.tables[layerName] = mergedData;
    polygonDatabase.lastSync = new Date().toISOString();
    
    console.log(`Sync abgeschlossen - Neu: ${newCount}, Aktualisiert: ${updatedCount}, Gesamt: ${mergedData.length}`);
    
    res.json({
      success: true,
      message: `Synchronisation erfolgreich`,
      statistics: {
        totalPolygons: mergedData.length,
        newPolygons: newCount,
        updatedPolygons: updatedCount,
        lastSync: polygonDatabase.lastSync
      },
      serverData: mergedData
    });
    
  } catch (error) {
    console.error('Sync Error:', error);
    res.status(500).json({ error: 'Synchronisation fehlgeschlagen: ' + error.message });
  }
});

// Layer-Daten abrufen
app.get('/api/data/:layerName', (req, res) => {
  const { layerName } = req.params;
  
  if (!polygonDatabase.tables[layerName]) {
    return res.status(404).json({ error: 'Layer nicht gefunden' });
  }
  
  res.json({
    layerName: layerName,
    data: polygonDatabase.tables[layerName],
    lastSync: polygonDatabase.lastSync,
    count: polygonDatabase.tables[layerName].length
  });
});

// Alle Layer auflisten
app.get('/api/layers', (req, res) => {
  const layers = Object.keys(polygonDatabase.tables).map(layerName => ({
    name: layerName,
    polygonCount: polygonDatabase.tables[layerName].length,
    lastUpdate: polygonDatabase.tables[layerName].length > 0 ? 
      Math.max(...polygonDatabase.tables[layerName].map(p => new Date(p.lastUpdate || 0))) : null
  }));
  
  res.json({
    layers: layers,
    totalLayers: layers.length,
    lastSync: polygonDatabase.lastSync
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
    <title>QField Server Dashboard</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            text-align: center;
            margin-bottom: 20px;
        }
        
        .cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        
        .status-display {
            font-size: 2.5em;
            font-weight: bold;
            padding: 20px;
            border-radius: 15px;
            margin: 15px 0;
            text-align: center;
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
        
        .toggle-button, .refresh-button {
            background: linear-gradient(45deg, #2196F3, #1976D2);
            color: white;
            border: none;
            padding: 12px 25px;
            font-size: 1em;
            border-radius: 25px;
            cursor: pointer;
            margin: 10px 5px;
            transition: all 0.3s ease;
            box-shadow: 0 5px 15px rgba(33, 150, 243, 0.3);
        }
        
        .toggle-button:hover, .refresh-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 7px 20px rgba(33, 150, 243, 0.4);
        }
        
        .data-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        
        .data-table th, .data-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        
        .data-table th {
            background-color: #f5f5f5;
            font-weight: bold;
        }
        
        .data-table tr:hover {
            background-color: #f9f9f9;
        }
        
        .info-box {
            background: #e3f2fd;
            border-left: 4px solid #2196F3;
            padding: 15px;
            margin: 15px 0;
            border-radius: 5px;
        }
        
        .sync-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        
        .stat-item {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 10px;
            text-align: center;
        }
        
        .stat-number {
            font-size: 2em;
            font-weight: bold;
            color: #2196F3;
        }
        
        .stat-label {
            font-size: 0.9em;
            color: #666;
            margin-top: 5px;
        }
        
        .polygon-row {
            cursor: pointer;
        }
        
        .polygon-row:hover {
            background-color: #e3f2fd !important;
        }
        
        .color-indicator {
            display: inline-block;
            width: 20px;
            height: 20px;
            border-radius: 50%;
            margin-right: 10px;
            vertical-align: middle;
        }
        
        .tab-buttons {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
        }
        
        .tab-button {
            background: #e0e0e0;
            border: none;
            padding: 10px 20px;
            border-radius: 25px;
            cursor: pointer;
            transition: all 0.3s ease;
        }
        
        .tab-button.active {
            background: #2196F3;
            color: white;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🌐 QField Server Dashboard</h1>
            <div id="statusDisplay" class="status-display">Lädt...</div>
            <button class="toggle-button" onclick="toggleStatus()">Status umschalten</button>
            <button class="refresh-button" onclick="loadAllData()">🔄 Daten aktualisieren</button>
        </div>
        
        <div class="cards">
            <div class="card">
                <h2>📊 Synchronisation</h2>
                <div class="sync-stats" id="syncStats">
                    <div class="stat-item">
                        <div class="stat-number" id="totalLayers">-</div>
                        <div class="stat-label">Layer</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number" id="totalPolygons">-</div>
                        <div class="stat-label">Polygone</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number" id="completedPolygons">-</div>
                        <div class="stat-label">Bearbeitet</div>
                    </div>
                </div>
                <div id="lastSyncTime" class="info-box">Letzte Synchronisation: -</div>
            </div>
            
            <div class="card">
                <h2>🗂️ Layer Übersicht</h2>
                <div id="layersList">Lade Layer...</div>
            </div>
        </div>
        
        <div class="card">
            <h2>📋 Polygon Daten</h2>
            <div class="tab-buttons">
                <button class="tab-button active" onclick="showTab('all')" id="tabAll">Alle</button>
                <button class="tab-button" onclick="showTab('completed')" id="tabCompleted">Bearbeitet</button>
                <button class="tab-button" onclick="showTab('pending')" id="tabPending">Ausstehend</button>
            </div>
            <div id="polygonData">
                <div class="info-box">Wähle einen Layer aus oder synchronisiere Daten...</div>
            </div>
        </div>
        
        <div class="card">
            <h2>🔗 API Endpoints</h2>
            <div class="info-box">
                <strong>Status:</strong><br>
                GET /api/status - Status abrufen<br>
                POST /api/status - Status setzen<br><br>
                
                <strong>Synchronisation:</strong><br>
                POST /api/sync - Daten synchronisieren<br>
                GET /api/data/:layerName - Layer-Daten abrufen<br>
                GET /api/layers - Alle Layer auflisten
            </div>
        </div>
    </div>

    <script>
        let currentTab = 'all';
        let currentLayerData = null;
        
        function getColorStyle(colorCode) {
            switch(colorCode) {
                case 'r': return '#f44336';
                case 'g': return '#4CAF50';
                case 'b': return '#2196F3';
                case 'y': return '#FFEB3B';
                default: return '#e0e0e0';
            }
        }
        
        function getColorName(colorCode) {
            switch(colorCode) {
                case 'r': return 'Rot';
                case 'g': return 'Grün';
                case 'b': return 'Blau';
                case 'y': return 'Gelb';
                default: return 'Unbekannt';
            }
        }
        
        function loadStatus() {
            fetch('/api/status')
                .then(response => response.json())
                .then(data => {
                    const statusDisplay = document.getElementById('statusDisplay');
                    const isGreen = data.status;
                    
                    statusDisplay.textContent = isGreen ? '🟢 GRÜN' : '🔴 ROT';
                    statusDisplay.className = 'status-display ' + (isGreen ? 'status-green' : 'status-red');
                })
                .catch(error => {
                    console.error('Fehler beim Laden des Status:', error);
                    document.getElementById('statusDisplay').textContent = '❌ FEHLER';
                });
        }
        
        function loadLayers() {
            fetch('/api/layers')
                .then(response => response.json())
                .then(data => {
                    document.getElementById('totalLayers').textContent = data.totalLayers;
                    
                    let totalPolygons = data.layers.reduce((sum, layer) => sum + layer.polygonCount, 0);
                    document.getElementById('totalPolygons').textContent = totalPolygons;
                    
                    if (data.lastSync) {
                        document.getElementById('lastSyncTime').innerHTML = 
                            'Letzte Synchronisation: ' + new Date(data.lastSync).toLocaleString('de-DE');
                    }
                    
                    // Layer Liste
                    let layersHtml = '';
                    if (data.layers.length === 0) {
                        layersHtml = '<div class="info-box">Keine Layer gefunden</div>';
                    } else {
                        layersHtml = '<table class="data-table"><thead><tr><th>Layer Name</th><th>Polygone</th><th>Aktion</th></tr></thead><tbody>';
                        data.layers.forEach(layer => {
                            layersHtml += \`<tr>
                                <td>\${layer.name}</td>
                                <td>\${layer.polygonCount}</td>
                                <td><button class="refresh-button" onclick="loadLayerData('\${layer.name}')">Laden</button></td>
                            </tr>\`;
                        });
                        layersHtml += '</tbody></table>';
                    }
                    
                    document.getElementById('layersList').innerHTML = layersHtml;
                })
                .catch(error => {
                    console.error('Fehler beim Laden der Layer:', error);
                    document.getElementById('layersList').innerHTML = '<div class="info-box">Fehler beim Laden</div>';
                });
        }
        
        function loadLayerData(layerName) {
            fetch(\`/api/data/\${layerName}\`)
                .then(response => response.json())
                .then(data => {
                    currentLayerData = data.data;
                    
                    // Update completed polygons count
                    let completedCount = currentLayerData.filter(p => 
                        p.bearbeitet && p.datum && p.farbe
                    ).length;
                    document.getElementById('completedPolygons').textContent = completedCount;
                    
                    showPolygonData();
                })
                .catch(error => {
                    console.error('Fehler beim Laden der Layer-Daten:', error);
                    document.getElementById('polygonData').innerHTML = '<div class="info-box">Fehler beim Laden der Daten</div>';
                });
        }
        
        function showTab(tab) {
            currentTab = tab;
            
            // Update tab buttons
            document.querySelectorAll('.tab-button').forEach(btn => btn.classList.remove('active'));
            document.getElementById('tab' + tab.charAt(0).toUpperCase() + tab.slice(1)).classList.add('active');
            
            showPolygonData();
        }
        
        function showPolygonData() {
            if (!currentLayerData) {
                document.getElementById('polygonData').innerHTML = '<div class="info-box">Keine Daten geladen</div>';
                return;
            }
            
            let filteredData = currentLayerData;
            
            if (currentTab === 'completed') {
                filteredData = currentLayerData.filter(p => p.bearbeitet && p.datum && p.farbe);
            } else if (currentTab === 'pending') {
                filteredData = currentLayerData.filter(p => !p.bearbeitet || !p.datum || !p.farbe);
            }
            
            let html = \`<p>Zeige \${filteredData.length} von \${currentLayerData.length} Polygonen</p>\`;
            
            if (filteredData.length === 0) {
                html += '<div class="info-box">Keine Polygone in dieser Kategorie</div>';
            } else {
                html += \`<table class="data-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Fläche (ha)</th>
                            <th>Bearbeiter</th>
                            <th>Datum</th>
                            <th>Farbe</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>\`;
                
                filteredData.forEach(polygon => {
                    let isCompleted = polygon.bearbeitet && polygon.datum && polygon.farbe;
                    let statusIcon = isCompleted ? '✅' : '⏳';
                    let colorIndicator = polygon.farbe ? 
                        \`<span class="color-indicator" style="background-color: \${getColorStyle(polygon.farbe)}"></span>\${getColorName(polygon.farbe)}\` :
                        '⚪ Nicht gesetzt';
                    
                    html += \`<tr class="polygon-row">
                        <td>\${polygon.id || '-'}</td>
                        <td>\${polygon.flaeche_ha ? polygon.flaeche_ha.toFixed(2) : '-'}</td>
                        <td>\${polygon.bearbeitet || '-'}</td>
                        <td>\${polygon.datum || '-'}</td>
                        <td>\${colorIndicator}</td>
                        <td>\${statusIcon} \${isCompleted ? 'Vollständig' : 'Unvollständig'}</td>
                    </tr>\`;
                });
                
                html += '</tbody></table>';
            }
            
            document.getElementById('polygonData').innerHTML = html;
        }
        
        function toggleStatus() {
            fetch('/api/status')
                .then(response => response.json())
                .then(currentData => {
                    const newStatus = !currentData.status;
                    
                    return fetch('/api/status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: newStatus,
                            timestamp: new Date().toISOString(),
                            source: 'webinterface'
                        })
                    });
                })
                .then(response => response.json())
                .then(data => {
                    loadStatus();
                })
                .catch(error => {
                    console.error('Fehler beim Umschalten:', error);
                });
        }
        
        function loadAllData() {
            loadStatus();
            loadLayers();
        }
        
        // Initial laden
        loadAllData();
        
        // Auto-refresh alle 30 Sekunden
        setInterval(loadAllData, 30000);
    </script>
</body>
</html>
  `);
});

// Server starten
app.listen(PORT, () => {
  console.log(`
🚀 Server läuft auf Port ${PORT}
📊 Webinterface: ${process.env.NODE_ENV === 'production' ? 'https://qfieldnodejs.onrender.com' : `http://localhost:${PORT}`}
🔗 API Status: /api/status
🔄 API Sync: /api/sync
  `);
  console.log(`Aktueller Status: ${serverStatus.status ? 'GRÜN' : 'ROT'}`);
});

module.exports = app;
