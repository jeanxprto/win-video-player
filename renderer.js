const { ipcRenderer, shell } = require('electron');
const path = require('path');

// Elementos del DOM
const appContainer = document.querySelector('.app-container');
const video = document.getElementById('video-element');
const dropZone = document.getElementById('drop-zone');
const selectFileBtn = document.getElementById('select-file-btn');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const controlsOverlay = document.getElementById('controls-overlay');
const videoTitle = document.getElementById('video-title');
const backBtn = document.getElementById('back-btn');
const menuBtn = document.getElementById('menu-btn');

// Controles Centrales
const playBtn = document.getElementById('play-btn');
const playIconSvg = document.getElementById('play-icon-svg');
const rewindBtn = document.getElementById('rewind-btn');
const forwardBtn = document.getElementById('forward-btn');

// Controles Inferiores
const timeDisplay = document.getElementById('time-display');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const fullscreenIcon = document.getElementById('fullscreen-icon');
const progressContainer = document.getElementById('progress-container');
const progressActive = document.getElementById('progress-active');
const progressThumb = document.getElementById('progress-thumb');
const progressBuffer = document.getElementById('progress-buffer');

// Controles de volumen
const volumeGroup = document.getElementById('volume-group');
const volumeBtn = document.getElementById('volume-btn');
const volumeIcon = document.getElementById('volume-icon');
const volumeSlider = document.getElementById('volume-slider');
const volumeIndicator = document.getElementById('volume-indicator');

// Menú Contextual
const contextMenu = document.getElementById('context-menu');

// Modal Acerca de
const aboutModal = document.getElementById('about-modal');
const closeModalBtn = document.getElementById('close-modal-btn');

// Modal de Actualizaciones
const updateModal = document.getElementById('update-modal');
const closeUpdateModalBtn = document.getElementById('close-update-modal-btn');
const updateModalTitle = document.getElementById('update-modal-title');
const updateModalDesc = document.getElementById('update-modal-desc');
const updateLoader = document.getElementById('update-loader');
const updateProgressContainer = document.getElementById('update-progress-container');
const updateProgressBar = document.getElementById('update-progress-bar');
const updateBtnAction = document.getElementById('update-btn-action');
const menuCheckUpdates = document.getElementById('menu-check-updates');

// Botones de control de ventana de Windows
const winMinBtn = document.getElementById('win-min-btn');
const winMaxBtn = document.getElementById('win-max-btn');
const winCloseBtn = document.getElementById('win-close-btn');

// Estado de reproducción
let currentFilePath = '';
let isNative = true;
let customDuration = 0;          // Duración para videos transcodificados (segundos)
let currentVideoCodec = 'unknown';
let currentAudioCodec = 'unknown';
let transcodeSeekOffset = 0;     // Tiempo desde el cual se inició la transcodificación activa (segundos)
let previousVolume = 1;          // Almacena el volumen previo para silenciar/activar sonido
let isSeeking = false;           // Bandera para evitar que la barra salte mientras se arrastra
let controlsTimeout = null;

// SVG Icons para alternar Estados
const PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

const FULLSCREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const MINIMIZE_SCREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4"/></svg>';

const MAXIMIZE_SVG = '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const RESTORE_SVG = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M2.5,2.5 L2.5,0.5 L9.5,0.5 L9.5,7.5 L7.5,7.5 M0.5,2.5 L7.5,2.5 L7.5,9.5 L0.5,9.5 Z" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

/* ==========================================
   Controles de Ventana de Windows (IPC)
   ========================================== */
winMinBtn.addEventListener('click', () => ipcRenderer.send('window-minimize'));
winMaxBtn.addEventListener('click', () => ipcRenderer.send('window-maximize'));
winCloseBtn.addEventListener('click', () => ipcRenderer.send('window-close'));

ipcRenderer.on('window-maximized', (event, maximized) => {
  winMaxBtn.innerHTML = maximized ? RESTORE_SVG : MAXIMIZE_SVG;
});

/* ==========================================
   Carga e Inicialización de Videos
   ========================================== */

// Abre el selector de archivos
async function triggerFileOpen() {
  const filePath = await ipcRenderer.invoke('open-file-dialog');
  if (filePath) {
    loadVideo(filePath);
  }
}

selectFileBtn.addEventListener('click', triggerFileOpen);
backBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentFilePath) {
    shell.showItemInFolder(currentFilePath);
  } else {
    console.log('No hay ningún archivo de video cargado actualmente.');
  }
});

// Carga el archivo en el reproductor (detecta si es nativo o requiere transcodificación)
async function loadVideo(filePath) {
  currentFilePath = filePath;
  const fileName = path.basename(filePath);
  videoTitle.textContent = fileName;
  document.title = `${fileName} - Sophy Player`;

  // Ocultar zona drop y mostrar overlay de carga
  dropZone.classList.remove('active');
  loadingOverlay.classList.add('active');
  loadingText.textContent = "Analizando formato de video...";

  // Resetear estados
  transcodeSeekOffset = 0;
  customDuration = 0;
  video.pause();

  const ext = path.extname(filePath).toLowerCase();
  isNative = ['.mp4', '.webm', '.ogg'].includes(ext);

  if (isNative) {
    console.log('Video nativo detectado:', fileName);
    video.src = `http://localhost:8888/stream?path=${encodeURIComponent(filePath)}`;
    video.load();
  } else {
    console.log('Video no nativo (requiere transcodificación):', fileName);
    loadingText.textContent = "Obteniendo duración e iniciando transcodificación...";
    
    try {
      // Obtener la duración real del video consultando al servidor
      const response = await fetch(`http://localhost:8888/duration?path=${encodeURIComponent(filePath)}`);
      const data = await response.json();
      
      if (data.duration) {
        customDuration = data.duration;
        currentVideoCodec = data.videoCodec || 'unknown';
        currentAudioCodec = data.audioCodec || 'unknown';
        console.log('Metadatos obtenidos del video:', data);
      } else {
        throw new Error('No se pudo leer la duración');
      }

      // Conectar el video al stream transcodificado pasándole los codecs
      video.src = `http://localhost:8888/stream?path=${encodeURIComponent(filePath)}&videoCodec=${currentVideoCodec}&audioCodec=${currentAudioCodec}&start=0`;
      video.load();
    } catch (err) {
      console.error('Error cargando video no nativo:', err);
      alert('Error al procesar el video. Verifica que sea un formato válido.');
      resetToWelcomeScreen();
      return;
    }
  }

  // Auto-play cuando el video esté listo para reproducirse
  video.play().catch(e => console.log('Auto-play bloqueado o cancelado:', e));
}

function resetToWelcomeScreen() {
  currentFilePath = '';
  customDuration = 0;
  transcodeSeekOffset = 0;
  video.removeAttribute('src');
  video.load();
  dropZone.classList.add('active');
  loadingOverlay.classList.remove('active');
  controlsOverlay.classList.remove('visible');
  appContainer.classList.add('controls-visible');
  videoTitle.textContent = "Video title";
  document.title = "Sophy Player";
}

// Eventos de estado de carga del elemento Video
video.addEventListener('waiting', () => {
  loadingOverlay.classList.add('active');
  loadingText.textContent = isNative ? "Cargando..." : "Transcodificando buffer...";
});

video.addEventListener('playing', () => {
  loadingOverlay.classList.remove('active');
  playIconSvg.innerHTML = PAUSE_SVG;
  triggerControlsShow();
});

video.addEventListener('pause', () => {
  playIconSvg.innerHTML = PLAY_SVG;
  triggerControlsShow();
});

/* ==========================================
   Lógica del Tiempo de Reproducción y Seek
   ========================================== */

// Retorna el tiempo actual absoluto del video (considera el offset si es transcodificado)
function getDisplayTime() {
  if (isNative) {
    return video.currentTime;
  } else {
    return transcodeSeekOffset + video.currentTime;
  }
}

// Retorna la duración absoluta del video
function getDuration() {
  if (isNative) {
    return video.duration || 0;
  } else {
    return customDuration;
  }
}

// Actualiza el indicador de tiempo e interfaz de progreso
video.addEventListener('timeupdate', () => {
  if (isSeeking) return;

  const current = getDisplayTime();
  const total = getDuration();

  // Actualizar display de texto
  timeDisplay.textContent = `${formatTime(current)} / ${formatTime(total)}`;

  // Actualizar barra de progreso
  if (total > 0) {
    const pct = (current / total) * 100;
    progressActive.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
  }
});

// Muestra el progreso de almacenamiento en buffer
video.addEventListener('progress', () => {
  const duration = getDuration();
  if (duration > 0 && video.buffered.length > 0) {
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
    
    let bufferPct = 0;
    if (isNative) {
      bufferPct = (bufferedEnd / duration) * 100;
    } else {
      // En transcodificación, el buffer reportado es relativo al stream actual
      const currentStreamPos = transcodeSeekOffset + bufferedEnd;
      bufferPct = (currentStreamPos / duration) * 100;
    }
    progressBuffer.style.width = `${Math.min(100, bufferPct)}%`;
  }
});

// Formateador de segundos a MM:SS o HH:MM:SS
function formatTime(seconds) {
  if (isNaN(seconds) || seconds === Infinity) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

// Realiza un salto en la línea de tiempo
function seekTo(targetTime) {
  const total = getDuration();
  targetTime = Math.max(0, Math.min(total, targetTime));

  if (isNative) {
    video.currentTime = targetTime;
  } else {
    // Si es transcodificación, debemos reiniciar el stream local en el nuevo segundo
    loadingOverlay.classList.add('active');
    loadingText.textContent = "Buscando en video...";
    
    transcodeSeekOffset = targetTime;
    video.src = `http://localhost:8888/stream?path=${encodeURIComponent(currentFilePath)}&videoCodec=${currentVideoCodec}&audioCodec=${currentAudioCodec}&start=${targetTime}`;
    video.load();
    video.play().catch(e => console.log(e));
  }
}

/* ==========================================
   Controles Interactivos y Botones
   ========================================== */

// Alternar Play/Pause
function togglePlay() {
  if (!video.src) return;
  if (video.paused) {
    video.play();
  } else {
    video.pause();
  }
}

playBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  togglePlay();
});

// Saltos de 10s (Atrás/Adelante)
rewindBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  seekTo(getDisplayTime() - 10);
});

forwardBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  seekTo(getDisplayTime() + 10);
});

// Click en el reproductor de video para alternar Play/Pause
video.addEventListener('click', () => {
  if (video.src) {
    togglePlay();
  }
});

// Manejo del control deslizante (Drag and click seeking)
function handleTimelineClick(e) {
  if (!video.src) return;
  const rect = progressContainer.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const width = rect.width;
  const percentage = Math.max(0, Math.min(1, clickX / width));
  const targetTime = percentage * getDuration();
  seekTo(targetTime);
}

progressContainer.addEventListener('mousedown', (e) => {
  if (!video.src) return;
  isSeeking = true;
  handleTimelineDrag(e);

  function onMouseMove(moveEvent) {
    handleTimelineDrag(moveEvent);
  }

  function onMouseUp(upEvent) {
    isSeeking = false;
    handleTimelineDrag(upEvent);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

function handleTimelineDrag(e) {
  const rect = progressContainer.getBoundingClientRect();
  const dragX = e.clientX - rect.left;
  const width = rect.width;
  const percentage = Math.max(0, Math.min(1, dragX / width));
  
  // Actualizar UI en caliente (sin buscar en video aún para mejor fluidez visual)
  const pctValue = percentage * 100;
  progressActive.style.width = `${pctValue}%`;
  progressThumb.style.left = `${pctValue}%`;

  const targetTime = percentage * getDuration();
  timeDisplay.textContent = `${formatTime(targetTime)} / ${formatTime(getDuration())}`;

  if (!isSeeking) {
    // Si es solo click o soltamos el arrastre, hacemos el seek real en el reproductor
    seekTo(targetTime);
  }
}

// Pantalla Completa
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      fullscreenIcon.innerHTML = MINIMIZE_SCREEN_SVG;
    }).catch(err => {
      console.error('Error al intentar activar pantalla completa:', err);
    });
  } else {
    document.exitFullscreen().then(() => {
      fullscreenIcon.innerHTML = FULLSCREEN_SVG;
    });
  }
}

fullscreenBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleFullscreen();
});

/* ==========================================
   Gestión de Volumen (Silenciar y Slider)
   ========================================== */

const MUTE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="feather feather-volume-x"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
const LOW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="feather feather-volume-1"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
const HIGH_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="feather feather-volume-2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path id="volume-wave-high" d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';

function updateVolumeUI() {
  const vol = video.volume;
  const muted = video.muted;

  // Sincronizar control deslizante
  volumeSlider.value = muted ? 0 : vol;

  // Sincronizar icono
  if (muted || vol === 0) {
    volumeBtn.innerHTML = MUTE_SVG;
  } else if (vol < 0.5) {
    volumeBtn.innerHTML = LOW_SVG;
  } else {
    volumeBtn.innerHTML = HIGH_SVG;
  }
}

let volumeIndicatorTimeout = null;

// Mostrar indicador de volumen gigante (HUD)
function showVolumeIndicator() {
  const pct = Math.round((video.muted ? 0 : video.volume) * 100);
  volumeIndicator.textContent = `${pct}%`;
  volumeIndicator.classList.add('visible');

  clearTimeout(volumeIndicatorTimeout);
  volumeIndicatorTimeout = setTimeout(() => {
    volumeIndicator.classList.remove('visible');
  }, 1500); // Ocultar tras 1.5s
}

// Alternar silencio al hacer clic en el botón de volumen
volumeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (video.muted) {
    video.muted = false;
    if (video.volume === 0) {
      video.volume = previousVolume > 0 ? previousVolume : 1;
    }
  } else {
    previousVolume = video.volume;
    video.muted = true;
  }
  updateVolumeUI();
  showVolumeIndicator();
});

// Control deslizante de volumen interactivo
volumeSlider.addEventListener('input', (e) => {
  const val = parseFloat(e.target.value);
  video.volume = val;
  video.muted = val === 0;
  if (val > 0) {
    previousVolume = val;
  }
  updateVolumeUI();
  showVolumeIndicator();
});

// Control de volumen con la rueda del ratón (scroll) en el área del reproductor
document.querySelector('.player-content').addEventListener('wheel', (e) => {
  if (!video.src) return;

  // Prevenir scroll de la aplicación
  e.preventDefault();

  video.muted = false;

  // deltaY < 0 indica scroll hacia arriba, deltaY > 0 indica scroll hacia abajo
  if (e.deltaY < 0) {
    video.volume = Math.min(1, video.volume + 0.05);
  } else {
    video.volume = Math.max(0, video.volume - 0.05);
  }

  updateVolumeUI();
  showVolumeIndicator();
  triggerControlsShow();
}, { passive: false });

// Inicializar el estado de la barra de volumen al cargar
updateVolumeUI();

// Doble click en el video para pantalla completa
video.addEventListener('dblclick', () => {
  if (video.src) {
    toggleFullscreen();
  }
});

/* ==========================================
   Gestión de Interfaz: Ocultación de Controles
   ========================================== */

function triggerControlsShow() {
  controlsOverlay.classList.add('visible');
  controlsOverlay.classList.remove('no-cursor');
  appContainer.classList.add('controls-visible');
  
  clearTimeout(controlsTimeout);
  
  // Solo ocultar si el video se está reproduciendo
  if (!video.paused && video.src) {
    controlsTimeout = setTimeout(() => {
      controlsOverlay.classList.remove('visible');
      // Ocultar también el cursor dentro de la pantalla del video
      controlsOverlay.classList.add('no-cursor');
      appContainer.classList.remove('controls-visible');
    }, 3000);
  }
}

// Eventos de movimiento de mouse en los controles
document.querySelector('.player-content').addEventListener('mousemove', triggerControlsShow);

/* ==========================================
   Drag & Drop de Archivos
   ========================================== */

// Prevenir comportamiento por defecto al arrastrar
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  document.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

// Cambiar estilo de la zona drop al arrastrar encima
document.addEventListener('dragenter', () => {
  if (!dropZone.classList.contains('active')) {
    dropZone.classList.add('active');
    dropZone.classList.add('dragover');
  }
});

dropZone.addEventListener('dragover', () => {
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  if (currentFilePath !== '') {
    // Si ya hay un video cargado, ocultar la zona drop al salir
    dropZone.classList.remove('active');
  }
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  dropZone.classList.remove('dragover');
  const dt = e.dataTransfer;
  const files = dt.files;

  if (files.length > 0) {
    const file = files[0];
    // Verificar si es un archivo de video (a través de la extensión para evitar falsos negativos en Windows)
    const ext = path.extname(file.path).toLowerCase();
    const videoExtensions = ['.mp4', '.webm', '.ogg', '.mkv', '.avi', '.flv', 'mov', 'wmv', 'm4v', '3gp'];
    
    if (videoExtensions.includes(ext)) {
      loadVideo(file.path);
    } else {
      alert('Por favor, arrastra un archivo de video válido.');
      if (currentFilePath !== '') {
        dropZone.classList.remove('active');
      }
    }
  }
});

/* ==========================================
   Atajos de Teclado (Accesibilidad)
   ========================================== */
document.addEventListener('keydown', (e) => {
  if (!video.src) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekTo(getDisplayTime() - 10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekTo(getDisplayTime() + 10);
      break;
    case 'KeyF':
      e.preventDefault();
      toggleFullscreen();
      break;
    case 'ArrowUp':
      e.preventDefault();
      video.muted = false;
      video.volume = Math.min(1, video.volume + 0.05);
      updateVolumeUI();
      showVolumeIndicator();
      triggerControlsShow();
      break;
    case 'ArrowDown':
      e.preventDefault();
      video.muted = false;
      video.volume = Math.max(0, video.volume - 0.05);
      updateVolumeUI();
      showVolumeIndicator();
      triggerControlsShow();
      break;
  }
});

/* ==========================================
   Menú Contextual (Clic Derecho)
   ========================================== */
document.querySelector('.player-content').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  
  // Posicionar menú
  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.classList.add('active');
});

// Abrir menú de opciones desde el botón de la barra superior
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (contextMenu.classList.contains('active')) {
    contextMenu.classList.remove('active');
  } else {
    // Posicionar debajo del botón de menú
    const rect = menuBtn.getBoundingClientRect();
    contextMenu.style.left = `${rect.right - 150}px`; // Alinear borde derecho
    contextMenu.style.top = `${rect.bottom + 8}px`;   // Debajo del botón
    contextMenu.classList.add('active');
  }
});

// Cerrar menú al hacer clic en cualquier parte
document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target) && !menuBtn.contains(e.target)) {
    contextMenu.classList.remove('active');
  }
});

// Opciones del menú
document.getElementById('menu-open-file').addEventListener('click', () => {
  triggerFileOpen();
  contextMenu.classList.remove('active');
});


document.getElementById('menu-about').addEventListener('click', () => {
  contextMenu.classList.remove('active');
  aboutModal.classList.add('active');
});

// Cerrar el modal al hacer clic en la "X"
closeModalBtn.addEventListener('click', () => {
  aboutModal.classList.remove('active');
});


// Cerrar el modal al hacer clic fuera del contenido
aboutModal.addEventListener('click', (e) => {
  if (e.target === aboutModal) {
    aboutModal.classList.remove('active');
  }
});

// Listener para cargar archivos pasados por línea de comandos
ipcRenderer.on('load-file-arg', (event, filePath) => {
  console.log('Cargando archivo recibido por argumento:', filePath);
  loadVideo(filePath);
});

// Variable para almacenar la acción activa en el botón del modal
let currentUpdateAction = null;

// Abrir el modal e iniciar búsqueda de actualizaciones
menuCheckUpdates.addEventListener('click', () => {
  contextMenu.classList.remove('active');
  
  // Reiniciar estado visual del modal
  updateModalTitle.textContent = 'Actualizaciones';
  updateModalDesc.textContent = 'Iniciando búsqueda de actualizaciones...';
  updateLoader.style.display = 'block';
  updateProgressContainer.style.display = 'none';
  updateProgressBar.style.width = '0%';
  updateBtnAction.style.display = 'none';
  
  updateModal.classList.add('active');
  
  // Enviar comando al proceso principal
  ipcRenderer.send('comprobar-actualizacion');
});

// Cerrar modal de actualización
closeUpdateModalBtn.addEventListener('click', () => {
  // Evitar cerrar si se está descargando activamente
  if (updateProgressContainer.style.display === 'block' && updateBtnAction.style.display === 'none') {
    return;
  }
  updateModal.classList.remove('active');
});

updateModal.addEventListener('click', (e) => {
  if (e.target === updateModal) {
    if (updateProgressContainer.style.display === 'block' && updateBtnAction.style.display === 'none') {
      return;
    }
    updateModal.classList.remove('active');
  }
});

// Manejar acción del botón del modal (Descargar o Reiniciar e Instalar)
updateBtnAction.addEventListener('click', () => {
  if (currentUpdateAction === 'descargar') {
    updateLoader.style.display = 'block';
    updateModalDesc.textContent = 'Descargando actualización...';
    updateBtnAction.style.display = 'none'; // Deshabilitar mientras se descarga
    ipcRenderer.send('iniciar-descarga');
  } else if (currentUpdateAction === 'instalar') {
    ipcRenderer.send('aplicar-actualizacion');
  }
});

// Escuchar estados de la actualización desde el proceso principal
ipcRenderer.on('estado-actualizacion', (event, estado, info) => {
  switch (estado) {
    case 'buscando':
      updateLoader.style.display = 'block';
      updateModalDesc.textContent = 'Comprobando si hay actualizaciones disponibles en el servidor...';
      updateBtnAction.style.display = 'none';
      break;

    case 'disponible':
      updateLoader.style.display = 'none';
      updateModalTitle.textContent = '¡Nueva actualización!';
      updateModalDesc.textContent = `Una nueva versión está disponible: v${info.version || '1.0.0'}. ¿Deseas descargarla ahora?`;
      updateBtnAction.textContent = 'Descargar';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'descargar';
      break;

    case 'no-disponible':
      updateLoader.style.display = 'none';
      updateModalTitle.textContent = 'Al día';
      updateModalDesc.textContent = 'Tu reproductor multimedia Sophy ya está actualizado a la última versión.';
      updateBtnAction.textContent = 'Entendido';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'cerrar';
      
      updateBtnAction.onclick = () => {
        updateModal.classList.remove('active');
        updateBtnAction.onclick = null; // Quitar listener inline
      };
      break;

    case 'descargada':
      updateLoader.style.display = 'none';
      updateProgressContainer.style.display = 'none';
      updateModalTitle.textContent = '¡Descarga completa!';
      updateModalDesc.textContent = 'La actualización se descargó correctamente. El reproductor se reiniciará para aplicar los cambios.';
      updateBtnAction.textContent = 'Reiniciar e instalar';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'instalar';
      break;

    case 'error':
      updateLoader.style.display = 'none';
      updateProgressContainer.style.display = 'none';
      updateModalTitle.textContent = 'Error';
      
      let errorMsg = info || 'Ocurrió un error inesperado al buscar actualizaciones.';
      if (errorMsg.includes('dev-app-update.yml')) {
        errorMsg = 'Las actualizaciones automáticas requieren ejecutar la aplicación empaquetada e instalada.';
      }
      updateModalDesc.textContent = errorMsg;
      updateBtnAction.textContent = 'Aceptar';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'cerrar';
      
      updateBtnAction.onclick = () => {
        updateModal.classList.remove('active');
        updateBtnAction.onclick = null;
      };
      break;
  }
});

// Escuchar el progreso de descarga de la actualización
ipcRenderer.on('progreso-descarga', (event, percent) => {
  updateLoader.style.display = 'none';
  updateProgressContainer.style.display = 'block';
  const displayPercent = Math.round(percent || 0);
  updateProgressBar.style.width = `${displayPercent}%`;
  updateModalDesc.textContent = `Descargando actualización... (${displayPercent}%)`;
});

