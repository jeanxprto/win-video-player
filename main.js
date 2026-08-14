const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Resolver ruta de ffmpeg para soportar ASAR unpacked en producción
let resolvedFfmpegPath = ffmpegPath;
if (resolvedFfmpegPath.includes('app.asar')) {
  resolvedFfmpegPath = resolvedFfmpegPath.replace('app.asar', 'app.asar.unpacked');
}

// Configurar ruta de ffmpeg
ffmpeg.setFfmpegPath(resolvedFfmpegPath);

let mainWindow = null;
let activeTranscodeCommand = null;
let hardwareAccelerationType = 'software'; // 'nvenc', 'qsv', 'amf', 'software'

// Detecta si la máquina cuenta con soporte para codificación acelerada por hardware de GPU
function detectHardwareAcceleration() {
  return new Promise((resolve) => {
    exec(`"${resolvedFfmpegPath}" -encoders`, (error, stdout, stderr) => {
      if (error) {
        console.error('[GPU Detection] Error al consultar codificadores:', error);
        resolve('software');
        return;
      }
      const encoders = stdout || stderr || '';
      if (encoders.includes('h264_nvenc')) {
        console.log('[GPU Detection] NVIDIA NVENC detectado.');
        resolve('nvenc');
      } else if (encoders.includes('h264_qsv')) {
        console.log('[GPU Detection] Intel QuickSync (QSV) detectado.');
        resolve('qsv');
      } else if (encoders.includes('h264_amf')) {
        console.log('[GPU Detection] AMD AMF detectado.');
        resolve('amf');
      } else {
        console.log('[GPU Detection] No se detectó aceleración compatible. Usando software (CPU).');
        resolve('software');
      }
    });
  });
}

// Servidor local de streaming y transcodificación
const PORT = 8888;
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const action = reqUrl.pathname;
  const filePath = reqUrl.searchParams.get('path');

  if (!filePath) {
    res.writeHead(400);
    res.end('Missing file path');
    return;
  }

  // Decodificar ruta (para caracteres especiales o espacios)
  const decodedPath = decodeURIComponent(filePath);

  if (!fs.existsSync(decodedPath)) {
    res.writeHead(404);
    res.end('File not found');
    return;
  }

  if (action === '/duration') {
    // Retornar duración y metadatos del video en JSON
    getVideoMetadata(decodedPath)
      .then(meta => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
      })
      .catch(err => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      });
  } else if (action === '/stream') {
    const ext = path.extname(decodedPath).toLowerCase();
    // Formatos nativos de Chromium/Electron
    const isNative = ['.mp4', '.webm', '.ogg'].includes(ext);
    const start = reqUrl.searchParams.get('start') ? parseFloat(reqUrl.searchParams.get('start')) : 0;
    const videoCodec = reqUrl.searchParams.get('videoCodec') || 'unknown';
    const audioCodec = reqUrl.searchParams.get('audioCodec') || 'unknown';
    const audioTrack = reqUrl.searchParams.get('audioTrack'); // Obtener pista de audio seleccionada

    // Si es nativo y no se pide pista de audio específica, servir directo.
    // De lo contrario, usar transcodificador/remuxer para mapear el track deseado.
    if (isNative && (!audioTrack || audioTrack === '')) {
      serveNativeFile(decodedPath, req, res);
    } else {
      serveTranscodedFile(decodedPath, start, videoCodec, audioCodec, audioTrack, req, res);
    }
  } else if (action === '/subtitle') {
    const trackIndex = reqUrl.searchParams.get('index') ? parseInt(reqUrl.searchParams.get('index')) : 0;
    const decodedPath = decodeURIComponent(filePath);

    if (!fs.existsSync(decodedPath)) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });

    // Extraer subtítulo y convertir a WebVTT directamente vía pipe
    const subProcess = spawn(resolvedFfmpegPath, [
      '-i', decodedPath,
      '-map', `0:${trackIndex}`,
      '-f', 'webvtt',
      'pipe:1'
    ]);

    subProcess.stdout.pipe(res);

    subProcess.on('error', (err) => {
      console.error('Error al extraer subtítulos:', err);
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`Streaming server running on http://localhost:${PORT}`);
});

// Función para servir archivos nativos con soporte de Partial Content (206)
function serveNativeFile(filePath, req, res) {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    console.error('Error serving native file:', err);
    if (!res.writableEnded) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }
}

// Función para transcodificar/copiar archivos no nativos al vuelo de forma inteligente
function serveTranscodedFile(filePath, start, videoCodec, audioCodec, audioTrack, req, res) {
  // Cancelar proceso previo si existe
  if (activeTranscodeCommand) {
    try {
      activeTranscodeCommand.kill('SIGKILL');
      activeTranscodeCommand = null;
    } catch (e) {
      console.log('Error al detener FFmpeg previo:', e);
    }
  }

  // Leer parámetro query de soporte de HEVC desde la petición
  const reqUrl = new URL(req.url, 'http://localhost');
  const hevcSupport = reqUrl.searchParams.get('hevcSupport') === 'true';

  // Determinar si podemos simplemente copiar el stream de video y audio
  const canCopyVideo = ['h264', 'vp8', 'vp9', 'av1'].includes(videoCodec);
  const canCopyAudio = ['aac', 'mp3'].includes(audioCodec);

  // Muxear a fragmentos de MP4 (fMP4) como contenedor universal si usamos H.264
  // o transcodificamos a H.264. Si es VP8/VP9 nativo, usamos WebM.
  let containerFormat = 'mp4';
  let contentType = 'video/mp4';
  let videoArg = [];
  let audioArg = [];
  let formatOptions = [];

  if (videoCodec === 'vp8' || videoCodec === 'vp9') {
    // Si ya está en VP8/VP9, usamos WebM directo copiando
    containerFormat = 'webm';
    contentType = 'video/webm';
    videoArg = ['-c:v', 'copy'];
    audioArg = canCopyAudio ? ['-c:a', 'copy'] : ['-c:a', 'libvorbis'];
  } else {
    // Para H.264 (copia), HEVC soportado por cliente (copia/remux) y otros (transcodificación)
    containerFormat = 'mp4';
    contentType = 'video/mp4';

    const isHEVCNativo = (videoCodec === 'hevc' || videoCodec === 'h265') && hevcSupport;

    if (videoCodec === 'h264' || isHEVCNativo) {
      console.log(`[Streaming] Remuxing directo activado para video: ${videoCodec}`);
      videoArg = ['-c:v', 'copy'];
    } else {
      // Transcodificación dinámica por hardware GPU / CPU
      if (hardwareAccelerationType === 'nvenc') {
        console.log('[Streaming] Usando NVIDIA NVENC para codificar H.264');
        videoArg = [
          '-c:v', 'h264_nvenc',
          '-preset', 'p1',
          '-tune', 'ull',
          '-cq', '24',
          '-pix_fmt', 'yuv420p'
        ];
      } else if (hardwareAccelerationType === 'qsv') {
        console.log('[Streaming] Usando Intel QSV para codificar H.264');
        videoArg = [
          '-c:v', 'h264_qsv',
          '-preset', 'veryfast',
          '-global_quality', '22',
          '-pix_fmt', 'yuv420p'
        ];
      } else if (hardwareAccelerationType === 'amf') {
        console.log('[Streaming] Usando AMD AMF para codificar H.264');
        videoArg = [
          '-c:v', 'h264_amf',
          '-quality', 'speed',
          '-rc', 'cfl',
          '-pix_fmt', 'yuv420p'
        ];
      } else {
        console.log('[Streaming] Aceleración no disponible, usando codificador por software (CPU)');
        videoArg = [
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-crf', '22',
          '-pix_fmt', 'yuv420p'
        ];
      }
    }

    if (canCopyAudio) {
      audioArg = ['-c:a', 'copy'];
    } else {
      // AAC de excelente calidad con resampler asíncrono para prevenir descalces A/V
      audioArg = ['-c:a', 'aac', '-b:a', '192k', '-af', 'aresample=async=1'];
    }

    // Configuración para fragmentar MP4 con fragmentos pequeños (0.5s) para inicio de reproducción instantáneo
    formatOptions = [
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '500000'
    ];
  }

  res.writeHead(200, {
    'Content-Type': contentType,
    'Transfer-Encoding': 'chunked',
    'Connection': 'keep-alive',
    'Accept-Ranges': 'none'
  });

  const args = [];
  
  // Optimización de velocidad: Reducir análisis de flujo y deshabilitar buffers de FFmpeg
  args.push('-probesize', '150000');
  args.push('-analyzeduration', '100000');
  args.push('-fflags', '+nobuffer+genpts');

  // Búsqueda de Doble Fase (Doble Seek):
  // Combina un salto rápido al keyframe más cercano (input seek) con un salto preciso (output seek)
  // para lograr un seek instantáneo (menos de 100ms) libre de desfases A/V.
  let inputSeek = 0;
  let outputSeek = 0;

  if (start > 0) {
    const margin = 20; // Margen de alineación en segundos
    if (start > margin) {
      inputSeek = start - margin;
      outputSeek = margin;
    } else {
      inputSeek = 0;
      outputSeek = start;
    }
  }

  // 1. Salto rápido antes del input (-i)
  if (inputSeek > 0) {
    args.push('-ss', inputSeek.toString());
  }

  args.push('-i', filePath);

  // Mapear streams específicos de audio si se seleccionó una pista distinta
  if (audioTrack !== null && audioTrack !== undefined && audioTrack !== '') {
    args.push('-map', '0:v:0', '-map', `0:${audioTrack}`);
  }

  // 2. Salto preciso después del input (-i) para descartar los últimos segundos y alinear audio/video
  if (outputSeek > 0) {
    args.push('-ss', outputSeek.toString());
  }

  args.push(...videoArg);
  args.push(...audioArg);
  
  // Sincronización A/V: Forzar alineación de timestamps de salida a partir de cero al hacer seeks
  args.push('-avoid_negative_ts', 'make_zero');
  
  args.push('-f', containerFormat);
  if (formatOptions.length > 0) {
    args.push(...formatOptions);
  }
  args.push('-threads', '0'); // Hilos auto
  args.push('pipe:1'); // Salida estándar

  console.log(`[Spawn] Iniciando transcodificación/remux inteligente desde ${start}s: ${resolvedFfmpegPath} ${args.join(' ')}`);
  
  const ffmpegProcess = spawn(resolvedFfmpegPath, args);
  activeTranscodeCommand = ffmpegProcess;

  // Canalizar salida de video al cliente HTTP
  ffmpegProcess.stdout.pipe(res);

  // Monitorizar salida de stderr para depuración en desarrollo
  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('frame=') || msg.includes('size=')) {
      console.log('[FFmpeg Progress]', msg.trim());
    } else {
      console.log('[FFmpeg Info]', msg.trim());
    }
  });

  ffmpegProcess.on('error', (err) => {
    console.error('[FFmpeg Process Error]', err);
    if (!res.writableEnded) {
      res.end();
    }
  });

  ffmpegProcess.on('exit', (code, signal) => {
    console.log(`[FFmpeg Process Exit] code: ${code}, signal: ${signal}`);
    if (!res.writableEnded) {
      res.end();
    }
  });

  req.on('close', () => {
    console.log('[Server] Cliente cerró la conexión HTTP. Cancelando proceso FFmpeg...');
    try {
      ffmpegProcess.kill('SIGKILL');
    } catch (e) {
      // Ignorar si el proceso ya terminó
    }
  });
}

// Obtener metadatos del video (duración y códecs) usando ffmpeg directamente
function getVideoMetadata(filePath) {
  return new Promise((resolve, reject) => {
    // Establecer un tiempo de espera de 5 segundos
    const timer = setTimeout(() => {
      reject(new Error('Tiempo de espera agotado al leer los metadatos del video'));
    }, 5000);

    execFile(resolvedFfmpegPath, ['-i', filePath], (error, stdout, stderr) => {
      clearTimeout(timer);
      
      const output = stderr || '';
      
      // Si ocurre un error grave y no se generó información en stderr
      if (error && !output) {
        reject(error);
        return;
      }

      const match = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (match) {
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        const seconds = parseInt(match[3], 10);
        const hundredths = parseInt(match[4], 10);
        const duration = (hours * 3600) + (minutes * 60) + seconds + (hundredths / 100);

        // Parsear códecs de video y audio
        const videoMatch = output.match(/Video: (\w+)/);
        const audioMatch = output.match(/Audio: (\w+)/);

        const videoCodec = videoMatch ? videoMatch[1].toLowerCase() : 'unknown';
        const audioCodec = audioMatch ? audioMatch[1].toLowerCase() : 'unknown';

        resolve({
          duration,
          videoCodec,
          audioCodec
        });
      } else {
        reject(new Error('No se pudo determinar la duración ni metadatos del video'));
      }
    });
  });
}

// Inicialización de la ventana de Electron
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 640,
    minHeight: 360,
    frame: false,            // Ventana sin bordes
    transparent: false,      // Sin transparencia (esquinas rectas)
    backgroundColor: '#161a22', // Color de fondo sólido
    icon: path.join(__dirname, 'icon.ico'), // Icono oficial de la ventana
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    // Buscar un argumento de ruta válido que no sea el ejecutable o flags de electron
    const filePathArg = process.argv.slice(1).find(arg => {
      try {
        return fs.existsSync(arg) && fs.lstatSync(arg).isFile();
      } catch (e) {
        return false;
      }
    });
    if (filePathArg) {
      console.log('[Main] Detectado archivo por argumento:', filePathArg);
      mainWindow.webContents.send('load-file-arg', filePathArg);
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Detener servidor local
    server.close();
  });
}

app.whenReady().then(async () => {
  hardwareAccelerationType = await detectHardwareAcceleration();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Manejo de eventos IPC de la ventana (Window Controls)
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// Selector de archivos del sistema
ipcMain.handle('open-file-dialog', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Videos', extensions: ['mp4', 'webm', 'ogg', 'mkv', 'avi', 'flv', 'mov', 'wmv', 'm4v', '3gp'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Selector de archivos de subtítulos del sistema
ipcMain.handle('open-subtitle-dialog', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Subtítulos', extensions: ['srt', 'vtt'] }
    ]
  });
  if (!result.canceled && result.filePaths.length > 0) {
    try {
      const filePath = result.filePaths[0];
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        name: path.basename(filePath),
        content: content,
        ext: path.extname(filePath).toLowerCase()
      };
    } catch (e) {
      console.error('Error al leer archivo de subtítulos:', e);
      return null;
    }
  }
  return null;
});

// Configuración de actualizaciones automáticas (auto-updater)
autoUpdater.autoDownload = false;

ipcMain.on('comprobar-actualizacion', () => {
  console.log('[Updater IPC] Solicitud de comprobación recibida');
  
  // Evitar que electron-updater omita la búsqueda en silencio en modo desarrollo
  if (!app.isPackaged) {
    console.log('[Updater] Omitiendo búsqueda en desarrollo (app.isPackaged = false)');
    if (mainWindow) {
      mainWindow.webContents.send('estado-actualizacion', 'error', 'Las actualizaciones automáticas requieren ejecutar la aplicación empaquetada e instalada.');
    }
    return;
  }

  autoUpdater.checkForUpdates().catch(err => {
    console.error('[Updater] Error en checkForUpdates promise:', err);
    if (mainWindow) {
      mainWindow.webContents.send('estado-actualizacion', 'error', err.message);
    }
  });
});

ipcMain.on('iniciar-descarga', () => {
  console.log('[Updater IPC] Solicitud de inicio de descarga recibida');
  autoUpdater.downloadUpdate().catch(err => {
    console.error('[Updater] Error en downloadUpdate promise:', err);
    if (mainWindow) {
      mainWindow.webContents.send('estado-actualizacion', 'error', err.message);
    }
  });
});

ipcMain.on('aplicar-actualizacion', () => {
  console.log('[Updater IPC] Solicitud de aplicar actualización (reiniciar)');
  autoUpdater.quitAndInstall();
});

// Eventos de autoUpdater
autoUpdater.on('checking-for-update', () => {
  console.log('[Updater Event] Checking for update...');
  if (mainWindow) {
    mainWindow.webContents.send('estado-actualizacion', 'buscando');
  }
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater Event] Update available:', info);
  if (mainWindow) {
    mainWindow.webContents.send('estado-actualizacion', 'disponible', info);
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('[Updater Event] Update not available:', info);
  if (mainWindow) {
    mainWindow.webContents.send('estado-actualizacion', 'no-disponible', info);
  }
});

autoUpdater.on('error', (err) => {
  console.error('[Updater Event] Error:', err);
  if (mainWindow) {
    mainWindow.webContents.send('estado-actualizacion', 'error', err.message || err.toString());
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  console.log(`[Updater Event] Downloading: ${progressObj.percent}%`);
  if (mainWindow) {
    mainWindow.webContents.send('progreso-descarga', progressObj.percent);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater Event] Update downloaded:', info);
  if (mainWindow) {
    mainWindow.webContents.send('estado-actualizacion', 'descargada', info);
  }
});

// Lógica de análisis de streams de video (probeMedia) usando FFmpeg
function probeMedia(filePath) {
  return new Promise((resolve) => {
    const ffmpegProcess = spawn(resolvedFfmpegPath, ['-i', filePath]);
    let stderrOutput = '';
    
    ffmpegProcess.stderr.on('data', (data) => {
      stderrOutput += data.toString();
    });
    
    ffmpegProcess.on('close', () => {
      const audioTracks = [];
      const subtitleTracks = [];
      
      // Capturar flujos mediante regex de la salida de FFmpeg (stderr)
      const streamRegex = /Stream #0:(\d+)(?:\(([^)]+)\))?: (Audio|Subtitle): (.*)/gi;
      let match;
      
      while ((match = streamRegex.exec(stderrOutput)) !== null) {
        const index = parseInt(match[1]);
        const lang = match[2] || 'und';
        const type = match[3];
        const details = match[4];
        
        let languageName = lang.toUpperCase();
        if (lang === 'spa' || lang === 'es') languageName = 'Español';
        else if (lang === 'eng' || lang === 'en') languageName = 'Inglés';
        else if (lang === 'fre' || lang === 'fr') languageName = 'Francés';
        else if (lang === 'ger' || lang === 'de') languageName = 'Alemán';
        else if (lang === 'ita' || lang === 'it') languageName = 'Italiano';
        else if (lang === 'por' || lang === 'pt') languageName = 'Portugués';
        else if (lang === 'und') languageName = 'Desconocido';
        
        if (type.toLowerCase() === 'audio') {
          audioTracks.push({
            index: index,
            lang: lang,
            langName: languageName,
            details: details.split(',')[0] || ''
          });
        } else if (type.toLowerCase() === 'subtitle') {
          const isGraphical = details.includes('pgs') || details.includes('dvd') || details.includes('picture');
          if (!isGraphical) {
            subtitleTracks.push({
              index: index,
              lang: lang,
              langName: languageName,
              details: details.split(' ')[0] || ''
            });
          }
        }
      }
      
      resolve({ audioTracks, subtitleTracks });
    });
  });
}

// Canal IPC para escanear streams de un archivo de video
ipcMain.handle('probe-media', async (event, filePath) => {
  if (!filePath) return { audioTracks: [], subtitleTracks: [] };
  try {
    return await probeMedia(filePath);
  } catch (err) {
    console.error('[probe-media] Error al escanear pistas:', err);
    return { audioTracks: [], subtitleTracks: [] };
  }
});


