// server.js - Erweiterte Version mit D3.js Dashboard
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

// Hilfsfunktionen für erweiterte Datenaufbereitung
function parseDateString(dateStr) {
  if (!dateStr) return null;
  
  // Handle date ranges (e.g., "01.01.2025 bis 15.01.2025")
  if (dateStr.includes(' bis ')) {
    const [start, end] = dateStr.split(' bis ').map(d => d.trim());
    return {
      type: 'range',
      start: parseSimpleDate(start),
      end: parseSimpleDate(end),
      display: dateStr
    };
  }
  
  // Handle single dates
  return {
    type: 'single',
    date: parseSimpleDate(dateStr),
    display: dateStr
  };
}

function parseSimpleDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('.');
  if (parts.length === 3) {
    return new Date(parts[2], parts[1] - 1, parts[0]); // DD.MM.YYYY -> Date
  }
  return null;
}

function aggregateDataByDate(projectData) {
  const dailyData = {};
  
  if (!projectData || !projectData.data) return [];
  
  projectData.data.forEach(polygon => {
    if (!polygon.datum || !polygon.bearbeitet || !polygon.farbe) return;
    
    const dateInfo = parseDateString(polygon.datum);
    if (!dateInfo) return;
    
    const area = parseFloat(polygon.flaeche_ha) || 0;
    const workerColor = polygon.farbe;
    const workerName = projectData.info?.colorWorkers?.[workerColor] || `Worker ${workerColor}`;
    
    if (dateInfo.type === 'single' && dateInfo.date) {
      const dateKey = dateInfo.date.toISOString().split('T')[0];
      if (!dailyData[dateKey]) {
        dailyData[dateKey] = {
          date: dateInfo.date,
          dateStr: dateInfo.display,
          totalArea: 0,
          workers: {}
        };
      }
      
      dailyData[dateKey].totalArea += area;
      if (!dailyData[dateKey].workers[workerColor]) {
        dailyData[dateKey].workers[workerColor] = {
          name: workerName,
          color: workerColor,
          area: 0
        };
      }
      dailyData[dateKey].workers[workerColor].area += area;
      
    } else if (dateInfo.type === 'range' && dateInfo.start && dateInfo.end) {
      // Für Datumsbereiche: Fläche gleichmäßig auf alle Tage verteilen
      const daysDiff = Math.ceil((dateInfo.end - dateInfo.start) / (1000 * 60 * 60 * 24)) + 1;
      const areaPerDay = area / daysDiff;
      
      for (let d = new Date(dateInfo.start); d <= dateInfo.end; d.setDate(d.getDate() + 1)) {
        const dateKey = d.toISOString().split('T')[0];
        if (!dailyData[dateKey]) {
          dailyData[dateKey] = {
            date: new Date(d),
            dateStr: d.toLocaleDateString('de-DE'),
            totalArea: 0,
            workers: {}
          };
        }
        
        dailyData[dateKey].totalArea += areaPerDay;
        if (!dailyData[dateKey].workers[workerColor]) {
          dailyData[dateKey].workers[workerColor] = {
            name: workerName,
            color: workerColor,
            area: 0
          };
        }
        dailyData[dateKey].workers[workerColor].area += areaPerDay;
      }
    }
  });
  
  return Object.values(dailyData).sort((a, b) => a.date - b.date);
}

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
      dailyData: []
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
      
      workerStats[colorCode] = {
        name: workerName,
        color: colorCode,
        area: workerArea,
        polygonCount: workerPolygons.length,
        percentage: totalArea > 0 ? (workerArea / totalArea * 100) : 0,
        targetPercentage: info.workerPercentages ? info.workerPercentages[colorCode] || 0 : 0
      };
    }
  });

  // Tägliche Daten aggregieren
  const dailyData = aggregateDataByDate(projectData);

  return {
    totalPolygons,
    completedPolygons,
    completionPercentage: totalPolygons > 0 ? (completedPolygons / totalPolygons * 100) : 0,
    totalArea,
    completedArea,
    completionAreaPercentage: totalArea > 0 ? (completedArea / totalArea * 100) : 0,
    workerStats,
    participantCount: Object.keys(workerStats).length,
    dailyData
  };
}

// Existing API routes...
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
      polygonDatabase.projects[projectName] = {
        data: [],
        info: projectInfo || {}
      };
    }
    
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
    
    let existingMap = {};
    existingData.forEach(item => {
      if (item.id) existingMap[item.id] = item;
    });
    
    data.forEach(incomingPolygon => {
      if (!incomingPolygon.id) return;
      
      let existingPolygon = existingMap[incomingPolygon.id];
      
      if (existingPolygon) {
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
        
        if (JSON.stringify(merged) !== JSON.stringify(existingPolygon)) {
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
          lastUpdate: timestamp || new Date().toISOString(),
          source: source || 'unknown'
        });
        newCount++;
      }
    });
    
    existingData.forEach(existing => {
      let found = data.find(incoming => incoming.id === existing.id);
      if (!found) {
        mergedData.push(existing);
      }
    });
    
    polygonDatabase.projects[projectName].data = mergedData;
    polygonDatabase.lastSync = new Date().toISOString();
    
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

// D3.js Dashboard Route
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QField Analytics Dashboard</title>
    <script src="https://d3js.org/d3.v7.min.js"></script>
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
            color: #333;
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
        
        .project-selector {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            margin-bottom: 30px;
        }
        
        .project-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
        }
        
        .project-card {
            background: #f8f9fa;
            border-radius: 10px;
            padding: 15px;
            cursor: pointer;
            transition: all 0.3s ease;
            border: 2px solid transparent;
        }
        
        .project-card:hover {
            border-color: #667eea;
            transform: translateY(-2px);
        }
        
        .project-card.active {
            border-color: #667eea;
            background: #e3f2fd;
        }
        
        .charts-container {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 30px;
            margin-bottom: 30px;
        }
        
        .chart-panel {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
        }
        
        .chart-title {
            font-size: 1.2em;
            font-weight: bold;
            margin-bottom: 20px;
            color: #333;
            text-align: center;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
        }
        
        .stat-card {
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.1);
            text-align: center;
        }
        
        .stat-number {
            font-size: 2.5em;
            font-weight: bold;
            color: #667eea;
            margin-bottom: 10px;
        }
        
        .stat-label {
            color: #666;
            font-size: 1.1em;
        }
        
        .worker-legend {
            display: flex;
            justify-content: center;
            gap: 20px;
            margin-top: 15px;
        }
        
        .legend-item {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .legend-color {
            width: 20px;
            height: 20px;
            border-radius: 3px;
        }
        
        .tooltip {
            position: absolute;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-size: 12px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.3s;
        }
        
        @media (max-width: 768px) {
            .charts-container {
                grid-template-columns: 1fr;
            }
            
            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 QField Analytics Dashboard</h1>
            <p>Fortschrittsanalyse und Statistiken</p>
        </div>
        
        <div class="project-selector">
            <h2>Projekte</h2>
            <div id="projectGrid" class="project-grid">
                <!-- Projekte werden hier geladen -->
            </div>
        </div>
        
        <div id="dashboardContent" style="display: none;">
            <div class="charts-container">
                <div class="chart-panel">
                    <div class="chart-title">Täglicher Fortschritt (Hektar)</div>
                    <div id="timelineChart"></div>
                </div>
                
                <div class="chart-panel">
                    <div class="chart-title">Bearbeiter-Leistung vs. Soll</div>
                    <div id="workerChart"></div>
                </div>
            </div>
            
            <div class="stats-grid" id="statsGrid">
                <!-- Statistiken werden hier geladen -->
            </div>
        </div>
    </div>
    
    <div class="tooltip" id="tooltip"></div>

    <script>
        let currentProject = null;
        let currentData = null;
        
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
                    const grid = document.getElementById('projectGrid');
                    
                    if (data.projects.length === 0) {
                        grid.innerHTML = '<div style="text-align: center; color: #666;">Keine Projekte gefunden</div>';
                        return;
                    }
                    
                    grid.innerHTML = '';
                    
                    data.projects.forEach(project => {
                        const card = document.createElement('div');
                        card.className = 'project-card';
                        card.onclick = () => selectProject(project.name, card);
                        
                        card.innerHTML = \`
                            <div style="font-weight: bold; margin-bottom: 10px;">\${project.name}</div>
                            <div style="color: #666; font-size: 0.9em;">
                                \${project.completedArea.toFixed(1)} / \${project.totalArea.toFixed(1)} ha
                                (\${project.completionAreaPercentage.toFixed(1)}%)
                            </div>
                        \`;
                        
                        grid.appendChild(card);
                    });
                })
                .catch(error => console.error('Fehler beim Laden der Projekte:', error));
        }
        
        function selectProject(projectName, cardElement) {
            // Update active card
            document.querySelectorAll('.project-card').forEach(card => card.classList.remove('active'));
            cardElement.classList.add('active');
            
            fetch(\`/api/project/\${projectName}\`)
                .then(response => response.json())
                .then(data => {
                    currentProject = projectName;
                    currentData = data;
                    
                    document.getElementById('dashboardContent').style.display = 'block';
                    
                    createTimelineChart(data.statistics.dailyData);
                    createWorkerChart(data.statistics.workerStats);
                    createStatsGrid(data.statistics);
                })
                .catch(error => console.error('Fehler beim Laden des Projekts:', error));
        }
        
        function createTimelineChart(dailyData) {
            const container = document.getElementById('timelineChart');
            container.innerHTML = '';
            
            if (!dailyData || dailyData.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: #666; padding: 40px;">Keine Daten verfügbar</div>';
                return;
            }
            
            const margin = {top: 20, right: 30, bottom: 70, left: 60};
            const width = container.offsetWidth - margin.left - margin.right;
            const height = 300 - margin.top - margin.bottom;
            
            const svg = d3.select(container)
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom);
            
            const g = svg.append('g')
                .attr('transform', \`translate(\${margin.left},\${margin.top})\`);
            
            // Scales
            const x = d3.scaleBand()
                .domain(dailyData.map(d => d.dateStr))
                .range([0, width])
                .padding(0.2);
            
            const y = d3.scaleLinear()
                .domain([0, d3.max(dailyData, d => d.totalArea)])
                .range([height, 0]);
            
            // Axes
            g.append('g')
                .attr('transform', \`translate(0,\${height})\`)
                .call(d3.axisBottom(x))
                .selectAll('text')
                .style('text-anchor', 'end')
                .attr('dx', '-.8em')
                .attr('dy', '.15em')
                .attr('transform', 'rotate(-45)');
            
            g.append('g')
                .call(d3.axisLeft(y));
            
            // Y-axis label
            g.append('text')
                .attr('transform', 'rotate(-90)')
                .attr('y', 0 - margin.left)
                .attr('x', 0 - (height / 2))
                .attr('dy', '1em')
                .style('text-anchor', 'middle')
                .text('Hektar');
            
            // Bars
            const tooltip = d3.select('#tooltip');
            
            g.selectAll('.bar')
                .data(dailyData)
                .enter().append('rect')
                .attr('class', 'bar')
                .attr('x', d => x(d.dateStr))
                .attr('width', x.bandwidth())
                .attr('y', d => y(d.totalArea))
                .attr('height', d => height - y(d.totalArea))
                .attr('fill', '#667eea')
                .on('mouseover', function(event, d) {
                    tooltip.style('opacity', 1)
                        .html(\`
                            <strong>\${d.dateStr}</strong><br>
                            Gesamt: \${d.totalArea.toFixed(2)} ha<br>
                            \${Object.values(d.workers).map(w => 
                                \`\${w.name}: \${w.area.toFixed(2)} ha\`
                            ).join('<br>')}
                        \`)
                        .style('left', (event.pageX + 10) + 'px')
                        .style('top', (event.pageY - 10) + 'px');
                })
                .on('mouseout', function() {
                    tooltip.style('opacity', 0);
                });
        }
        
        function createWorkerChart(workerStats) {
            const container = document.getElementById('workerChart');
            container.innerHTML = '';
            
            const workers = Object.values(workerStats);
            if (workers.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: #666; padding: 40px;">Keine Bearbeiterdaten verfügbar</div>';
                return;
            }
            
            const margin = {top: 20, right: 30, bottom: 50, left: 60};
            const width = container.offsetWidth - margin.left - margin.right;
            const height = 300 - margin.top - margin.bottom;
            
            const svg = d3.select(container)
                .append('svg')
                .attr('width', width + margin.left + margin.right)
                .attr('height', height + margin.top + margin.bottom);
            
            const g = svg.append('g')
                .attr('transform', \`translate(\${margin.left},\${margin.top})\`);
            
            // Scales
            const x = d3.scaleBand()
                .domain(workers.map(d => d.name))
                .range([0, width])
                .padding(0.3);
            
            const y = d3.scaleLinear()
                .domain([0, Math.max(
                    d3.max(workers, d => d.percentage),
                    d3.max(workers, d => d.targetPercentage)
                )])
                .range([height, 0]);
            
            // Axes
            g.append('g')
                .attr('transform', \`translate(0,\${height})\`)
                .call(d3.axisBottom(x));
            
            g.append('g')
                .call(d3.axisLeft(y));
            
            // Y-axis label
            g.append('text')
                .attr('transform', 'rotate(-90)')
                .attr('y', 0 - margin.left)
                .attr('x', 0 - (height / 2))
                .attr('dy', '1em')
                .style('text-anchor', 'middle')
                .text('Prozent');
            
            const tooltip = d3.select('#tooltip');
            
            // Target bars (background)
            g.selectAll('.target-bar')
                .data(workers)
                .enter().append('rect')
                .attr('class', 'target-bar')
                .attr('x', d => x(d.name))
                .attr('width', x.bandwidth())
                .attr('y', d => y(d.targetPercentage))
                .attr('height', d => height - y(d.targetPercentage))
                .attr('fill', d => colorMap[d.color])
                .attr('opacity', 0.3);
            
            // Actual bars
            g.selectAll('.actual-bar')
                .data(workers)
                .enter().append('rect')
                .attr('class', 'actual-bar')
                .attr('x', d => x(d.name))
                .attr('width', x.bandwidth())
                .attr('y', d => y(d.percentage))
                .attr('height', d => height - y(d.percentage))
                .attr('fill', d => colorMap[d.color])
                .on('mouseover', function(event, d) {
                    tooltip.style('opacity', 1)
                        .html(\`
                            <strong>\${d.name}</strong><br>
                            Erreicht: \${d.percentage.toFixed(1)}%<br>
                            Soll: \${d.targetPercentage.toFixed(1)}%<br>
                            Fläche: \${d.area.toFixed(2)} ha
                        \`)
                        .style('left', (event.pageX + 10) + 'px')
                        .style('top', (event.pageY - 10) + 'px');
                })
                .on('mouseout', function() {
                    tooltip.style('opacity', 0);
                });
            
            // Legend
            const legend = d3.select(container)
                .append('div')
                .attr('class', 'worker-legend');
            
            legend.append('div')
                .attr('class', 'legend-item')
                .html('<div class="legend-color" style="background: rgba(102, 126, 234, 0.3);"></div><span>Soll</span>');
            
            legend.append('div')
                .attr('class', 'legend-item')
                .html('<div class="legend-color" style="background: #667eea;"></div><span>Erreicht</span>');
        }
        
        function createStatsGrid(stats) {
            const container = document.getElementById('statsGrid');
            container.innerHTML = \`
                <div class="stat-card">
                    <div class="stat-number">\${stats.totalArea.toFixed(1)}</div>
                    <div class="stat-label">Gesamtfläche (ha)</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">\${stats.completedArea.toFixed(1)}</div>
                    <div class="stat-label">Bearbeitet (ha)</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">\${stats.completionAreaPercentage.toFixed(1)}%</div>
                    <div class="stat-label">Fortschritt</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">\${stats.dailyData.length}</div
