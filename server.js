// server.js - Komplett neu geschriebenes Dashboard
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

// Polygon data storage
let polygonDatabase = {
  projects: {},
  lastSync: null
};

// Hilfsfunktionen
function getColorHex(colorCode) {
  const colors = {
    'r': '#f44336',
    'g': '#4CAF50',
    'b': '#2196F3',
    'y': '#FFEB3B'
  };
  return colors[colorCode] || '#e0e0e0';
}

function getColorName(colorCode) {
  const names = {
    'r': 'Rot',
    'g': 'Grün',
    'b': 'Blau',
    'y': 'Gelb'
  };
  return names[colorCode] || 'Unbekannt';
}

function parseDateString(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    return new Date(parts[2], parts[1] - 1, parts[0]);
  }
  return null;
}

function calculateProjectStats(projectData) {
  const data = projectData.data || [];
  const info = projectData.info || {};
  
  const totalArea = data.reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
  const completedPolygons = data.filter(p => p.bearbeitet && p.datum && p.farbe);
  const completedArea = completedPolygons.reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
  
  const workerStats = {};
  
  // Für jede definierte Farbe
  ['r', 'g', 'b', 'y'].forEach(color => {
    if (info.colorWorkers && info.colorWorkers[color]) {
      const workerName = info.colorWorkers[color];
      const workerPolygons = data.filter(p => p.farbe === color && p.bearbeitet && p.datum);
      const workerArea = workerPolygons.reduce((sum, p) => sum + (parseFloat(p.flaeche_ha) || 0), 0);
      
      const targetPercentage = (info.workerPercentages && info.workerPercentages[color]) || 0;
      const targetArea = totalArea * (targetPercentage / 100);
      const achievedPercentage = targetArea > 0 ? Math.min((workerArea / targetArea) * 100, 100) : 0;
      
      // Chronologie nach Datum gruppieren
      const dateGroups = {};
      workerPolygons.forEach(polygon => {
        const date = polygon.datum;
        if (!dateGroups[date]) {
          dateGroups[date] = {
            date: date,
            totalArea: 0,
            polygons: [],
            count: 0
          };
        }
        dateGroups[date].totalArea += parseFloat(polygon.flaeche_ha) || 0;
        dateGroups[date].polygons.push(polygon.id);
        dateGroups[date].count++;
      });
      
      // In Array umwandeln und sortieren
      const chronology = Object.values(dateGroups).sort((a, b) => {
        const dateA = parseDateString(a.date);
        const dateB = parseDateString(b.date);
        return dateB - dateA; // Neueste zuerst
      });
      
      // Tagesrate für Bereiche berechnen
      chronology.forEach(entry => {
        if (entry.date.includes(' bis ')) {
          const [start, end] = entry.date.split(' bis ');
          const startDate = parseDateString(start);
          const endDate = parseDateString(end);
          if (startDate && endDate) {
            const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
            entry.dailyRate = entry.totalArea / days;
            entry.days = days;
          }
        }
      });
      
      workerStats[color] = {
        name: workerName,
        color: color,
        area: workerArea,
        polygonCount: workerPolygons.length,
        percentage: totalArea > 0 ? (workerArea / totalArea) * 100 : 0,
        targetPercentage: targetPercentage,
        targetArea: targetArea,
        achievedPercentage: achievedPercentage,
        chronology: chronology
      };
    }
  });
  
  return {
    totalPolygons: data.length,
    completedPolygons: completedPolygons.length,
    completionPercentage: data.length > 0 ? (completedPolygons.length / data.length) * 100 : 0,
    totalArea: totalArea,
    completedArea: completedArea,
    completionAreaPercentage: totalArea > 0 ? (completedArea / totalArea) * 100 : 0,
    workerStats: workerStats,
    participantCount: Object.keys(workerStats).length
  };
}

// API Routes
app.get('/api/status', (req, res) => {
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
  
  res.json({
    success: true,
    status: serverStatus.status,
    message: `Status auf ${status ? 'GRÜN' : 'ROT'} gesetzt`
  });
});

app.post('/api/sync', (req, res) => {
  const { action, layerName, data, timestamp, source, projectInfo } = req.body;
  
  if (!layerName || !data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'LayerName and data array required' });
  }
  
  try {
    const projectName = projectInfo?.projectName || layerName;
    
    if (!polygonDatabase.projects[projectName]) {
      polygonDatabase.projects[projectName] = { data: [], info: {} };
    }
    
    if (projectInfo) {
      polygonDatabase.projects[projectName].info = projectInfo;
    }
    
    let existingData = polygonDatabase.projects[projectName].data;
    let existingMap = {};
    existingData.forEach(item => {
      if (item.id) existingMap[item.id] = item;
    });
    
    let mergedData = [];
    let newCount = 0;
    let updatedCount = 0;
    
    data.forEach(incomingPolygon => {
      if (!incomingPolygon.id) return;
      
      let existing = existingMap[incomingPolygon.id];
      if (existing) {
        let merged = {
          id: incomingPolygon.id,
          flaeche_ha: incomingPolygon.flaeche_ha || existing.flaeche_ha || 0,
          bearbeitet: incomingPolygon.bearbeitet || existing.bearbeitet || "",
          datum: incomingPolygon.datum || existing.datum || "",
          farbe: incomingPolygon.farbe || existing.farbe || "",
          geometry: incomingPolygon.geometry || existing.geometry || "",
          lastUpdate: timestamp || new Date().toISOString()
        };
        
        if (JSON.stringify(merged) !== JSON.stringify(existing)) {
          updatedCount++;
        }
        mergedData.push(merged);
      } else {
        mergedData.push({
          id: incomingPolygon.id,
          flaeche_ha: incomingPolygon.flaeche_ha || 0,
          bearbeitet: incomingPolygon.bearbeitet || "",
          datum: incomingPolygon.datum || "",
          farbe: incomingPolygon.farbe || "",
          geometry: incomingPolygon.geometry || "",
          lastUpdate: timestamp || new Date().toISOString()
        });
        newCount++;
      }
    });
    
    existingData.forEach(existing => {
      if (!data.find(incoming => incoming.id === existing.id)) {
        mergedData.push(existing);
      }
    });
    
    polygonDatabase.projects[projectName].data = mergedData;
    polygonDatabase.lastSync = new Date().toISOString();
    
    res.json({
      success: true,
      message: 'Synchronisation erfolgreich',
      statistics: {
        totalPolygons: mergedData.length,
        newPolygons: newCount,
        updatedPolygons: updatedCount
      },
      serverData: mergedData
    });
    
  } catch (error) {
    console.error('Sync Error:', error);
    res.status(500).json({ error: 'Synchronisation fehlgeschlagen: ' + error.message });
  }
});

app.get('/api/projects', (req, res) => {
  const projects = Object.keys(polygonDatabase.projects).map(projectName => {
    const projectData = polygonDatabase.projects[projectName];
    const stats = calculateProjectStats(projectData);
    
    return {
      name: projectName,
      ...stats
    };
  });
  
  res.json({
    projects: projects,
    totalProjects: projects.length
  });
});

app.get('/api/project/:projectName', (req, res) => {
  const { projectName } = req.params;
  
  if (!polygonDatabase.projects[projectName]) {
    return res.status(404).json({ error: 'Projekt nicht gefunden' });
  }
  
  const projectData = polygonDatabase.projects[projectName];
  const stats = calculateProjectStats(projectData);
  
  res.json({
    projectName: projectName,
    info: projectData.info,
    data: projectData.data,
    statistics: stats
  });
});

// Legacy Endpoints
app.get('/api/data/:layerName', (req, res) => {
  const { layerName } = req.params;
  if (!polygonDatabase.projects[layerName]) {
    return res.status(404).json({ error: 'Layer nicht gefunden' });
  }
  
  res.json({
    layerName: layerName,
    data: polygonDatabase.projects[layerName].data,
    count: polygonDatabase.projects[layerName].data.length
  });
});

app.get('/api/layers', (req, res) => {
  const layers = Object.keys(polygonDatabase.projects).map(projectName => ({
    name: projectName,
    polygonCount: polygonDatabase.projects[projectName].data.length
  }));
  
  res.json({
    layers: layers,
    totalLayers: layers.length
  });
});

// Haupt-Dashboard
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
            max-width: 1200px;
            margin: 0 auto;
        }
        
        .header {
            background: white;
            border-radius: 15px;
            padding: 30px;
            text-align: center;
            margin-bottom: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        
        .header h1 {
            color: #333;
            margin-bottom: 10px;
        }
        
        .projects-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(350px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .project-card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            cursor: pointer;
            transition: transform 0.3s ease;
        }
        
        .project-card:hover {
            transform: translateY(-5px);
        }
        
        .project-name {
            font-size: 1.3em;
            font-weight: bold;
            color: #333;
            margin-bottom: 15px;
        }
        
        .progress-bar {
            background: #f0f0f0;
            border-radius: 10px;
            height: 25px;
            margin-bottom: 15px;
            overflow: hidden;
            position: relative;
        }
        
        .progress-fill {
            height: 100%;
            background: linear-gradient(45deg, #4CAF50, #45a049);
            border-radius: 10px;
            transition: width 0.8s ease;
        }
        
        .progress-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-weight: bold;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .project-stats {
            display: flex;
            justify-content: space-between;
            font-size: 0.9em;
            color: #666;
        }
        
        .stat-value {
            font-weight: bold;
            color: #333;
        }
        
        .back-button {
            background: #2196F3;
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 25px;
            cursor: pointer;
            margin-bottom: 20px;
            font-size: 1em;
        }
        
        .back-button:hover {
            background: #1976D2;
        }
        
        .project-detail {
            display: none;
            background: white;
            border-radius: 15px;
            padding: 30px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        
        .project-title {
            font-size: 2em;
            color: #333;
            margin-bottom: 20px;
        }
        
        .overall-progress {
            margin-bottom: 30px;
        }
        
        .worker-progress-bar {
            display: flex;
            height: 40px;
            border-radius: 20px;
            overflow: hidden;
            margin: 15px 0;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        
        .worker-segment {
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
            transition: all 0.3s ease;
        }
        
        .worker-tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        
        .worker-tab {
            padding: 12px 24px;
            border: none;
            border-radius: 25px;
            cursor: pointer;
            font-weight: bold;
            color: white;
            transition: all 0.3s ease;
            opacity: 0.8;
        }
        
        .worker-tab.active {
            opacity: 1;
            transform: scale(1.05);
        }
        
        .worker-detail {
            background: #f9f9f9;
            border-radius: 15px;
            padding: 25px;
            margin-bottom: 20px;
        }
        
        .progress-section {
            margin: 20px 0;
        }
        
        .achievement-bar {
            background: #e0e0e0;
            border-radius: 10px;
            height: 25px;
            overflow: hidden;
            position: relative;
            margin: 10px 0;
        }
        
        .achievement-fill {
            height: 100%;
            border-radius: 10px;
            transition: width 0.8s ease;
        }
        
        .achievement-text {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-weight: bold;
            font-size: 0.9em;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        
        .stat-card {
            background: white;
            border-radius: 10px;
            padding: 20px;
            text-align: center;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        
        .stat-number {
            font-size: 1.8em;
            font-weight: bold;
            color: #2196F3;
        }
        
        .stat-label {
            color: #666;
            margin-top: 5px;
        }
        
        .chronology-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
            background: white;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        
        .chronology-table th,
        .chronology-table td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #eee;
        }
        
        .chronology-table th {
            background: #f5f5f5;
            font-weight: bold;
            color: #333;
        }
        
        .chronology-table tr:hover {
            background: #f9f9f9;
        }
        
        .no-data {
            text-align: center;
            color: #666;
            padding: 40px;
            font-style: italic;
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
                <h1>QField Projekt Dashboard</h1>
                <p>Übersicht aller Projekte und deren Fortschritt</p>
            </div>
            
            <div id="projectsGrid" class="projects-grid">
                <!-- Projekte werden hier geladen -->
            </div>
        </div>
        
        <!-- Projekt Detail -->
        <div id="projectDetail" class="project-detail">
            <button class="back-button" onclick="showDashboard()">← Zurück zur Übersicht</button>
            
            <h2 id="projectTitle" class="project-title">Projekt Details</h2>
            
            <div class="overall-progress">
                <h3>Gesamtfortschritt nach Bearbeitern</h3>
                <div id="workerProgressBar" class="worker-progress-bar">
                    <!-- Worker Segmente -->
                </div>
            </div>
            
            <div id="workerTabs" class="worker-tabs">
                <!-- Worker Tabs -->
            </div>
            
            <div id="workerDetail" class="worker-detail">
                <!-- Worker Details -->
            </div>
            
            <div id="projectStats" class="stats-grid">
                <!-- Projekt Statistiken -->
            </div>
        </div>
    </div>

    <script>
        let currentProject = null;
        
        const colorMap = {
            'r': '#f44336',
            'g': '#4CAF50', 
            'b': '#2196F3',
            'y': '#FFEB3B'
        };
        
        function loadProjects() {
            fetch('/api/projects')
                .then(response => response.json())
                .then(data => {
                    const grid = document.getElementById('projectsGrid');
                    
                    if (!data.projects || data.projects.length === 0) {
                        grid.innerHTML = '<div class="no-data">Keine Projekte gefunden</div>';
                        return;
                    }
                    
                    grid.innerHTML = '';
                    
                    data.projects.forEach(project => {
                        const card = document.createElement('div');
                        card.className = 'project-card';
                        card.onclick = () => showProject(project.name);
                        
                        card.innerHTML = \`
                            <div class="project-name">\${project.name}</div>
                            <div class="progress-bar">
                                <div class="progress-fill" style="width: \${project.completionPercentage.toFixed(1)}%"></div>
                                <div class="progress-text">\${project.completionPercentage.toFixed(1)}%</div>
                            </div>
                            <div class="project-stats">
                                <div>Polygone: <span class="stat-value">\${project.completedPolygons}/\${project.totalPolygons}</span></div>
                                <div>Fläche: <span class="stat-value">\${project.completedArea.toFixed(1)} ha</span></div>
                                <div>Beteiligte: <span class="stat-value">\${project.participantCount}</span></div>
                            </div>
                        \`;
                        
                        grid.appendChild(card);
                    });
                })
                .catch(error => {
                    console.error('Fehler beim Laden der Projekte:', error);
                    document.getElementById('projectsGrid').innerHTML = '<div class="no-data">Fehler beim Laden</div>';
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
                    
                    // Worker Progress Bar
                    const progressBar = document.getElementById('workerProgressBar');
                    progressBar.innerHTML = '';
                    
                    Object.values(data.statistics.workerStats).forEach(worker => {
                        if (worker.percentage > 0) {
                            const segment = document.createElement('div');
                            segment.className = 'worker-segment';
                            segment.style.backgroundColor = colorMap[worker.color];
                            segment.style.width = \`\${worker.percentage}%\`;
                            segment.textContent = worker.percentage > 8 ? \`\${worker.name} \${worker.percentage.toFixed(1)}%\` : '';
                            progressBar.appendChild(segment);
                        }
                    });
                    
                    // Worker Tabs
                    const tabsContainer = document.getElementById('workerTabs');
                    tabsContainer.innerHTML = '';
                    
                    Object.values(data.statistics.workerStats).forEach((worker, index) => {
                        const tab = document.createElement('button');
                        tab.className = 'worker-tab' + (index === 0 ? ' active' : '');
                        tab.style.backgroundColor = colorMap[worker.color];
                        tab.textContent = worker.name;
                        tab.onclick = () => showWorkerDetail(worker, tab);
                        tabsContainer.appendChild(tab);
                    });
                    
                    // Ersten Worker anzeigen
                    const workers = Object.values(data.statistics.workerStats);
                    if (workers.length > 0) {
                        showWorkerDetail(workers[0], tabsContainer.firstChild);
                    }
                    
                    // Projekt-Statistiken
                    updateProjectStats(data.statistics);
                })
                .catch(error => {
                    console.error('Fehler beim Laden des Projekts:', error);
                });
        }
        
        function showWorkerDetail(worker, tabElement) {
            // Tab aktivieren
            document.querySelectorAll('.worker-tab').forEach(tab => tab.classList.remove('active'));
            tabElement.classList.add('active');
            
            const detailContainer = document.getElementById('workerDetail');
            
            // Fortschrittsbalken
            const progressHtml = \`
                <div class="progress-section">
                    <h4>Fortschritt gegenüber Soll-Anteil</h4>
                    <div class="achievement-bar">
                        <div class="achievement-fill" style="background: \${colorMap[worker.color]}; width: \${worker.achievedPercentage}%"></div>
                        <div class="achievement-text">\${worker.achievedPercentage.toFixed(1)}%</div>
                    </div>
                    <div style="font-size: 0.9em; color: #666;">
                        Soll: \${worker.targetArea.toFixed(2)} ha (\${worker.targetPercentage}%) | 
                        Ist: \${worker.area.toFixed(2)} ha (\${worker.percentage.toFixed(1)}%)
                    </div>
                </div>
            \`;
            
            // Chronologie Tabelle
            let chronologyHtml = '';
            if (worker.chronology && worker.chronology.length > 0) {
                chronologyHtml = \`
                    <h4>Chronologie (neueste zuerst)</h4>
                    <table class="chronology-table">
                        <thead>
                            <tr>
                                <th>Datum/Zeitraum</th>
                                <th>Fläche (ha)</th>
                                <th>Polygone</th>
                                <th>Tagesrate</th>
                            </tr>
                        </thead>
                        <tbody>
                            \${worker.chronology.map(entry => \`
                                <tr>
                                    <td>\${entry.date}</td>
                                    <td>\${entry.totalArea.toFixed(2)}</td>
                                    <td>\${entry.count} (IDs: \${entry.polygons.join(', ')})</td>
                                    <td>\${entry.dailyRate ? 
                                        \`\${entry.dailyRate.toFixed(2)} ha/Tag (\${entry.days} Tage)\` : 
                                        'Einzeltag'
                                    }</td>
                                </tr>
                            \`).join('')}
                        </tbody>
                    </table>
                \`;
            } else {
                chronologyHtml = '<div class="no-data">Keine Bearbeitungen von diesem Bearbeiter</div>';
            }
            
            detailContainer.innerHTML = \`
                <h3 style="color: \${colorMap[worker.color]};">\${worker.name}</h3>
                \${progressHtml}
                <div style="margin: 20px 0;">
                    <strong>Gesamtfläche:</strong> \${worker.area.toFixed(2)} ha (\${worker.percentage.toFixed(1)}% des Projekts)<br>
                    <strong>Anzahl Polygone:</strong> \${worker.polygonCount}<br>
                    <strong>Soll-Anteil:</strong> \${worker.targetPercentage}% (\${worker.targetArea.toFixed(2)} ha)
                </div>
                \${chronologyHtml}
            \`;
        }
        
        function updateProjectStats(stats) {
            const container = document.getElementById('projectStats');
            container.innerHTML = \`
                <div class="stat-card">
                    <div class="stat-number">\${stats.totalArea.toFixed(1)}</div>
                    <div class="stat-label">Gesamtfläche (ha)</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">\${stats.completedArea.toFixed(1)}</div>
                    <div class="stat-label">Bearbeitete Fläche (ha)</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">\${stats.completionAreaPercentage.toFixed(1)}%</div>
                    <div class="stat-label">Flächenanteil abgeschlossen</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">\${stats.completedPolygons}/\${stats.totalPolygons}</div>
                    <div class="stat-label">Polygone abgeschlossen</div>
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
📊 Webinterface: ${process.env.NODE_ENV === 'production' ? 'https://qfieldnodjs.onrender.com' : `http://localhost:${PORT}`}
🔗 API Status: /api/status
🔄 API Sync: /api/sync
📋 API Projekte: /api/projects
🎯 API Projekt Details: /api/project/:projectName
  `);
  console.log(`Aktueller Status: ${serverStatus.status ? 'GRÜN' : 'ROT'}`);
});

module.exports = app;
