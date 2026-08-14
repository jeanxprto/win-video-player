// Versión actual de la aplicación
const APP_VERSION = '1.0.0';

// Comparador de versiones semánticas (ej. '1.0.0' vs '1.0.1')
function isNewerVersion(local, remote) {
  const localParts = local.split('.').map(Number);
  const remoteParts = remote.split('.').map(Number);
  for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
    const localVal = localParts[i] || 0;
    const remoteVal = remoteParts[i] || 0;
    if (remoteVal > localVal) return true;
    if (remoteVal < localVal) return false;
  }
  return false;
}

// Path helpers en JavaScript puro (sin dependencia de Node.js)
const path = {
  basename: (filePath) => {
    const parts = filePath.split(/[/\\]/);
    return parts[parts.length - 1];
  },
  extname: (filePath) => {
    const dotIndex = filePath.lastIndexOf('.');
    return dotIndex === -1 ? '' : filePath.slice(dotIndex);
  }
};

// Clase MockVideo que simula la API del elemento HTML5 Video para evitar reescribir la UI
class MockVideo extends EventTarget {
  constructor() {
    super();
    this._src = '';
    this._currentTime = 0;
    this._duration = 0;
    this._paused = true;
    this._volume = 1;
    this._muted = false;
    this.textTracks = [{ mode: 'disabled' }];
    this.buffered = {
      length: 0,
      end: (index) => 0
    };
  }

  get src() { return this._src; }
  set src(val) {
    this._src = val;
    if (val) {
      window.chrome.webview.postMessage(JSON.stringify({ action: 'load', path: val }));
    }
  }

  load() {
    // libVLC carga de forma automática al asignar el source
  }

  play() {
    this._paused = false;
    window.chrome.webview.postMessage(JSON.stringify({ action: 'play' }));
    return Promise.resolve();
  }

  pause() {
    this._paused = true;
    window.chrome.webview.postMessage(JSON.stringify({ action: 'pause' }));
  }

  get currentTime() { return this._currentTime; }
  set currentTime(val) {
    this._currentTime = val;
    window.chrome.webview.postMessage(JSON.stringify({ action: 'seek', time: val }));
  }

  get duration() { return this._duration; }
  set duration(val) { this._duration = val; }

  get paused() { return this._paused; }
  
  get volume() { return this._volume; }
  set volume(val) {
    this._volume = val;
    window.chrome.webview.postMessage(JSON.stringify({ action: 'volume', volume: val }));
  }

  get muted() { return this._muted; }
  set muted(val) {
    this._muted = val;
    window.chrome.webview.postMessage(JSON.stringify({ action: 'mute', mute: val }));
  }

  querySelectorAll(selector) {
    return [];
  }

  appendChild(child) {
    // Las pistas de subtítulos externos se manejan a través de set-subtitle-track
  }
}

const video = new MockVideo();

// Mock document.createElement para simular elementos 'track' de subtítulos
const originalCreateElement = document.createElement.bind(document);
document.createElement = function(tagName) {
  if (tagName.toLowerCase() === 'track') {
    return {
      tagName: 'TRACK',
      kind: 'subtitles',
      srclang: 'es',
      default: true,
      label: '',
      src: '',
      remove: () => {}
    };
  }
  return originalCreateElement(tagName);
};

// Elementos del DOM
const appContainer = document.querySelector('.app-container');
const videoPlaceholder = document.getElementById('video-element');
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

// Submenús del Menú Contextual
const submenuAudio = document.getElementById('submenu-audio');
const submenuSubtitles = document.getElementById('submenu-subtitles');

// Estado de pistas de audio y subtítulos
let currentAudioTrack = '';       // Índice del stream de audio activo
let currentSubtitleTrack = '-1';   // Índice del stream de subtítulo activo (-1 = desactivados)
let mediaAudioTracks = [];        // Lista de pistas de audio del video
let mediaSubtitleTracks = [];     // Lista de pistas de subtítulos del video

// Botones de control de ventana de Windows
const winMinBtn = document.getElementById('win-min-btn');
const winMaxBtn = document.getElementById('win-max-btn');
const winCloseBtn = document.getElementById('win-close-btn');

// Estado de reproducción
let currentFilePath = '';
let previousVolume = 1;          
let isSeeking = false;           
let controlsTimeout = null;

// SVG Icons para alternar Estados
const PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

const FULLSCREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
const MINIMIZE_SCREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4"/></svg>';

const MAXIMIZE_SVG = '<svg viewBox="0 0 10 10" width="10" height="10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>';
const RESTORE_SVG = '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M2.5,2.5 L2.5,0.5 L9.5,0.5 L9.5,7.5 L7.5,7.5 M0.5,2.5 L7.5,2.5 L7.5,9.5 L0.5,9.5 Z" fill="none" stroke="currentColor" stroke-width="1"/></svg>';

/* ==========================================
   Controles de Ventana de Windows (IPC C++)
   ========================================== */
winMinBtn.addEventListener('click', () => window.chrome.webview.postMessage(JSON.stringify({ action: 'window-minimize' })));
winMaxBtn.addEventListener('click', () => window.chrome.webview.postMessage(JSON.stringify({ action: 'window-maximize' })));
winCloseBtn.addEventListener('click', () => window.chrome.webview.postMessage(JSON.stringify({ action: 'window-close' })));

// Habilitar el arrastre de la ventana en la barra de título personalizada
const dragRegion = document.querySelector('.drag-region');
if (dragRegion) {
  dragRegion.addEventListener('mousedown', (e) => {
    if (e.button === 0) { // Click izquierdo
      window.chrome.webview.postMessage(JSON.stringify({ action: 'window-drag' }));
    }
  });
}

/* ==========================================
   Carga e Inicialización de Videos
   ========================================== */

// Abre el selector de archivos nativo
function triggerFileOpen() {
  window.chrome.webview.postMessage(JSON.stringify({ action: 'open-file-dialog' }));
}

selectFileBtn.addEventListener('click', triggerFileOpen);
backBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (currentFilePath) {
    window.chrome.webview.postMessage(JSON.stringify({ action: 'show-in-folder', path: currentFilePath }));
  }
});

// Función para enviar posición y tamaño del video a C++
function updateVideoPosition() {
  if (!video.src) return;
  const rect = videoPlaceholder.getBoundingClientRect();
  window.chrome.webview.postMessage(JSON.stringify({
    action: 'resize-video',
    left: Math.round(rect.left),
    top: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }));
}

window.addEventListener('resize', updateVideoPosition);

// Carga el archivo en el reproductor (se comunica con C++ nativo)
function loadVideo(filePath) {
  currentFilePath = filePath;
  const fileName = path.basename(filePath);
  videoTitle.textContent = fileName;
  document.title = `${fileName} - Sophy Player`;

  // Ocultar zona drop y mostrar overlay de carga
  dropZone.classList.remove('active');
  loadingOverlay.classList.add('active');
  loadingText.textContent = "Cargando video nativo...";

  // Resetear estados
  video._src = filePath;
  video._paused = true;
  currentAudioTrack = '';
  currentSubtitleTrack = '-1';

  // Enviar mensaje a C++ para iniciar la carga
  window.chrome.webview.postMessage(JSON.stringify({ action: 'load', path: filePath }));
}

function resetToWelcomeScreen() {
  currentFilePath = '';
  video._src = '';
  dropZone.classList.add('active');
  loadingOverlay.classList.remove('active');
  controlsOverlay.classList.remove('visible');
  appContainer.classList.add('controls-visible');
  document.documentElement.classList.remove('video-active');
  videoTitle.textContent = "Video title";
  document.title = "Sophy Player";
  
  window.chrome.webview.postMessage(JSON.stringify({ action: 'stop' }));
}

// Eventos de estado de carga
video.addEventListener('waiting', () => {
  loadingOverlay.classList.add('active');
  loadingText.textContent = "Cargando...";
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

function getDisplayTime() {
  return video.currentTime;
}

function getDuration() {
  return video.duration;
}

// Actualiza el indicador de tiempo e interfaz de progreso
video.addEventListener('timeupdate', () => {
  if (isSeeking) return;

  const current = getDisplayTime();
  const total = getDuration();

  timeDisplay.textContent = `${formatTime(current)} / ${formatTime(total)}`;

  if (total > 0) {
    const pct = (current / total) * 100;
    progressActive.style.width = `${pct}%`;
    progressThumb.style.left = `${pct}%`;
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
  video.currentTime = targetTime;
}

/* ==========================================
   Controles Interactivos y Botones
   ========================================== */

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

rewindBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  seekTo(getDisplayTime() - 10);
});

forwardBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  seekTo(getDisplayTime() + 10);
});

videoPlaceholder.addEventListener('click', () => {
  if (video.src) {
    togglePlay();
  }
});

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
  
  const pctValue = percentage * 100;
  progressActive.style.width = `${pctValue}%`;
  progressThumb.style.left = `${pctValue}%`;

  const targetTime = percentage * getDuration();
  timeDisplay.textContent = `${formatTime(targetTime)} / ${formatTime(getDuration())}`;

  if (!isSeeking) {
    seekTo(targetTime);
  }
}

// Pantalla Completa
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => {
      fullscreenIcon.innerHTML = MINIMIZE_SCREEN_SVG;
      updateVideoPosition();
    }).catch(err => {
      console.error('Error al intentar activar pantalla completa:', err);
    });
  } else {
    document.exitFullscreen().then(() => {
      fullscreenIcon.innerHTML = FULLSCREEN_SVG;
      updateVideoPosition();
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

  volumeSlider.value = muted ? 0 : vol;

  if (muted || vol === 0) {
    volumeBtn.innerHTML = MUTE_SVG;
  } else if (vol < 0.5) {
    volumeBtn.innerHTML = LOW_SVG;
  } else {
    volumeBtn.innerHTML = HIGH_SVG;
  }
}

let volumeIndicatorTimeout = null;

function showVolumeIndicator() {
  const pct = Math.round((video.muted ? 0 : video.volume) * 100);
  volumeIndicator.textContent = `${pct}%`;
  volumeIndicator.classList.add('visible');

  clearTimeout(volumeIndicatorTimeout);
  volumeIndicatorTimeout = setTimeout(() => {
    volumeIndicator.classList.remove('visible');
  }, 1500);
}

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

document.querySelector('.player-content').addEventListener('wheel', (e) => {
  if (!video.src) return;
  e.preventDefault();

  video.muted = false;
  if (e.deltaY < 0) {
    video.volume = Math.min(1, video.volume + 0.05);
  } else {
    video.volume = Math.max(0, video.volume - 0.05);
  }

  updateVolumeUI();
  showVolumeIndicator();
  triggerControlsShow();
}, { passive: false });

updateVolumeUI();

videoPlaceholder.addEventListener('dblclick', () => {
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
  
  if (!video.paused && video.src) {
    controlsTimeout = setTimeout(() => {
      controlsOverlay.classList.remove('visible');
      controlsOverlay.classList.add('no-cursor');
      appContainer.classList.remove('controls-visible');
    }, 3000);
  }
}

document.querySelector('.player-content').addEventListener('mousemove', triggerControlsShow);

/* ==========================================
   Drag & Drop de Archivos
   ========================================== */

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  document.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
  e.preventDefault();
  e.stopPropagation();
}

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
    if (file && file.path) {
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
    } else {
      alert('Por motivos de seguridad del navegador, para reproducir un video debes utilizar el botón "Seleccionar Archivo".');
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
  
  contextMenu.classList.add('active');
  const menuWidth = contextMenu.offsetWidth || 180;
  const menuHeight = contextMenu.offsetHeight || 220;
  
  let posX = e.clientX;
  if (e.clientX + menuWidth > window.innerWidth) {
    posX = e.clientX - menuWidth;
  }
  
  let posY = e.clientY;
  if (e.clientY + menuHeight > window.innerHeight) {
    posY = e.clientY - menuHeight;
  }
  
  posX = Math.max(0, posX);
  posY = Math.max(0, posY);
  
  contextMenu.style.left = `${posX}px`;
  contextMenu.style.top = `${posY}px`;
});

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (contextMenu.classList.contains('active')) {
    cerrarMenuContextual();
  } else {
    contextMenu.classList.add('active');
    const rect = menuBtn.getBoundingClientRect();
    const menuWidth = contextMenu.offsetWidth || 180;
    contextMenu.style.left = `${rect.right - menuWidth}px`;
    contextMenu.style.top = `${rect.bottom + 8}px`;
  }
});

document.addEventListener('click', (e) => {
  if (!contextMenu.contains(e.target) && !menuBtn.contains(e.target)) {
    cerrarMenuContextual();
  }
});

document.getElementById('menu-open-file').addEventListener('click', () => {
  triggerFileOpen();
  cerrarMenuContextual();
});

document.getElementById('menu-about').addEventListener('click', () => {
  cerrarMenuContextual();
  aboutModal.classList.add('active');
});

closeModalBtn.addEventListener('click', () => {
  aboutModal.classList.remove('active');
});

aboutModal.addEventListener('click', (e) => {
  if (e.target === aboutModal) {
    aboutModal.classList.remove('active');
  }
});

// Variables para almacenar el estado y la URL de la actualización activa
let currentUpdateAction = null;
let latestReleaseUrl = '';
let isFallbackPage = false;

menuCheckUpdates.addEventListener('click', () => {
  cerrarMenuContextual();
  
  updateModalTitle.textContent = 'Actualizaciones';
  updateModalDesc.textContent = 'Buscando actualizaciones disponibles en GitHub...';
  updateLoader.style.display = 'block';
  updateProgressContainer.style.display = 'none';
  updateProgressBar.style.width = '0%';
  updateBtnAction.style.display = 'none';
  
  updateModal.classList.add('active');

  // Consulta real de la versión más reciente en GitHub
  fetch('https://api.github.com/repos/jeanxprto/win-video-player/releases/latest')
    .then(response => {
      if (!response.ok) throw new Error('No se pudo establecer conexión con el servidor de actualizaciones.');
      return response.json();
    })
    .then(data => {
      if (!data || !data.tag_name) {
        throw new Error('Formato de versión no válido en el servidor.');
      }
      
      const remoteVersion = data.tag_name.replace(/^v/, '');
      if (isNewerVersion(APP_VERSION, remoteVersion)) {
        // Buscar un instalador ejecutable (.exe) entre los assets del lanzamiento
        const exeAsset = data.assets && data.assets.find(asset => asset.name.endsWith('.exe'));
        const downloadUrl = exeAsset ? exeAsset.browser_download_url : null;
        
        if (downloadUrl) {
          handleUpdateStatus('disponible', { version: remoteVersion, url: downloadUrl, isPage: false });
        } else {
          // Si no hay un instalador directo, redirigir a la página de releases de GitHub como plan de contingencia
          handleUpdateStatus('disponible', { version: remoteVersion, url: data.html_url, isPage: true });
        }
      } else {
        handleUpdateStatus('no-disponible');
      }
    })
    .catch(err => {
      handleUpdateStatus('error', err.message || 'Error al buscar actualizaciones.');
    });
});

closeUpdateModalBtn.addEventListener('click', () => {
  // Evitar cerrar el modal si la descarga nativa está en curso (el botón de acción estará oculto)
  if (currentUpdateAction === 'descargar' && updateBtnAction.style.display === 'none') {
    return;
  }
  updateModal.classList.remove('active');
});

updateModal.addEventListener('click', (e) => {
  if (e.target === updateModal) {
    if (currentUpdateAction === 'descargar' && updateBtnAction.style.display === 'none') {
      return;
    }
    updateModal.classList.remove('active');
  }
});

updateBtnAction.addEventListener('click', () => {
  if (currentUpdateAction === 'descargar') {
    if (isFallbackPage) {
      // Abrir página de releases en el navegador
      window.chrome.webview.postMessage(JSON.stringify({ action: 'open-url', url: latestReleaseUrl }));
      updateModal.classList.remove('active');
    } else {
      // Iniciar descarga e instalación en segundo plano mediante C++
      updateLoader.style.display = 'block';
      updateModalDesc.textContent = 'Descargando actualización en segundo plano, por favor espera...';
      updateBtnAction.style.display = 'none';
      window.chrome.webview.postMessage(JSON.stringify({ action: 'start-download', url: latestReleaseUrl }));
    }
  } else if (currentUpdateAction === 'cerrar') {
    updateModal.classList.remove('active');
  }
});

function handleUpdateStatus(estado, info) {
  switch (estado) {
    case 'buscando':
      updateLoader.style.display = 'block';
      updateModalDesc.textContent = 'Buscando actualizaciones disponibles en GitHub...';
      updateBtnAction.style.display = 'none';
      break;

    case 'disponible':
      updateLoader.style.display = 'none';
      updateModalTitle.textContent = '¡Nueva actualización!';
      updateModalDesc.textContent = `Una nueva versión está disponible: v${info.version || '1.0.0'}. ¿Deseas descargarla e instalarla ahora de manera automática?`;
      updateBtnAction.textContent = 'Actualizar ahora';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'descargar';
      latestReleaseUrl = info.url;
      isFallbackPage = !!info.isPage;
      break;

    case 'no-disponible':
      updateLoader.style.display = 'none';
      updateModalTitle.textContent = 'Aplicación al día';
      updateModalDesc.textContent = `Tu reproductor Sophy Player ya está actualizado a la última versión (v${APP_VERSION}).`;
      updateBtnAction.textContent = 'Entendido';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'cerrar';
      break;

    case 'error':
      updateLoader.style.display = 'none';
      updateProgressContainer.style.display = 'none';
      updateModalTitle.textContent = 'Error de actualización';
      updateModalDesc.textContent = info || 'Ocurrió un error inesperado al gestionar la actualización.';
      updateBtnAction.textContent = 'Aceptar';
      updateBtnAction.style.display = 'block';
      currentUpdateAction = 'cerrar';
      break;
  }
}

function handleUpdateProgress(percent) {
  updateLoader.style.display = 'none';
  updateProgressContainer.style.display = 'block';
  const displayPercent = Math.round(percent || 0);
  updateProgressBar.style.width = `${displayPercent}%`;
  updateModalDesc.textContent = `Descargando actualización... (${displayPercent}%)`;
}

/* ==============================================================
   Lógica de Pistas de Audio y Subtítulos (Submenús Dinámicos)
   ============================================================== */

// Poblar dinámicamente las listas HTML de los submenús
function poblarSubmenus() {
  // 1. Poblar submenú de audio
  submenuAudio.innerHTML = '';
  if (mediaAudioTracks.length === 0) {
    const defaultItem = document.createElement('div');
    defaultItem.className = 'menu-item';
    defaultItem.style.color = 'rgba(255, 255, 255, 0.4)';
    defaultItem.style.pointerEvents = 'none';
    defaultItem.textContent = 'Audio por defecto';
    submenuAudio.appendChild(defaultItem);
  } else {
    mediaAudioTracks.forEach(track => {
      const btn = originalCreateElement('button'); // Usar native button
      btn.className = 'menu-item';
      
      const isSelected = currentAudioTrack === track.index.toString() || 
                         (currentAudioTrack === '' && track.index === mediaAudioTracks[0].index);
      if (isSelected) {
        btn.classList.add('active');
      }
      
      btn.textContent = `${track.langName} [${track.details}]`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        cambiarPistaAudio(track.index.toString());
      });
      submenuAudio.appendChild(btn);
    });
  }

  // 2. Poblar submenú de subtítulos
  submenuSubtitles.innerHTML = '';

  // Opción "Desactivados"
  const btnDisable = originalCreateElement('button');
  btnDisable.className = 'menu-item';
  if (currentSubtitleTrack === '-1') {
    btnDisable.classList.add('active');
  }
  btnDisable.textContent = 'Desactivados';
  btnDisable.addEventListener('click', (e) => {
    e.stopPropagation();
    cambiarPistaSubtítulo('-1');
  });
  submenuSubtitles.appendChild(btnDisable);

  // Cargar subtítulos internos si existen
  if (mediaSubtitleTracks.length > 0) {
    mediaSubtitleTracks.forEach(track => {
      const btn = originalCreateElement('button');
      btn.className = 'menu-item';
      
      if (currentSubtitleTrack === track.index.toString()) {
        btn.classList.add('active');
      }
      
      btn.textContent = `${track.langName} [${track.details}]`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        cambiarPistaSubtítulo(track.index.toString(), false);
      });
      submenuSubtitles.appendChild(btn);
    });
  }

  const divLine = document.createElement('div');
  divLine.className = 'menu-divider';
  submenuSubtitles.appendChild(divLine);

  // Opción "Cargar archivo externo..."
  const btnExternal = originalCreateElement('button');
  btnExternal.className = 'menu-item';
  if (currentSubtitleTrack === 'external') {
    btnExternal.classList.add('active');
  }
  btnExternal.textContent = 'Cargar archivo externo...';
  btnExternal.addEventListener('click', (e) => {
    e.stopPropagation();
    cargarSubtituloExterno();
  });
  submenuSubtitles.appendChild(btnExternal);
}

// Cambiar la pista de audio
function cambiarPistaAudio(trackIndex) {
  if (currentAudioTrack === trackIndex) return;
  currentAudioTrack = trackIndex;
  cerrarMenuContextual();
  
  loadingOverlay.classList.add('active');
  loadingText.textContent = "Cambiando de idioma...";
  
  window.chrome.webview.postMessage(JSON.stringify({
    action: 'set-audio-track',
    trackIndex: trackIndex
  }));
  
  poblarSubmenus();

  // Ocultar el overlay tras un breve retraso para dar tiempo a la transición de audio nativa
  setTimeout(() => {
    loadingOverlay.classList.remove('active');
  }, 800);
}

// Activar o desactivar subtítulos
function cambiarPistaSubtítulo(trackIndex, isExternal = false, path = null) {
  currentSubtitleTrack = trackIndex;
  cerrarMenuContextual();
  
  if (trackIndex === '-1') {
    window.chrome.webview.postMessage(JSON.stringify({ action: 'set-subtitle-track', trackIndex: '-1' }));
    poblarSubmenus();
    return;
  }
  
  if (isExternal) {
    window.chrome.webview.postMessage(JSON.stringify({ action: 'set-subtitle-track', trackIndex: 'external', path: path }));
  } else {
    window.chrome.webview.postMessage(JSON.stringify({ action: 'set-subtitle-track', trackIndex: trackIndex }));
  }
  
  poblarSubmenus();
}

// Abrir diálogo para subtítulo externo
function cargarSubtituloExterno() {
  cerrarMenuContextual();
  window.chrome.webview.postMessage(JSON.stringify({ action: 'open-subtitle-dialog' }));
}

function posicionarSubmenu(menuItem, submenu) {
  const itemRect = menuItem.getBoundingClientRect();
  const submenuWidth = submenu.offsetWidth || 185;
  
  submenu.style.top = `${itemRect.top - 6}px`;
  
  const isTooFarRight = (itemRect.right + submenuWidth) > window.innerWidth;
  if (isTooFarRight) {
    submenu.style.left = `${itemRect.left - submenuWidth + 6}px`;
  } else {
    submenu.style.left = `${itemRect.right - 6}px`;
  }
}

function cerrarMenuContextual() {
  contextMenu.classList.remove('active');
  document.querySelectorAll('.submenu-floating').forEach(sub => {
    sub.classList.remove('visible');
  });
  if (document.activeElement) {
    document.activeElement.blur();
  }
}

function setupSubmenuHover(menuItem, submenu) {
  let closeTimeout = null;
  
  menuItem.addEventListener('mouseenter', () => {
    if (closeTimeout) clearTimeout(closeTimeout);
    
    document.querySelectorAll('.submenu-floating').forEach(sub => {
      if (sub !== submenu) sub.classList.remove('visible');
    });
    
    submenu.classList.add('visible');
    posicionarSubmenu(menuItem, submenu);
  });
  
  menuItem.addEventListener('mouseleave', () => {
    closeTimeout = setTimeout(() => {
      if (!submenu.matches(':hover')) {
        submenu.classList.remove('visible');
      }
    }, 100);
  });
  
  submenu.addEventListener('mouseenter', () => {
    if (closeTimeout) clearTimeout(closeTimeout);
  });
  
  submenu.addEventListener('mouseleave', () => {
    closeTimeout = setTimeout(() => {
      if (!menuItem.matches(':hover')) {
        submenu.classList.remove('visible');
      }
    }, 100);
  });
}

const menuAudioItem = document.getElementById('menu-audio-tracks');
const menuSubtitleItem = document.getElementById('menu-subtitle-tracks');
setupSubmenuHover(menuAudioItem, submenuAudio);
setupSubmenuHover(menuSubtitleItem, submenuSubtitles);

/* ==========================================
   Recepción de Mensajes IPC de C++ WebView2
   ========================================== */
window.chrome.webview.addEventListener('message', event => {
  const message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  switch (message.type) {
    case 'window-maximized':
      winMaxBtn.innerHTML = message.maximized ? RESTORE_SVG : MAXIMIZE_SVG;
      break;

    case 'file-selected':
      loadVideo(message.path);
      break;

    case 'media-loaded':
      document.documentElement.classList.add('video-active');
      video._duration = message.duration;
      mediaAudioTracks = message.audioTracks || [];
      mediaSubtitleTracks = message.subtitleTracks || [];
      
      if (mediaAudioTracks.length > 0) {
        currentAudioTrack = mediaAudioTracks[0].index.toString();
      } else {
        currentAudioTrack = '';
      }
      currentSubtitleTrack = '-1';
      poblarSubmenus();
      
      loadingOverlay.classList.remove('active');
      dropZone.classList.remove('active');
      
      // Ajustar posición nativa del reproductor de video en C++
      setTimeout(updateVideoPosition, 100);
      break;

    case 'time-update':
      video._currentTime = message.currentTime;
      video.dispatchEvent(new Event('timeupdate'));
      break;

    case 'playing-state':
      video._paused = !message.playing;
      video.dispatchEvent(new Event(message.playing ? 'playing' : 'pause'));
      break;

    case 'subtitle-selected':
      cambiarPistaSubtítulo('external', true, message.path);
      break;

    case 'update-status':
      handleUpdateStatus(message.status, message.info);
      break;

    case 'update-progress':
      handleUpdateProgress(message.percent);
      break;
  }
});

// Habilitar redimensionado desde los bordes y esquinas vía JavaScript (para ventana sin bordes físicos)
const RESIZE_BORDER = 6; // Margen de 6 píxeles para redimensionado
window.addEventListener('mousemove', (e) => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = e.clientX;
  const y = e.clientY;

  let cursor = 'default';
  const left = x < RESIZE_BORDER;
  const right = x > w - RESIZE_BORDER;
  const top = y < RESIZE_BORDER;
  const bottom = y > h - RESIZE_BORDER;

  if (top && left) cursor = 'nwse-resize';
  else if (top && right) cursor = 'nesw-resize';
  else if (bottom && left) cursor = 'nesw-resize';
  else if (bottom && right) cursor = 'nwse-resize';
  else if (left || right) cursor = 'ew-resize';
  else if (top || bottom) cursor = 'ns-resize';

  document.documentElement.style.cursor = cursor !== 'default' ? cursor : '';
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // Solo click izquierdo

  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = e.clientX;
  const y = e.clientY;

  const left = x < RESIZE_BORDER;
  const right = x > w - RESIZE_BORDER;
  const top = y < RESIZE_BORDER;
  const bottom = y > h - RESIZE_BORDER;

  let dir = '';
  if (top && left) dir = 'topleft';
  else if (top && right) dir = 'topright';
  else if (bottom && left) dir = 'bottomleft';
  else if (bottom && right) dir = 'bottomright';
  else if (left) dir = 'left';
  else if (right) dir = 'right';
  else if (top) dir = 'top';
  else if (bottom) dir = 'bottom';

  if (dir) {
    e.preventDefault();
    window.chrome.webview.postMessage(JSON.stringify({ action: 'window-resize', direction: dir }));
  }
});
