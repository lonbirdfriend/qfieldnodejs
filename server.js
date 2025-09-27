// server.js - Erweiterte Version mit professionellem Dark Theme Dashboard
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
      participantCount: 0,
      dailyStats: {},
      sunburstData: null
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
  let dailyStats = {};
  
  ['r', 'g', 'b', 'y'].forEach(colorCode => {
    if (info.colorWorkers && info.colorWorkers[colorCode]) {
      const workerName = info.colorWorkers[colorCode];
      const workerPolygons = data.filter(p => p.farbe === colorCode && p.bearbeitet && p.datum);
      const workerArea = workerPolygons.reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
      
      workerStats[colorCode] = {
        name: workerName,
        color: colorCode,
        area: workerArea,
        polygonCount: workerPolygons.length,
        percentage: totalArea > 0 ? (workerArea / totalArea * 100) : 0,
        chronology: workerPolygons
          .map(p => ({
            datum: p.datum,
            area: parseFloat(p.flaeche_ha) || 0,
            id: p.id
          }))
          .sort((a, b) => {
            const dateA = a.datum.split('.').reverse().join('-');
            const dateB = b.datum.split('.').reverse().join('-');
            return new Date(dateB) - new Date(dateA);
          })
      };

      // Tägliche Statistiken berechnen
      workerPolygons.forEach(p => {
        const date = p.datum;
        if (!dailyStats[date]) {
          dailyStats[date] = { total: 0, workers: {} };
        }
        if (!dailyStats[date].workers[workerName]) {
          dailyStats[date].workers[workerName] = { area: 0, color: colorCode };
        }
        dailyStats[date].total += parseFloat(p.flaeche_ha) || 0;
        dailyStats[date].workers[workerName].area += parseFloat(p.flaeche_ha) || 0;
      });
    }
  });

  // Sunburst-Daten erstellen
  const sunburstData = createSunburstData(workerStats, totalArea, completedArea);

  return {
    totalPolygons,
    completedPolygons,
    completionPercentage: totalPolygons > 0 ? (completedPolygons / totalPolygons * 100) : 0,
    totalArea,
    completedArea,
    completionAreaPercentage: totalArea > 0 ? (completedArea / totalArea * 100) : 0,
    workerStats,
    participantCount: Object.keys(workerStats).length,
    dailyStats,
    sunburstData
  };
}

function createSunburstData(workerStats, totalArea, completedArea) {
  const children = Object.values(workerStats).map(worker => ({
    name: worker.name,
    value: worker.area,
    color: worker.color,
    percentage: worker.percentage
  }));

  // Unbearbeitete Fläche hinzufügen
  const unprocessedArea = totalArea - completedArea;
  if (unprocessedArea > 0) {
    children.push({
      name: 'Unbearbeitet',
      value: unprocessedArea,
      color: 'gray',
      percentage: (unprocessedArea / totalArea) * 100
    });
  }

  return {
    name: 'Projekt',
    children: children,
    value: totalArea
  };
}

// API Routes (unverändert)
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
  
  // Sortiere nach letztem Update (neueste zuerst)
  projects.sort((a, b) => new Date(b.lastUpdate || 0) - new Date(a.lastUpdate || 0));
  
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

// Haupt-Dashboard Route mit Dark Theme
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QField Projekt Dashboard</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
    <style>
        :root {
            --bg-primary: #0f0f0f;
            --bg-secondary: #1a1a1a;
            --bg-tertiary: #2a2a2a;
            --text-primary: #ffffff;
            --text-secondary: #b0b0b0;
            --text-muted: #707070;
            --accent: #3b82f6;
            --accent-hover: #2563eb;
            --success: #10b981;
            --warning: #f59e0b;
            --error: #ef4444;
            --border: #333333;
            --shadow: rgba(0, 0, 0, 0.3);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        .header {
            text-align: center;
            margin-bottom: 3rem;
        }
        
        .header h1 {
            font-size: 2.5rem;
            font-weight: 300;
            margin-bottom: 0.5rem;
            background: linear-gradient(135deg, var(--accent), var(--success));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .header p {
            color: var(--text-secondary);
            font-size: 1.1rem;
        }
        
        /* Projekt-Grid für Dashboard */
        .project-grid {
            display: grid;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }
        
        .project-card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
            cursor: pointer;
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }
        
        .project-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px var(--shadow);
            border-color: var(--accent);
        }
        
        .project-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }
        
        .project-name {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .project-meta {
            font-size: 0.875rem;
            color: var(--text-muted);
        }
        
        .progress-section {
            margin-bottom: 1rem;
        }
        
        .progress-label {
            display: flex;
            justify-content: space-between;
            margin-bottom: 0.5rem;
            font-size: 0.875rem;
            color: var(--text-secondary);
        }
        
        .progress-container {
            background: var(--bg-tertiary);
            border-radius: 8px;
            height: 24px;
            overflow: hidden;
            position: relative;
        }
        
        .progress-bar {
            height: 100%;
            background: linear-gradient(90deg, var(--success), var(--accent));
            border-radius: 8px;
            transition: width 0.8s ease;
            position: relative;
        }
        
        .worker-colors {
            display: flex;
            height: 6px;
            border-radius: 3px;
            overflow: hidden;
            margin-top: 0.5rem;
        }
        
        .worker-segment {
            transition: all 0.3s ease;
        }
        
        .project-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1rem;
            margin-top: 1rem;
        }
        
        .stat-item {
            text-align: center;
            padding: 0.75rem;
            background: var(--bg-tertiary);
            border-radius: 8px;
        }
        
        .stat-number {
            font-size: 1.1rem;
            font-weight: 600;
            color: var(--text-primary);
        }
        
        .stat-label {
            font-size: 0.75rem;
            color: var(--text-muted);
            margin-top: 0.25rem;
        }
        
        /* Projekt Detail Ansicht */
        .project-detail {
            display: none;
        }
        
        .back-button {
            background: var(--bg-secondary);
            color: var(--text-primary);
            border: 1px solid var(--border);
            padding: 0.75rem 1.5rem;
            font-size: 0.875rem;
            border-radius: 8px;
            cursor: pointer;
            margin-bottom: 2rem;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .back-button:hover {
            background: var(--bg-tertiary);
            border-color: var(--accent);
        }
        
        .detail-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
            margin-bottom: 2rem;
        }
        
        .detail-section {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 1.5rem;
        }
        
        .section-title {
            font-size: 1.125rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: var(--text-primary);
        }
        
        .sunburst-container {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 400px;
        }
        
        .chronology-section {
            grid-column: 1 / -1;
        }
        
        .worker-tabs {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1.5rem;
            flex-wrap: wrap;
        }
        
        .worker-tab {
            padding: 0.5rem 1rem;
            border: 1px solid var(--border);
            border-radius: 6px;
            cursor: pointer;
            font-weight: 500;
            color: var(--text-secondary);
            background: var(--bg-tertiary);
            transition: all 0.3s ease;
            font-size: 0.875rem;
        }
        
        .worker-tab.active {
            background: var(--accent);
            border-color: var(--accent);
            color: white;
        }
        
        .timeline {
            position: relative;
        }
        
        .timeline-item {
            display: flex;
            align-items: center;
            margin-bottom: 1rem;
            padding: 1rem;
            background: var(--bg-tertiary);
            border-radius: 8px;
            border-left: 4px solid var(--accent);
        }
        
        .timeline-date {
            font-weight: 600;
            color: var(--accent);
            min-width: 100px;
        }
        
        .timeline-bar {
            flex: 1;
            margin: 0 1rem;
            height: 20px;
            background: var(--bg-primary);
            border-radius: 10px;
            overflow: hidden;
            position: relative;
        }
        
        .timeline-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--success), var(--accent));
            border-radius: 10px;
            transition: width 0.8s ease;
        }
        
        .timeline-value {
            position: absolute;
            right: 0.5rem;
            top: 50%;
            transform: translateY(-50%);
            font-size: 0.75rem;
            color: var(--text-primary);
            font-weight: 600;
        }
        
        .timeline-info {
            text-align: right;
            min-width: 80px;
            font-size: 0.875rem;
            color: var(--text-secondary);
        }
        
        /* Responsive Design */
        @media (max-width: 768px) {
            .container {
                padding: 1rem;
            }
            
            .detail-grid {
                grid-template-columns: 1fr;
            }
            
            .project-stats {
                grid-template-columns: 1fr;
            }
            
            .worker-tabs {
                justify-content: center;
            }
        }
        
        /* D3 Sunburst Styling */
        .sunburst-chart {
            font-family: inherit;
        }
        
        .sunburst-chart text {
            fill: var(--text-primary);
            font-size: 11px;
        }
        
        /* Utility Classes */
        .hidden {
            display: none !important;
        }
        
        .text-center {
            text-align: center;
        }
        
        .mt-2 { margin-top: 1rem; }
        .mb-2 { margin-bottom: 1rem; }
    </style>
</head>
<body>
    <div class="container">
        <!-- Dashboard Übersicht -->
        <div id="dashboard">
            <div class="header">
                <h1>Projektübersicht</h1>
                <p>Fortschritt und Status aller QField Projekte</p>
            </div>
            
            <div id="projectGrid" class="project-grid">
                <!-- Projekte werden hier dynamisch geladen -->
            </div>
        </div>
        
        <!-- Projekt Detail Ansicht -->
        <div id="projectDetail" class="project-detail">
            <button class="back-button" onclick="showDashboard()">
                ← Zurück zur Übersicht
            </button>
            
            <div class="header">
                <h1 id="projectTitle">Projekt Details</h1>
            </div>
            
            <div class="detail-grid">
                <div class="detail-section">
                    <h3 class="section-title">Projektübersicht</h3>
                    <div id="sunburstContainer" class="sunburst-container">
                        <!-- Sunburst Chart wird hier eingefügt -->
                    </div>
                </div>
                
                <div class="detail-section">
                    <h3 class="section-title">Statistiken</h3>
                    <div id="projectStats">
                        <!-- Projektstatistiken werden hier eingefügt -->
                    </div>
                </div>
            </div>
            
            <div class="detail-section chronology-section">
                <h3 class="section-title">Chronologische Übersicht</h3>
                
                <div id="workerTabs" class="worker-tabs">
                    <!-- Tabs werden hier eingefügt -->
                </div>
                
                <div id="timelineContainer" class="timeline">
                    <!-- Timeline wird hier angezeigt -->
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentProject = null;
        let currentWorker = 'all';
        
        const colorMap = {
            'r': '#ef4444',
            'g': '#10b981',
            'b': '#3b82f6',
            'y': '#f59e0b',
            'gray': '#6b7280'
        };
        
        function loadProjects() {
            fetch('/api/projects')
                .then(response => response.json())
                .then(data => {
                    const grid = document.getElementById('projectGrid');
                    
                    if (data.projects.length === 0) {
                        grid.innerHTML = '<div class="text-center" style="color: var(--text-muted); font-size: 1.2em;">Keine Projekte gefunden</div>';
                        return;
                    }
                    
                    grid.innerHTML = '';
                    
                    data.projects.forEach(project => {
                        const card = document.createElement('div');
                        card.className = 'project-card';
                        card.onclick = () => showProject(project.name);
                        
                        // Worker Farben für Balken
                        const workerSegments = Object.values(project.workerStats).map(worker => 
                            \`<div class="worker-segment" style="width: \${worker.percentage}%; background-color: \${colorMap[worker.color]};"></div>\`
                        ).join('');
                        
                        card.innerHTML = \`
                            <div class="project-header">
                                <div class="project-name">\${project.name}</div>
                                <div class="project-meta">
                                    \${new Date(project.lastUpdate).toLocaleDateString('de-DE')}
                                </div>
                            </div>
                            
                            <div class="progress-section">
                                <div class="progress-label">
                                    <span>Fortschritt</span>
                                    <span>\${project.completionAreaPercentage.toFixed(1)}%</span>
                                </div>
                                <div class="progress-container">
                                    <div class="progress-bar" style="width: \${project.completionAreaPercentage}%"></div>
                                </div>
                                <div class="worker-colors">
                                    \${workerSegments}
                                </div>
                            </div>
                            
                            <div class="project-stats">
                                <div class="stat-item">
                                    <div class="stat-number">\${project.totalArea.toFixed(1)}</div>
                                    <div class="stat-label">Gesamtfläche (ha)</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-number">\${project.completedArea.toFixed(1)}</div>
                                    <div class="stat-label">Bearbeitet (ha)</div>
                                </div>
                                <div class="stat-item">
                                    <div class="stat-number">\${project.participantCount}</div>
                                    <div class="stat-label">Beteiligte</div>
                                </div>
                            </div>
                        \`;
                        
                        grid.appendChild(card);
                    });
                })
                .catch(error => {
                    console.error('Fehler beim Laden der Projekte:', error);
                    document.getElementById('projectGrid').innerHTML = 
                        '<div class="text-center" style="color: var(--error); font-size: 1.2em;">Fehler beim Laden der Projekte</div>';
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
                    
                    // Sunburst Chart erstellen
                    createSunburstChart(data.statistics.sunburstData);
                    
                    // Projekt-Statistiken anzeigen
                    updateProjectStats(data.statistics);
                    
                    // Worker Tabs erstellen
                    createWorkerTabs(data.statistics.workerStats);
                    
                    // Timeline anzeigen
                    showTimeline('all', data.statistics);
                })
                .catch(error => {
                    console.error('Fehler beim Laden des Projekts:', error);
                });
        }
        
        function createSunburstChart(data) {
            const container = document.getElementById('sunburstContainer');
            container.innerHTML = '';
            
            if (!data || !data.children || data.children.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted);">Keine Daten für Sunburst verfügbar</div>';
                return;
            }
            
            const width = 400;
            const height = 400;
            const radius = Math.min(width, height) / 6;
            
            // Color scale anhand der Worker-Farben
            const color = d3.scaleOrdinal()
                .domain(data.children.map(d => d.name))
                .range(data.children.map(d => colorMap[d.color] || '#6b7280'));
            
            // Hierarchy erstellen
            const hierarchy = d3.hierarchy(data)
                .sum(d => d.value)
                .sort((a, b) => b.value - a.value);
            
            const root = d3.partition()
                .size([2 * Math.PI, hierarchy.height + 1])
                (hierarchy);
            
            root.each(d => d.current = d);
            
            // Arc generator
            const arc = d3.arc()
                .startAngle(d => d.x0)
                .endAngle(d => d.x1)
                .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
                .padRadius(radius * 1.5)
                .innerRadius(d => d.y0 * radius)
                .outerRadius(d => Math.max(d.y0 * radius, d.y1 * radius - 1));
            
            // SVG erstellen
            const svg = d3.select(container)
                .append('svg')
                .attr('class', 'sunburst-chart')
                .attr('viewBox', [-width / 2, -height / 2, width, width])
                .style('width', '100%')
                .style('height', '400px');
            
            // Arcs hinzufügen
            const path = svg.append('g')
                .selectAll('path')
                .data(root.descendants().slice(1))
                .join('path')
                .attr('fill', d => {
                    while (d.depth > 1) d = d.parent;
                    return color(d.data.name);
                })
                .attr('fill-opacity', d => arcVisible(d.current) ? (d.children ? 0.8 : 0.6) : 0)
                .attr('pointer-events', d => arcVisible(d.current) ? 'auto' : 'none')
                .attr('d', d => arc(d.current))
                .style('cursor', 'pointer')
                .on('click', clicked);
            
            // Tooltips
            path.append('title')
                .text(d => \`\${d.ancestors().map(d => d.data.name).reverse().join('/')}\n\${d.value.toFixed(2)} ha (\${((d.value / data.value) * 100).toFixed(1)}%)\`);
            
            // Labels
            const label = svg.append('g')
                .attr('pointer-events', 'none')
                .attr('text-anchor', 'middle')
                .style('user-select', 'none')
                .selectAll('text')
                .data(root.descendants().slice(1))
                .join('text')
                .attr('dy', '0.35em')
                .attr('fill-opacity', d => +labelVisible(d.current))
                .attr('transform', d => labelTransform(d.current))
                .text(d => d.data.name)
                .style('font-size', '10px')
                .style('fill', 'var(--text-primary)');
            
            // Center circle
            const parent = svg.append('circle')
                .datum(root)
                .attr('r', radius)
                .attr('fill', 'none')
                .attr('pointer-events', 'all')
                .style('cursor', 'pointer')
                .on('click', clicked);
            
            // Click handler für Zoom
            function clicked(event, p) {
                parent.datum(p.parent || root);
                
                root.each(d => d.target = {
                    x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
                    x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
                    y0: Math.max(0, d.y0 - p.depth),
                    y1: Math.max(0, d.y1 - p.depth)
                });
                
                const t = svg.transition().duration(750);
                
                path.transition(t)
                    .tween('data', d => {
                        const i = d3.interpolate(d.current, d.target);
                        return t => d.current = i(t);
                    })
                    .filter(function(d) {
                        return +this.getAttribute('fill-opacity') || arcVisible(d.target);
                    })
                    .attr('fill-opacity', d => arcVisible(d.target) ? (d.children ? 0.8 : 0.6) : 0)
                    .attr('pointer-events', d => arcVisible(d.target) ? 'auto' : 'none')
                    .attrTween('d', d => () => arc(d.current));
                
                label.filter(function(d) {
                    return +this.getAttribute('fill-opacity') || labelVisible(d.target);
                }).transition(t)
                    .attr('fill-opacity', d => +labelVisible(d.target))
                    .attrTween('transform', d => () => labelTransform(d.current));
            }
            
            function arcVisible(d) {
                return d.y1 <= 3 && d.y0 >= 1 && d.x1 > d.x0;
            }
            
            function labelVisible(d) {
                return d.y1 <= 3 && d.y0 >= 1 && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.03;
            }
            
            function labelTransform(d) {
                const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
                const y = (d.y0 + d.y1) / 2 * radius;
                return \`rotate(\${x - 90}) translate(\${y},0) rotate(\${x < 180 ? 0 : 180})\`;
            }
        }
        
        function updateProjectStats(stats) {
            const container = document.getElementById('projectStats');
            container.innerHTML = \`
                <div style="display: grid; gap: 1rem;">
                    <div class="stat-item">
                        <div class="stat-number">\${stats.totalArea.toFixed(1)} ha</div>
                        <div class="stat-label">Gesamtfläche</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">\${stats.completedArea.toFixed(1)} ha</div>
                        <div class="stat-label">Bearbeitet</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">\${stats.completionAreaPercentage.toFixed(1)}%</div>
                        <div class="stat-label">Fortschritt</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">\${stats.totalPolygons}</div>
                        <div class="stat-label">Polygone gesamt</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">\${stats.completedPolygons}</div>
                        <div class="stat-label">Polygone bearbeitet</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-number">\${stats.participantCount}</div>
                        <div class="stat-label">Beteiligte</div>
                    </div>
                </div>
            \`;
        }
        
        function createWorkerTabs(workerStats) {
            const container = document.getElementById('workerTabs');
            container.innerHTML = '';
            
            // "Alle" Tab
            const allTab = document.createElement('button');
            allTab.className = 'worker-tab active';
            allTab.textContent = 'Alle';
            allTab.onclick = () => {
                setActiveTab(allTab);
                showTimeline('all', currentProject.statistics);
            };
            container.appendChild(allTab);
            
            // Worker Tabs
            Object.values(workerStats).forEach(worker => {
                const tab = document.createElement('button');
                tab.className = 'worker-tab';
                tab.style.borderColor = colorMap[worker.color];
                tab.textContent = worker.name;
                tab.onclick = () => {
                    setActiveTab(tab);
                    showTimeline(worker, currentProject.statistics);
                };
                container.appendChild(tab);
            });
        }
        
        function setActiveTab(activeTab) {
            document.querySelectorAll('.worker-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            activeTab.classList.add('active');
        }
        
        function showTimeline(worker, stats) {
            const container = document.getElementById('timelineContainer');
            container.innerHTML = '';
            
            let timelineData = [];
            
            if (worker === 'all') {
                // Alle Daten nach Datum aggregieren
                Object.entries(stats.dailyStats).forEach(([date, dayData]) => {
                    timelineData.push({
                        date: date,
                        area: dayData.total,
                        workers: Object.entries(dayData.workers).map(([name, data]) => ({
                            name: name,
                            area: data.area,
                            color: data.color
                        }))
                    });
                });
            } else {
                // Spezifische Worker-Daten
                worker.chronology.forEach(entry => {
                    const existingEntry = timelineData.find(item => item.date === entry.datum);
                    if (existingEntry) {
                        existingEntry.area += entry.area;
                    } else {
                        timelineData.push({
                            date: entry.datum,
                            area: entry.area,
                            worker: worker.name,
                            color: worker.color
                        });
                    }
                });
            }
            
            // Sortiere nach Datum (neueste zuerst)
            timelineData.sort((a, b) => {
                const dateA = a.date.split('.').reverse().join('-');
                const dateB = b.date.split('.').reverse().join('-');
                return new Date(dateB) - new Date(dateA);
            });
            
            if (timelineData.length === 0) {
                container.innerHTML = '<div class="text-center" style="color: var(--text-muted); padding: 2rem;">Keine Daten für Timeline verfügbar</div>';
                return;
            }
            
            // Maximale Fläche für Skalierung finden
            const maxArea = Math.max(...timelineData.map(item => item.area));
            
            timelineData.forEach(item => {
                const timelineItem = document.createElement('div');
                timelineItem.className = 'timeline-item';
                
                const widthPercent = (item.area / maxArea) * 100;
                const color = worker === 'all' ? 'var(--accent)' : colorMap[item.color] || 'var(--accent)';
                
                let workerInfo = '';
                if (worker === 'all' && item.workers) {
                    workerInfo = item.workers.map(w => 
                        \`<span style="color: \${colorMap[w.color]};">\${w.name}: \${w.area.toFixed(2)} ha</span>\`
                    ).join(' • ');
                }
                
                timelineItem.innerHTML = \`
                    <div class="timeline-date">\${item.date}</div>
                    <div class="timeline-bar">
                        <div class="timeline-fill" style="width: \${widthPercent}%; background: \${color};"></div>
                        <div class="timeline-value">\${item.area.toFixed(2)} ha</div>
                    </div>
                    <div class="timeline-info">
                        \${workerInfo || (worker !== 'all' ? worker.name : '')}
                    </div>
                \`;
                
                container.appendChild(timelineItem);
            });
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
