// server.js - PostgreSQL Version für QField Synchronisation
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// PostgreSQL Konfiguration
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Datenbankinitialisierung
async function initializeDatabase() {
  const client = await pool.connect();
  
  try {
    // Projects Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        color_workers JSONB DEFAULT '{}',
        worker_percentages JSONB DEFAULT '{}',
        session_info JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Polygons Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS polygons (
        id SERIAL PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        polygon_id VARCHAR(255) NOT NULL,
        flaeche_ha DECIMAL(10,4) DEFAULT 0,
        bearbeitet VARCHAR(255) DEFAULT '',
        datum VARCHAR(50) DEFAULT '',
        farbe VARCHAR(10) DEFAULT '',
        geometry TEXT DEFAULT '',
        source VARCHAR(100) DEFAULT 'unknown',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(project_id, polygon_id)
    )`);

    // Server Status Tabelle
    await client.query(`
      CREATE TABLE IF NOT EXISTS server_status (
        id INTEGER PRIMARY KEY DEFAULT 1,
        status BOOLEAN DEFAULT false,
        last_update TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        source VARCHAR(100) DEFAULT 'server',
        CONSTRAINT single_row CHECK (id = 1)
      )
    `);

    // Initial Status einfügen falls nicht vorhanden
    await client.query(`
      INSERT INTO server_status (id, status, last_update, source)
      VALUES (1, false, CURRENT_TIMESTAMP, 'server')
      ON CONFLICT (id) DO NOTHING
    `);

    // Update Trigger für updated_at
    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql'
    `);

    // Trigger für Projects
    await client.query(`
      DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
      CREATE TRIGGER update_projects_updated_at
        BEFORE UPDATE ON projects
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);

    // Trigger für Polygons
    await client.query(`
      DROP TRIGGER IF EXISTS update_polygons_updated_at ON polygons;
      CREATE TRIGGER update_polygons_updated_at
        BEFORE UPDATE ON polygons
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column()
    `);

    console.log('✅ Datenbank erfolgreich initialisiert');
    
  } catch (error) {
    console.error('❌ Fehler bei Datenbankinitialisierung:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Hilfsfunktionen
async function getOrCreateProject(projectName, projectInfo = {}) {
  const client = await pool.connect();
  
  try {
    // Versuche Projekt zu finden
    let result = await client.query(
      'SELECT * FROM projects WHERE name = $1',
      [projectName]
    );

    if (result.rows.length === 0) {
      // Projekt erstellen
      result = await client.query(`
        INSERT INTO projects (name, color_workers, worker_percentages, session_info)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `, [
        projectName,
        JSON.stringify(projectInfo.colorWorkers || {}),
        JSON.stringify(projectInfo.workerPercentages || {}),
        JSON.stringify(projectInfo.sessionInfo || {})
      ]);
      
      console.log(`🆕 Neues Projekt erstellt: ${projectName}`);
    } else if (Object.keys(projectInfo).length > 0) {
      // Projekt-Info aktualisieren
      result = await client.query(`
        UPDATE projects 
        SET color_workers = $2, 
            worker_percentages = $3, 
            session_info = $4
        WHERE name = $1
        RETURNING *
      `, [
        projectName,
        JSON.stringify(projectInfo.colorWorkers || result.rows[0].color_workers),
        JSON.stringify(projectInfo.workerPercentages || result.rows[0].worker_percentages),
        JSON.stringify(projectInfo.sessionInfo || result.rows[0].session_info)
      ]);
      
      console.log(`🔄 Projekt-Info aktualisiert: ${projectName}`);
    }

    return result.rows[0];
    
  } finally {
    client.release();
  }
}

async function calculateProjectStatistics(projectId) {
  const client = await pool.connect();
  
  try {
    // Basis-Statistiken
    const statsResult = await client.query(`
      SELECT 
        COUNT(*) as total_polygons,
        COUNT(CASE WHEN bearbeitet != '' AND datum != '' AND farbe != '' THEN 1 END) as completed_polygons,
        COALESCE(SUM(flaeche_ha), 0) as total_area,
        COALESCE(SUM(CASE WHEN bearbeitet != '' AND datum != '' AND farbe != '' THEN flaeche_ha ELSE 0 END), 0) as completed_area
      FROM polygons 
      WHERE project_id = $1
    `, [projectId]);

    const stats = statsResult.rows[0];
    
    // Worker-Statistiken
    const workerResult = await client.query(`
      SELECT 
        farbe,
        bearbeitet,
        COUNT(*) as polygon_count,
        COALESCE(SUM(flaeche_ha), 0) as area,
        array_agg(
          json_build_object(
            'datum', datum,
            'area', flaeche_ha,
            'id', polygon_id
          ) ORDER BY datum DESC
        ) as chronology
      FROM polygons 
      WHERE project_id = $1 
        AND bearbeitet != '' 
        AND datum != '' 
        AND farbe != ''
      GROUP BY farbe, bearbeitet
    `, [projectId]);

    // Projekt-Info abrufen
    const projectResult = await client.query(`
      SELECT color_workers, worker_percentages 
      FROM projects 
      WHERE id = $1
    `, [projectId]);

    const projectInfo = projectResult.rows[0] || {};
    const colorWorkers = projectInfo.color_workers || {};
    const workerPercentages = projectInfo.worker_percentages || {};

    // Worker-Statistiken formatieren
    const workerStats = {};
    workerResult.rows.forEach(worker => {
      const percentage = parseFloat(stats.total_area) > 0 ? 
        (parseFloat(worker.area) / parseFloat(stats.total_area) * 100) : 0;
      
      workerStats[worker.farbe] = {
        name: worker.bearbeitet,
        color: worker.farbe,
        area: parseFloat(worker.area),
        polygonCount: parseInt(worker.polygon_count),
        percentage: percentage,
        chronology: worker.chronology.filter(entry => entry.datum && entry.area)
      };
    });

    return {
      totalPolygons: parseInt(stats.total_polygons),
      completedPolygons: parseInt(stats.completed_polygons),
      completionPercentage: parseInt(stats.total_polygons) > 0 ? 
        (parseInt(stats.completed_polygons) / parseInt(stats.total_polygons) * 100) : 0,
      totalArea: parseFloat(stats.total_area),
      completedArea: parseFloat(stats.completed_area),
      completionAreaPercentage: parseFloat(stats.total_area) > 0 ? 
        (parseFloat(stats.completed_area) / parseFloat(stats.total_area) * 100) : 0,
      workerStats,
      participantCount: Object.keys(workerStats).length
    };
    
  } finally {
    client.release();
  }
}

// API Routes

// Server Status
app.get('/api/status', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM server_status WHERE id = 1');
    const status = result.rows[0];
    
    console.log('GET /api/status - Current status:', status.status ? 'GRÜN' : 'ROT');
    
    res.json({
      status: status.status,
      lastUpdate: status.last_update,
      source: status.source
    });
  } catch (error) {
    console.error('Fehler beim Abrufen des Status:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.post('/api/status', async (req, res) => {
  const { status, timestamp, source } = req.body;
  
  if (typeof status !== 'boolean') {
    return res.status(400).json({ error: 'Status muss boolean sein' });
  }
  
  try {
    await pool.query(`
      UPDATE server_status 
      SET status = $1, last_update = $2, source = $3 
      WHERE id = 1
    `, [status, timestamp || new Date().toISOString(), source || 'unknown']);
    
    console.log(`POST /api/status - Status geändert zu: ${status ? 'GRÜN' : 'ROT'} (von ${source || 'unknown'})`);
    
    res.json({
      success: true,
      status: status,
      message: `Status auf ${status ? 'GRÜN' : 'ROT'} gesetzt`
    });
  } catch (error) {
    console.error('Fehler beim Setzen des Status:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Synchronisation
app.post('/api/sync', async (req, res) => {
  const { action, layerName, data, timestamp, source, projectInfo } = req.body;
  
  console.log(`POST /api/sync - Layer: ${layerName}, Action: ${action}, Polygons: ${data ? data.length : 0}`);
  
  if (!layerName || !data || !Array.isArray(data)) {
    return res.status(400).json({ error: 'LayerName und data array erforderlich' });
  }
  
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const projectName = projectInfo?.projectName || layerName;
    
    // Projekt abrufen oder erstellen
    const project = await getOrCreateProject(projectName, projectInfo);
    
    let newCount = 0;
    let updatedCount = 0;
    
    for (const incomingPolygon of data) {
      if (!incomingPolygon.id) continue;
      
      // Debug: Prüfe alle verfügbaren Felder
      console.log('📊 Eingehende Polygon-Daten:', {
        id: incomingPolygon.id,
        flaeche_ha: incomingPolygon.flaeche_ha,
        Fläche_ha: incomingPolygon['Fläche_ha'], // Möglicher alternativer Feldname
        bearbeitet: incomingPolygon.bearbeitet,
        datum: incomingPolygon.datum,
        farbe: incomingPolygon.farbe,
        allKeys: Object.keys(incomingPolygon)
      });
      
      // Flexiblere Feldnamenerkennung für Fläche
      let flaeche = incomingPolygon.flaeche_ha || 
                   incomingPolygon['Fläche_ha'] || 
                   incomingPolygon.area || 
                   incomingPolygon.Flaeche_ha ||
                   0;
      
      // Prüfe ob Polygon bereits existiert
      const existingResult = await client.query(`
        SELECT * FROM polygons 
        WHERE project_id = $1 AND polygon_id = $2
      `, [project.id, incomingPolygon.id]);
      
      if (existingResult.rows.length > 0) {
        // Update: Fülle nur leere Felder
        const existing = existingResult.rows[0];
        
        const updateFields = [];
        const updateValues = [];
        let valueIndex = 1;
        
        // Flaeche_ha immer aktualisieren wenn vorhanden
        if (flaeche > 0) {
          updateFields.push(`flaeche_ha = $${valueIndex}`);
          updateValues.push(flaeche);
          valueIndex++;
        }
        
        if (!existing.bearbeitet && incomingPolygon.bearbeitet) {
          updateFields.push(`bearbeitet = $${valueIndex}`);
          updateValues.push(incomingPolygon.bearbeitet);
          valueIndex++;
        }
        
        if (!existing.datum && incomingPolygon.datum) {
          updateFields.push(`datum = $${valueIndex}`);
          updateValues.push(incomingPolygon.datum);
          valueIndex++;
        }
        
        if (!existing.farbe && incomingPolygon.farbe) {
          updateFields.push(`farbe = $${valueIndex}`);
          updateValues.push(incomingPolygon.farbe);
          valueIndex++;
        }
        
        if (!existing.geometry && incomingPolygon.geometry) {
          updateFields.push(`geometry = $${valueIndex}`);
          updateValues.push(incomingPolygon.geometry);
          valueIndex++;
        }
        
        if (updateFields.length > 0) {
          updateFields.push(`source = $${valueIndex}`);
          updateValues.push(source || 'unknown');
          valueIndex++;
          
          updateValues.push(project.id);
          updateValues.push(incomingPolygon.id);
          
          await client.query(`
            UPDATE polygons 
            SET ${updateFields.join(', ')}
            WHERE project_id = $${valueIndex-1} AND polygon_id = $${valueIndex}
          `, updateValues);
          
          updatedCount++;
          console.log(`🔄 Polygon ${incomingPolygon.id} aktualisiert (Fläche: ${flaeche} ha)`);
        }
        
      } else {
        // Neues Polygon einfügen
        await client.query(`
          INSERT INTO polygons (
            project_id, polygon_id, flaeche_ha, bearbeitet, datum, farbe, geometry, source
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          project.id,
          incomingPolygon.id,
          flaeche,
          incomingPolygon.bearbeitet || '',
          incomingPolygon.datum || '',
          incomingPolygon.farbe || '',
          incomingPolygon.geometry || '',
          source || 'unknown'
        ]);
        
        newCount++;
        console.log(`✅ Neues Polygon ${incomingPolygon.id} erstellt (Fläche: ${flaeche} ha)`);
      }
    }
    
    // Alle Polygone für Rückgabe abrufen
    const allPolygonsResult = await client.query(`
      SELECT polygon_id as id, flaeche_ha, bearbeitet, datum, farbe, geometry
      FROM polygons 
      WHERE project_id = $1
    `, [project.id]);
    
    await client.query('COMMIT');
    
    console.log(`✅ Sync abgeschlossen - Neu: ${newCount}, Aktualisiert: ${updatedCount}, Gesamt: ${allPolygonsResult.rows.length}`);
    
    res.json({
      success: true,
      message: 'Synchronisation erfolgreich',
      statistics: {
        totalPolygons: allPolygonsResult.rows.length,
        newPolygons: newCount,
        updatedPolygons: updatedCount,
        lastSync: new Date().toISOString()
      },
      serverData: allPolygonsResult.rows
    });
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Sync Fehler:', error);
    res.status(500).json({ error: 'Synchronisation fehlgeschlagen: ' + error.message });
  } finally {
    client.release();
  }
});

// Projekt-Übersicht
app.get('/api/projects', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.*,
        COUNT(pol.id) as polygon_count
      FROM projects p
      LEFT JOIN polygons pol ON p.id = pol.project_id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `);
    
    const projects = [];
    
    for (const project of result.rows) {
      const stats = await calculateProjectStatistics(project.id);
      
      projects.push({
        name: project.name,
        ...stats,
        lastUpdate: project.updated_at
      });
    }
    
    res.json({
      projects: projects,
      totalProjects: projects.length,
      lastSync: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Fehler beim Laden der Projekte:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Detaillierte Projekt-Daten
app.get('/api/project/:projectName', async (req, res) => {
  const { projectName } = req.params;
  
  try {
    const projectResult = await pool.query(`
      SELECT * FROM projects WHERE name = $1
    `, [projectName]);
    
    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Projekt nicht gefunden' });
    }
    
    const project = projectResult.rows[0];
    
    // Polygon-Daten abrufen
    const polygonsResult = await pool.query(`
      SELECT polygon_id as id, flaeche_ha, bearbeitet, datum, farbe, geometry, 
             created_at, updated_at, source
      FROM polygons 
      WHERE project_id = $1
      ORDER BY updated_at DESC
    `, [project.id]);
    
    const stats = await calculateProjectStatistics(project.id);
    
    res.json({
      projectName: project.name,
      info: {
        projectName: project.name,
        colorWorkers: project.color_workers,
        workerPercentages: project.worker_percentages,
        sessionInfo: project.session_info
      },
      data: polygonsResult.rows,
      statistics: stats,
      lastSync: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Fehler beim Laden des Projekts:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Legacy Endpoints für Rückwärtskompatibilität
app.get('/api/data/:layerName', async (req, res) => {
  const { layerName } = req.params;
  
  try {
    const projectResult = await pool.query(`
      SELECT id FROM projects WHERE name = $1
    `, [layerName]);
    
    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Layer nicht gefunden' });
    }
    
    const polygonsResult = await pool.query(`
      SELECT polygon_id as id, flaeche_ha, bearbeitet, datum, farbe, geometry
      FROM polygons 
      WHERE project_id = $1
    `, [projectResult.rows[0].id]);
    
    res.json({
      layerName: layerName,
      data: polygonsResult.rows,
      lastSync: new Date().toISOString(),
      count: polygonsResult.rows.length
    });
    
  } catch (error) {
    console.error('Fehler beim Laden der Layer-Daten:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.get('/api/layers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        p.name,
        COUNT(pol.id) as polygon_count,
        MAX(pol.updated_at) as last_update
      FROM projects p
      LEFT JOIN polygons pol ON p.id = pol.project_id
      GROUP BY p.id, p.name
      ORDER BY p.updated_at DESC
    `);
    
    res.json({
      layers: result.rows.map(row => ({
        name: row.name,
        polygonCount: parseInt(row.polygon_count),
        lastUpdate: row.last_update
      })),
      totalLayers: result.rows.length,
      lastSync: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Fehler beim Laden der Layer:', error);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

// Simple Dashboard
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>QField PostgreSQL Dashboard</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 20px; 
            background: #f5f5f5; 
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto; 
            background: white; 
            padding: 20px; 
            border-radius: 10px; 
            box-shadow: 0 2px 10px rgba(0,0,0,0.1); 
        }
        .header { 
            text-align: center; 
            margin-bottom: 30px; 
        }
        .status { 
            padding: 10px; 
            border-radius: 5px; 
            margin-bottom: 20px; 
            text-align: center; 
            font-weight: bold; 
        }
        .status.online { 
            background: #d4edda; 
            color: #155724; 
        }
        .status.offline { 
            background: #f8d7da; 
            color: #721c24; 
        }
        .projects { 
            margin-top: 20px; 
        }
        .project-card { 
            border: 1px solid #ddd; 
            border-radius: 5px; 
            padding: 15px; 
            margin-bottom: 10px; 
        }
        .project-header { 
            font-weight: bold; 
            font-size: 1.2em; 
            margin-bottom: 10px; 
        }
        .project-stats { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); 
            gap: 10px; 
        }
        .stat { 
            text-align: center; 
            padding: 10px; 
            background: #f8f9fa; 
            border-radius: 3px; 
        }
        .stat-number { 
            font-size: 1.5em; 
            font-weight: bold; 
            color: #007bff; 
        }
        .btn { 
            background: #007bff; 
            color: white; 
            border: none; 
            padding: 10px 20px; 
            border-radius: 5px; 
            cursor: pointer; 
            margin: 5px; 
        }
        .btn:hover { 
            background: #0056b3; 
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🐘 QField PostgreSQL Dashboard</h1>
            <p>Modernisierte Version mit PostgreSQL Backend</p>
        </div>
        
        <div id="status" class="status">
            Lade Status...
        </div>
        
        <div class="projects" id="projects">
            Lade Projekte...
        </div>
        
        <div style="text-align: center; margin-top: 30px;">
            <button class="btn" onclick="loadData()">Aktualisieren</button>
            <button class="btn" onclick="testConnection()">Verbindung testen</button>
        </div>
    </div>

    <script>
        async function loadStatus() {
            try {
                const response = await fetch('/api/status');
                const data = await response.json();
                const statusDiv = document.getElementById('status');
                
                statusDiv.className = data.status ? 'status online' : 'status offline';
                statusDiv.textContent = data.status ? 
                    'System Online ✅' : 'System Offline ❌';
            } catch (error) {
                document.getElementById('status').innerHTML = 
                    '<div class="status offline">Verbindungsfehler ❌</div>';
            }
        }
        
        async function loadProjects() {
            try {
                const response = await fetch('/api/projects');
                const data = await response.json();
                const projectsDiv = document.getElementById('projects');
                
                if (data.projects.length === 0) {
                    projectsDiv.innerHTML = '<p>Keine Projekte gefunden</p>';
                    return;
                }
                
                projectsDiv.innerHTML = '<h2>Projekte (' + data.totalProjects + ')</h2>';
                
                data.projects.forEach(project => {
                    const card = document.createElement('div');
                    card.className = 'project-card';
                    card.innerHTML = \`
                        <div class="project-header">\${project.name}</div>
                        <div class="project-stats">
                            <div class="stat">
                                <div class="stat-number">\${project.totalPolygons}</div>
                                <div>Polygone</div>
                            </div>
                            <div class="stat">
                                <div class="stat-number">\${project.completedPolygons}</div>
                                <div>Bearbeitet</div>
                            </div>
                            <div class="stat">
                                <div class="stat-number">\${project.totalArea.toFixed(1)}</div>
                                <div>Gesamtfläche (ha)</div>
                            </div>
                            <div class="stat">
                                <div class="stat-number">\${project.completionPercentage.toFixed(1)}%</div>
                                <div>Fortschritt</div>
                            </div>
                        </div>
                    \`;
                    projectsDiv.appendChild(card);
                });
                
            } catch (error) {
                document.getElementById('projects').innerHTML = 
                    '<p>Fehler beim Laden der Projekte</p>';
            }
        }
        
        async function loadData() {
            await loadStatus();
            await loadProjects();
        }
        
        async function testConnection() {
            try {
                const response = await fetch('/api/projects');
                if (response.ok) {
                    alert('✅ Datenbankverbindung erfolgreich!');
                } else {
                    alert('❌ Datenbankverbindung fehlgeschlagen!');
                }
            } catch (error) {
                alert('❌ Verbindungsfehler: ' + error.message);
            }
        }
        
        // Initial laden
        loadData();
        
        // Auto-refresh alle 30 Sekunden
        setInterval(loadData, 30000);
    </script>
</body>
</html>
  `);
});

// Server starten
async function startServer() {
  try {
    await initializeDatabase();
    
    app.listen(PORT, () => {
      console.log(`
🚀 PostgreSQL Server läuft auf Port ${PORT}
🐘 Datenbank: ${process.env.DATABASE_URL ? 'PostgreSQL (Render)' : 'PostgreSQL (Lokal)'}
📊 Dashboard: ${process.env.NODE_ENV === 'production' ? 'https://qfieldnodejs.onrender.com' : `http://localhost:${PORT}`}
🔗 API Endpoints:
   - GET  /api/status
   - POST /api/status  
   - POST /api/sync
   - GET  /api/projects
   - GET  /api/project/:name
      `);
    });
  } catch (error) {
    console.error('❌ Server konnte nicht gestartet werden:', error);
    process.exit(1);
  }
}

startServer();

module.exports = app;
