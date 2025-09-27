// server.js - Erweiterte Version mit Projekt-Dashboard
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Server Status
let serverStatus = {
  status: false,
  lastUpdate: new Date().toISOString(),
  source: 'server'
};

// Polygon data storage - erweitert mit Projektinformationen
let polygonDatabase = {
  projects: {},  // Struktur: { projectName: { data: [], info: { name, colorWorkers, workerPercentages } } }
  lastSync: null
};

// Hilfsfunktionen für Statistiken
function calculateProjectStatistics(projectData) {
  if (!projectData || !projectData.data) {
    return {
      totalPolygons: 0,
      completedPolygons: 0,
      completionPercentage: 0,
      totalArea: 0,
      completedArea: 0,
      workerStats: {},
      participantCount: 0
    };
  }

  const data = projectData.data;
  const info = projectData.info || {};
  
  let totalPolygons = data.length;
  let completedPolygons = data.filter(p => p.bearbeitet && p.datum && p.farbe).length;
  let totalArea = data.reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
  let completedArea = data.filter(p => p.bearbeitet && p.datum && p.farbe)
    .reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
  
  // Worker-Statistiken nach Farbe gruppiert
  let workerStats = {};
  ['r', 'g', 'b', 'y'].forEach(colorCode => {
    if (info.colorWorkers && info.colorWorkers[colorCode]) {
      const workerName = info.colorWorkers[colorCode];
      const workerPolygons = data.filter(p => p.farbe === colorCode && p.bearbeitet && p.datum);
      const workerArea = workerPolygons.reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
      
      // Chronologie nach Datum gruppieren
      const dateGroups = {};
      workerPolygons.forEach(p => {
        const datum = p.datum;
        if (!dateGroups[datum]) {
          dateGroups[datum] = {
            datum: datum,
            area: 0,
            polygonCount: 0,
            polygonIds: []
          };
        }
        dateGroups[datum].area += parseFloat(p.flaeche_ha) || 0;
        dateGroups[datum].polygonCount += 1;
        dateGroups[datum].polygonIds.push(p.id);
      });
      
      // Gruppierte Chronologie erstellen und sortieren
      const groupedChronology = Object.values(dateGroups)
        .sort((a, b) => {
          // Sortierung nach Datum (DD.MM.YYYY)
          const dateA = a.datum.split('.').reverse().join('-');
          const dateB = b.datum.split('.').reverse().join('-');
          return new Date(dateB) - new Date(dateA);
        });
      
      workerStats[colorCode] = {
        name: workerName,
        color: colorCode,
        area: workerArea,
        polygonCount: workerPolygons.length,
        percentage: totalArea > 0 ? (workerArea / totalArea * 100) : 0,
        chronology: groupedChronology
      };
    }
  });

  return {
    totalPolygons,
    completedPolygons,
    completionPercentage: totalPolygons > 0 ? (completedPolygons / totalPolygons * 100) : 0,
    totalArea,
    completedArea,
    completionAreaPercentage: totalArea > 0 ? (completedArea / totalArea * 100) : 0,
    workerStats,
    participantCount: Object.keys(workerStats).length
  };
}

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

// Erweiterte Synchronisation mit Projektinformationen
app.post('/api/sync', (req, res) => {
  const { action, layerName, data, timestamp, source, projectInfo } = req.body;
  
  console.log(`POST /api/sync - Layer: ${layerName}, Action: ${action}, Polygons: ${data ? data.length : 0}`);
  
  if (!layerName || !data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'LayerName and data array required' });
  }
  
  try {
    const projectName = projectInfo?.projectName || layerName;
    
    // Initialisiere Projekt falls es nicht existiert
    if (!polygonDatabase.projects[projectName]) {
      polygonDatabase.projects[projectName] = {
        data: [],
        info: projectInfo || {}
      };
      console.log(`Neues Projekt '${projectName}' erstellt`);
    }
    
    // Aktualisiere Projektinformationen
    if (projectInfo) {
      polygonDatabase.projects[projectName].info = {
        ...polygonDatabase.projects[projectName].info,
        ...projectInfo
      };
    }
    
    let existingData = polygonDatabase.projects[projectName].data;
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
    
    // Aktualisiere das Projekt
    polygonDatabase.projects[projectName].data = mergedData;
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

// Projekt-Übersicht für Dashboard
app.get('/api/projects', (req, res) => {
  const projects = Object.keys(polygonDatabase.projects).map(projectName => {
    const projectData = polygonDatabase.projects[projectName];
    const stats = calculateProjectStatistics(projectData);
    
    return {
      name: projectName,
      ...stats,
      lastUpdate: projectData.data.length > 0 ? 
        Math.max(...projectData.data.map(p => new Date(p.lastUpdate || 0))) : null
    };
  });
  
  res.json({
    projects: projects,
    totalProjects: projects.length,
    lastSync: polygonDatabase.lastSync
  });
});

// Detaillierte Projekt-Daten
app.get('/api/project/:projectName', (req, res) => {
  const { projectName } = req.params;
  
  if (!polygonDatabase.projects[projectName]) {
    return res.status(404).json({ error: 'Projekt nicht gefunden' });
  }
  
  const projectData = polygonDatabase.projects[projectName];
  const stats = calculateProjectStatistics(projectData);
  
  res.json({
    projectName: projectName,
    info: projectData.info,
    data: projectData.data,
    statistics: stats,
    lastSync: polygonDatabase.lastSync
  });
});

// Legacy Endpoints für Rückwärtskompatibilität
app.get('/api/data/:layerName', (req, res) => {
  const { layerName } = req.params;
  
  if (!polygonDatabase.projects[layerName]) {
    return res.status(404).json({ error: 'Layer nicht gefunden' });
  }
  
  res.json({
    layerName: layerName,
    data: polygonDatabase.projects[layerName].data,
    lastSync: polygonDatabase.lastSync,
    count: polygonDatabase.projects[layerName].data.length
  });
});

app.get('/api/layers', (req, res) => {
  const layers = Object.keys(polygonDatabase.projects).map(projectName => ({
    name: projectName,
    polygonCount: polygonDatabase.projects[projectName].data.length,
    lastUpdate: polygonDatabase.projects[projectName].data.length > 0 ? 
      Math.max(...polygonDatabase.projects[projectName].data.map(p => new Date(p.lastUpdate || 0))) : null
  }));
  
  res.json({
    layers: layers,
    totalLayers: layers.length,
    lastSync: polygonDatabase.lastSync
  });
});

// Haupt-Dashboard Route
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QField Projekt Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            text-align: center;
            margin-bottom: 30px;
        }
        
        .header h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 2.5em;
        }
        
        .project-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .project-card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            cursor: pointer;
            transition: all 0.3s ease;
            border: 3px solid transparent;
        }
        
        .project-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 40px rgba(0,0,0,0.15);
            border-color: #667eea;
        }
        
        .project-name {
            font-size: 1.4em;
            font-weight: bold;
            color: #333;
            margin-bottom: 15px;
        }
        
        .progress-container {
            background: #f0f0f0;
            border-radius: 10px;
            height: 25px;
            margin-bottom: 15px;
            overflow: hidden;
            position: relative;
        }
        
        .progress-bar {
            height: 100%;
            background: linear-gradient(45deg, #4CAF50, #45a049);
            border-radius: 10px;
            transition: width 0.8s ease;
            position: relative;
        }
        
        .progress-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-weight: bold;
            font-size: 0.9em;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
        }
        
        .project-stats {
            display: flex;
            justify-content: space-between;
            color: #666;
            font-size: 0.9em;
        }
        
        .stat-item {
            text-align: center;
        }
        
        .stat-number {
            font-size: 1.2em;
            font-weight: bold;
            color: #333;
        }
        
        .back-button {
            background: linear-gradient(45deg, #2196F3, #1976D2);
            color: white;
            border: none;
            padding: 12px 25px;
            font-size: 1em;
            border-radius: 25px;
            cursor: pointer;
            margin-bottom: 20px;
            transition: all 0.3s ease;
            box-shadow: 0 5px 15px rgba(33, 150, 243, 0.3);
        }
        
        .back-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 7px 20px rgba(33, 150, 243, 0.4);
        }
        
        .project-detail {
            display: none;
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .overall-progress {
            margin-bottom: 30px;
        }
        
        .worker-progress {
            display: flex;
            height: 40px;
            border-radius: 20px;
            overflow: hidden;
            margin-bottom: 20px;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.1);
        }
        
        .worker-segment {
            transition: all 0.3s ease;
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            color: white;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.3);
        }
        
        .worker-tabs {
            display: flex;
            gap: 5px;
            margin-bottom: 20px;
        }
        
        .worker-tab {
            padding: 10px 20px;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-weight: bold;
            color: white;
            transition: all 0.3s ease;
            min-width: 120px;
        }
        
        .worker-tab.active {
            transform: scale(1.05);
            box-shadow: 0 5px 15px rgba(0,0,0,0.2);
        }
        
        .worker-detail {
            background: #f9f9f9;
            border-radius: 15px;
            padding: 20px;
            margin-bottom: 20px;
        }
        
        .chronology-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        
        .chronology-table th,
        .chronology-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #ddd;
        }
        
        .chronology-table th {
            background-color: #f5f5f5;
            font-weight: bold;
        }
        
        .chronology-table tr:hover {
            background-color: #f0f0f0;
        }
        
        .summary-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        
        .summary-card {
            background: white;
            border-radius: 10px;
            padding: 20px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .summary-number {
            font-size: 2em;
            font-weight: bold;
            color: #2196F3;
        }
        
        .summary-label {
            color: #666;
            margin-top: 5px;
        }
        
        .hidden {
            display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Dashboard Übersicht -->
        <div id="dashboard">
            <div class="header">
                <h1>🏗️ QField Projekt Dashboard</h1>
                <p>Übersicht aller Projekte und deren Fortschritt</p>
            </div>
            
            <div id="projectGrid" class="project-grid">
                <!-- Projekte werden hier dynamisch geladen -->
            </div>
        </div>
        
        <!-- Projekt Detail Ansicht -->
        <div id="projectDetail" class="project-detail">
            <button class="back-button" onclick="showDashboard()">← Zurück zur Übersicht</button>
            
            <h2 id="projectTitle">Projekt Details</h2>
            
            <div class="overall-progress">
                <h3>Gesamtfortschritt nach Bearbeitern</h3>
                <div id="workerProgress" class="worker-progress">
                    <!-- Worker-Segmente werden hier eingefügt -->
                </div>
            </div>
            
            <div id="workerTabs" class="worker-tabs">
                <!-- Tabs werden hier eingefügt -->
            </div>
            
            <div id="workerDetail" class="worker-detail">
                <!-- Details werden hier angezeigt -->
            </div>
            
            <div class="summary-stats" id="summaryStats">
                <!-- Zusammenfassung wird hier angezeigt -->
            </div>
        </div>
    </div>

    <script>
        let currentProject = null;
        let currentWorker = null;
        
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
        
        function loadProjects() {
            fetch('/api/projects')
                .then(response => response.json())
                .then(data => {
                    const grid = document.getElementById('projectGrid');
                    
                    if (data.projects.length === 0) {
                        grid.innerHTML = '<div style="text-align: center; color: white; font-size: 1.2em;">Keine Projekte gefunden</div>';
                        return;
                    }
                    
                    grid.innerHTML = '';
                    
                    data.projects.forEach(project => {
                        const card = document.createElement('div');
                        card.className = 'project-card';
                        card.onclick = () => showProject(project.name);
                        
                        card.innerHTML = \`
                            <div class="project-name">\${project.name}</div>
                            <div class="progress-container">
                                <div class="progress-bar" style="width: \${project.completionPercentage}%">
                                    <div class="progress-text">\${project.completionPercentage.toFixed(1)}%</div>
                                </div>
                            </div>
                            <div class="project-stats">
                                <div class="stat-item">
                                    <div class="stat-number">\${project.completedPolygons}/\${project.totalPolygons}</div>
                                    <div>Polygone</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-number">\${project.completedArea.toFixed(1)} ha</div>
                                    <div>Bearbeitet</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-number">\${project.participantCount}</div>
                                    <div>Beteiligte</div>
                                </div>
                            </div>
                        \`;
                        
                        grid.appendChild(card);
                    });
                })
                .catch(error => {
                    console.error('Fehler beim Laden der Projekte:', error);
                    document.getElementById('projectGrid').innerHTML = 
                        '<div style="text-align: center; color: white; font-size: 1.2em;">Fehler beim Laden der Projekte</div>';
                });
        }
        
        function showProject(projectName) {
            fetch(\`/api/project/\${projectName}\`)
                .then(response => response.json())
                .then(data => {
                    currentProject = data;
                    
                    document.getElementById('dashboard').style.display = 'none';
                    document.getElementById('projectDetail').style.display = 'block';
                    document.getElementById('projectTitle').textContent = data.projectName;
                    
                    // Gesamt-Fortschrittsbalken erstellen
                    const workerProgress = document.getElementById('workerProgress');
                    workerProgress.innerHTML = '';
                    
                    Object.values(data.statistics.workerStats).forEach(worker => {
                        const segment = document.createElement('div');
                        segment.className = 'worker-segment';
                        segment.style.backgroundColor = getColorStyle(worker.color);
                        segment.style.width = \`\${worker.percentage}%\`;
                        segment.textContent = worker.percentage > 5 ? \`\${worker.name} \${worker.percentage.toFixed(1)}%\` : '';
                        workerProgress.appendChild(segment);
                    });
                    
                    // Worker Tabs erstellen
                    const tabsContainer = document.getElementById('workerTabs');
                    tabsContainer.innerHTML = '';
                    
                    Object.values(data.statistics.workerStats).forEach((worker, index) => {
                        const tab = document.createElement('button');
                        tab.className = 'worker-tab' + (index === 0 ? ' active' : '');
                        tab.style.backgroundColor = getColorStyle(worker.color);
                        tab.textContent = worker.name;
                        tab.onclick = () => showWorkerDetail(worker, tab);
                        tabsContainer.appendChild(tab);
                    });
                    
                    // Ersten Worker anzeigen
                    if (Object.values(data.statistics.workerStats).length > 0) {
                        showWorkerDetail(Object.values(data.statistics.workerStats)[0], tabsContainer.firstChild);
                    }
                    
                    // Zusammenfassungsstatistiken
                    updateSummaryStats(data.statistics);
                })
                .catch(error => {
                    console.error('Fehler beim Laden des Projekts:', error);
                });
        }
        
        function showWorkerDetail(worker, tabElement) {
            // Tab-Status aktualisieren
            document.querySelectorAll('.worker-tab').forEach(tab => tab.classList.remove('active'));
            tabElement.classList.add('active');
            
            const detailContainer = document.getElementById('workerDetail');
            
            let chronologyHtml = '';
            if (worker.chronology.length > 0) {
                chronologyHtml = \`
                    <h4>Chronologie nach Datum (neueste zuerst)</h4>
                    <table class="chronology-table">
                        <thead>
                            <tr>
                                <th>Datum</th>
                                <th>Anzahl Polygone</th>
                                <th>Gesamtfläche (ha)</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${worker.chronology.map(entry => \`
                                <tr>
                                    <td>\${entry.datum}</td>
                                    <td>\${entry.polygonCount}</td>
                                    <td>\${entry.area.toFixed(2)}</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                \`;
            } else {
                chronologyHtml = '<div style="text-align: center; color: #666; padding: 20px;">Keine Bearbeitungen von diesem Bearbeiter</div>';
            }
            
            detailContainer.innerHTML = \`
                <h3 style="color: \${getColorStyle(worker.color)};">\${worker.name}</h3>
                <div style="margin-bottom: 20px;">
                    <strong>Gesamtfläche:</strong> \${worker.area.toFixed(2)} ha (\${worker.percentage.toFixed(1)}% des Projekts)<br>
                    <strong>Anzahl Polygone:</strong> \${worker.polygonCount}
                </div>
                \${chronologyHtml}
            \`;
        }
        
        function updateSummaryStats(stats) {
            const container = document.getElementById('summaryStats');
            container.innerHTML = \`
                <div class="summary-card">
                    <div class="summary-number">\${stats.totalArea.toFixed(1)}</div>
                    <div class="summary-label">Gesamtfläche (ha)</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number">\${stats.completedArea.toFixed(1)}</div>
                    <div class="summary-label">Bearbeitete Fläche (ha)</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number">\${stats.completionAreaPercentage.toFixed(1)}%</div>
                    <div class="summary-label">Flächenanteil abgeschlossen</div>
                </div>
                <div class="summary-card">
                    <div class="summary-number">\${stats.completedPolygons}/\${stats.totalPolygons}</div>
                    <div class="summary-label">Polygone abgeschlossen</div>
                </div>
            \`;
        }
        
        function showDashboard() {
            document.getElementById('projectDetail').style.display = 'none';
            document.getElementById('dashboard').style.display = 'block';
            currentProject = null;
        }
        
        // Initial laden
        loadProjects();
        
        // Auto-refresh alle 30 Sekunden
        setInterval(() => {
            if (currentProject) {
                showProject(currentProject.projectName);
            } else {
                loadProjects();
            }
        }, 30000);
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
📋 API Projekte: /api/projects
🎯 API Projekt Details: /api/project/:projectName
  `);
  console.log(`Aktueller Status: ${serverStatus.status ? 'GRÜN' : 'ROT'}`);
});

module.exports = app;
