// api/index.js
import express from 'express';
import mysql from 'mysql2/promise';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

setInterval(async () => {
  try{
    await db.query('SELECT 1')
    console.log(`[${new Date().toISOString()}] Keep-alive enviado`);  
  } catch(err) {
    console.error('Error manteniendo conexión: ', err)
  }
}, 60000)

app.post('/api/validate', async (req, res) => {
  const { cardNumber } = req.body;

  if (!cardNumber) {
    return res.status(400).json({ error: 'Falta cardNumber' });
  }
  try {
    const [rows] = await db.query(`
      SELECT 
        u.nombre,
        u.chofer,
        rn.in_time,
        rn.pause_time,
        rn.restart_time,
        rn.out_time,
        p.pause,
        p.restart,
        timediff(rn.restart_time, rn.pause_time) as total_break,
        ifnull(rv.inicio, '00:00:00') as inicio_viaje,
        ifnull(rv.fin, '00:00:00') as fin_viaje,
        rv.vehiculos_matricula as last_vehicle,
        rn.intensivo,
        rn.dia_fichaje
      FROM users u
      LEFT JOIN registros_new rn
        ON u.nombre = rn.usuario
      LEFT JOIN (
        SELECT * FROM pausas
        ORDER BY id DESC
      ) p ON rn.id = p.registro_id
      LEFT JOIN (
        SELECT * FROM registros_vehiculos
        ORDER BY id DESC
      ) rv ON rn.id = rv.registro_id
      WHERE u.nfc_id = ?
        AND fecha = CURDATE()
      LIMIT 1;
    `, [cardNumber]);

    if (rows.length === 0) {
      console.log('nop')
      return res.status(404).json({ valid: false, message: 'Tarjeta no válida' });
    }
    console.log(rows[0])

    return res.json({ valid: true, data: rows[0] });
  } catch (error) {
    console.log('nop')
    console.error(error);
    return res.status(500).json({ error: 'Error en la base de datos' });
  }
});

app.put('/api/update-fichaje', async (req, res) => {
  const { nombre, in_time, out_time, pause_time, restart_time, pause, restart, pauseState, action, delegacion } = req.body;
  console.log(req.body)
  const conn = await db.getConnection();
  await conn.beginTransaction();

  const salida_nocturna = action === 'out' && in_time !== '00:00:00' && out_time < '08:00:00'
  const query = `
      UPDATE registros_new
      SET in_time = ?, out_time = ?, pause_time = ?, restart_time = ?, delegacion_fichaje = ?
      WHERE usuario = ? AND fecha = CURDATE()${salida_nocturna ? '-1' : ''}
    `
  console.log('la query es: ' + query)
  try {
    await conn.query(query, [in_time, out_time, pause_time, restart_time, delegacion, nombre]);

    if (action === 'pause_restart' ) {
      if (pauseState === 'available') {
        await conn.query(`
          INSERT INTO pausas (registro_id, pause)
          VALUES (
            (SELECT id FROM registros_new WHERE usuario = ? AND fecha = CURDATE() LIMIT 1),
            ?
          )
        `, [nombre, pause]);
      } else if (pauseState === 'processing') {
        const [rows] = await conn.query(`
          SELECT p.id FROM pausas p
          JOIN registros_new rn ON p.registro_id = rn.id
          WHERE rn.usuario = ? AND rn.fecha = CURDATE()
          ORDER BY p.id DESC LIMIT 1
        `, [nombre]);

        if (rows.length > 0) {
          await conn.query(`
            UPDATE pausas SET restart = ? WHERE id = ?
          `, [restart, rows[0].id]);
        }
      }
    }

    await conn.commit();
    res.json({ success: true });

  } catch (err) {
    await conn.rollback();
    console.error("Error actualizando fichaje:", err);
    res.status(500).json({ error: "Error en la base de datos" });
  } finally {
    conn.release();
  }
});

app.post('/procesarRegistrosVehiculos', async (req, res) => {
  console.log('Procesando registro de vehículo:', req.body);
  let {
    usuario,
    inicio_viaje,
    fin_viaje,
    selectedVehicle,
    kmsSubmit,
    kmsProximaRevisionManual
  } = req.body;
  
  const esViajeEnCurso = inicio_viaje !== '00:00:00' && fin_viaje === '00:00:00';

  if (kmsProximaRevisionManual === '') {
    kmsProximaRevisionManual = null;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Obtener registro_id
    const [registroRows] = await conn.query(
      'SELECT id FROM registros_new WHERE usuario = ? AND fecha = CURDATE()',
      [usuario]
    );
    if (registroRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: 'Registro no encontrado' });
    }

    const registroId = registroRows[0].id;
    console.log('Registro ID:', registroId);

    // 2. Actualizar tabla vehiculos
    await conn.query(
      `UPDATE vehiculos
        SET 
          kms = ?, 
          kms_proxima_revision = CASE 
            WHEN ? IS NOT NULL THEN ?
            ELSE kms_proxima_revision
          END
        WHERE matricula = ?;
      `,
      [kmsSubmit, kmsProximaRevisionManual, kmsProximaRevisionManual, selectedVehicle]
    );

    // 3. Actualizar registros_new
    await conn.query(
      'UPDATE registros_new SET matricula = ?, kms_prox_revision = ? WHERE usuario = ? AND fecha = CURDATE()',
      [selectedVehicle, kmsProximaRevisionManual, usuario]
    );

    // 4. Insertar o actualizar viaje
    if (esViajeEnCurso) {
      // Finalizar viaje
      await conn.query(
        `
        UPDATE registros_vehiculos 
        SET fin = CURTIME(), vehiculos_matricula = ?, kms_out = ?
        WHERE registro_id = ?
        ORDER BY id DESC LIMIT 1
      `,
        [selectedVehicle, kmsSubmit, registroId]
      );
    } else {
      // Nuevo viaje
      await conn.query(
        `
        INSERT INTO registros_vehiculos (vehiculos_matricula, kms_in, inicio, registro_id)
        VALUES (?, ?, CURTIME(), ?)
      `,
        [selectedVehicle, kmsSubmit, registroId]
      );
    }

    await conn.commit();
    res.status(200).json({ success: true });
  } catch (err) {
    await conn.rollback();
    console.error('❌ Error en /procesarRegistrosVehiculos:', err);
    res.status(500).json({ success: false, message: 'Error procesando registro de vehículo' });
  } finally {
    conn.release();
  }
});



app.post('/vehiculos', async (req, res) => {
  console.log('Recibiendo solicitud de vehículos');

  try {
    const [rows] = await db.query('SELECT * FROM vehiculos');

    res.json(rows);
  } catch (error) {
    console.error('Error en la base de datos:', error);
    res.status(500).json({ error: 'Error interno' });
  }
});


app.listen(PORT, () => {
  console.log(`API backend escuchando en http://localhost:${PORT}`);
});
