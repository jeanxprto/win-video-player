#include "player_manager.h"
#include <iostream>
#include <sstream>

// Helper para convertir wstring a UTF-8 (necesario para libVLC)
static std::string WideToUtf8(const std::wstring& wstr) {
    if (wstr.empty()) return "";
    int size_needed = WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), NULL, 0, NULL, NULL);
    std::string strTo(size_needed, 0);
    WideCharToMultiByte(CP_UTF8, 0, &wstr[0], (int)wstr.size(), &strTo[0], size_needed, NULL, NULL);
    return strTo;
}

PlayerManager::PlayerManager() {}

PlayerManager::~PlayerManager() {
    Shutdown();
}

bool PlayerManager::Initialize(HWND videoHwnd) {
    hWndVideo = videoHwnd;

    // Configurar argumentos para libVLC
    const char* const vlcArgs[] = {
        "--no-osd",                // Deshabilita los textos flotantes internos de VLC
        "--no-video-title-show",   // No mostrar nombre del archivo al iniciar
        "--file-logging",          // Habilitar escritura en archivo de log
        "--logfile=vlc_log.txt",   // Ruta del archivo de log
        "-vvv"                     // Verbose máximo para depuración
    };

    vlcInstance = libvlc_new(sizeof(vlcArgs) / sizeof(vlcArgs[0]), vlcArgs);
    if (!vlcInstance) {
        const char* err = libvlc_errmsg();
        std::cerr << "[libVLC] Error al crear la instancia de libVLC: " << (err ? err : "Sin mensaje") << std::endl;
        return false;
    }

    mediaPlayer = libvlc_media_player_new(vlcInstance);
    if (!mediaPlayer) {
        std::cerr << "[libVLC] Error al crear el reproductor de medios" << std::endl;
        libvlc_release(vlcInstance);
        vlcInstance = nullptr;
        return false;
    }

    // Asociar la ventana de video nativa para la salida de pantalla
    libvlc_media_player_set_hwnd(mediaPlayer, hWndVideo);

    // Suscribir eventos de libVLC
    libvlc_event_manager_t* eventManager = libvlc_media_player_event_manager(mediaPlayer);
    if (eventManager) {
        libvlc_event_attach(eventManager, libvlc_MediaPlayerTimeChanged, VlcEventCallback, this);
        libvlc_event_attach(eventManager, libvlc_MediaPlayerPlaying, VlcEventCallback, this);
        libvlc_event_attach(eventManager, libvlc_MediaPlayerPaused, VlcEventCallback, this);
        libvlc_event_attach(eventManager, libvlc_MediaPlayerEndReached, VlcEventCallback, this);
        libvlc_event_attach(eventManager, libvlc_MediaPlayerStopped, VlcEventCallback, this);
        libvlc_event_attach(eventManager, libvlc_MediaPlayerLengthChanged, VlcEventCallback, this);
        libvlc_event_attach(eventManager, libvlc_MediaPlayerEncounteredError, VlcEventCallback, this);
    }

    return true;
}

void PlayerManager::Shutdown() {
    if (mediaPlayer) {
        libvlc_media_player_stop(mediaPlayer);
        libvlc_media_player_release(mediaPlayer);
        mediaPlayer = nullptr;
    }
    if (vlcInstance) {
        libvlc_release(vlcInstance);
        vlcInstance = nullptr;
    }
    hWndVideo = nullptr;
}

bool PlayerManager::Load(const std::wstring& filePath) {
    if (!mediaPlayer || !vlcInstance) return false;

    // Detener reproducción anterior
    libvlc_media_player_stop(mediaPlayer);

    std::string utf8Path = WideToUtf8(filePath);
    libvlc_media_t* media = libvlc_media_new_path(vlcInstance, utf8Path.c_str());
    if (!media) {
        std::wstring msg = L"No se pudo cargar el archivo en libVLC:\n" + filePath;
        MessageBoxW(NULL, msg.c_str(), L"Error al abrir archivo", MB_ICONERROR);
        return false;
    }

    // Cargar metadatos asíncronos/síncronos
    libvlc_media_player_set_media(mediaPlayer, media);
    libvlc_media_release(media);

    cachedDuration = 0.0;
    mediaLoadedFired = false;

    // Iniciar reproducción para forzar el parseo de pistas y duración
    Play();

    return true;
}

void PlayerManager::Play() {
    if (mediaPlayer) {
        libvlc_media_player_play(mediaPlayer);
    }
}

void PlayerManager::Pause() {
    if (mediaPlayer) {
        libvlc_media_player_pause(mediaPlayer);
    }
}

void PlayerManager::Stop() {
    if (mediaPlayer) {
        libvlc_media_player_stop(mediaPlayer);
    }
}

void PlayerManager::Seek(double seconds) {
    if (mediaPlayer) {
        libvlc_time_t ms = static_cast<libvlc_time_t>(seconds * 1000.0);
        libvlc_media_player_set_time(mediaPlayer, ms);
    }
}

void PlayerManager::SetVolume(double volumePercent) {
    if (mediaPlayer) {
        currentVolume = volumePercent;
        if (!isMuted) {
            int vol = static_cast<int>(volumePercent * 100.0);
            libvlc_audio_set_volume(mediaPlayer, vol);
        }
    }
}

void PlayerManager::SetMute(bool mute) {
    if (mediaPlayer) {
        isMuted = mute;
        int vol = mute ? 0 : static_cast<int>(currentVolume * 100.0);
        libvlc_audio_set_volume(mediaPlayer, vol);
    }
}

void PlayerManager::SetAudioTrack(int trackId) {
    if (mediaPlayer) {
        libvlc_audio_set_track(mediaPlayer, trackId);
    }
}

void PlayerManager::SetSubtitleTrack(int trackId) {
    if (mediaPlayer) {
        libvlc_video_set_spu(mediaPlayer, trackId);
    }
}

bool PlayerManager::SetExternalSubtitle(const std::wstring& srtPath) {
    if (mediaPlayer) {
        std::string utf8Srt = WideToUtf8(srtPath);
        int res = libvlc_video_set_subtitle_file(mediaPlayer, utf8Srt.c_str());
        return res != 0;
    }
    return false;
}

double PlayerManager::GetCurrentTime() const {
    if (mediaPlayer) {
        libvlc_time_t ms = libvlc_media_player_get_time(mediaPlayer);
        return ms >= 0 ? static_cast<double>(ms) / 1000.0 : 0.0;
    }
    return 0.0;
}

double PlayerManager::GetDuration() const {
    if (mediaPlayer) {
        libvlc_time_t ms = libvlc_media_player_get_length(mediaPlayer);
        if (ms > 0) {
            cachedDuration = static_cast<double>(ms) / 1000.0;
        }
    }
    return cachedDuration;
}

bool PlayerManager::IsPlaying() const {
    if (mediaPlayer) {
        return libvlc_media_player_is_playing(mediaPlayer) != 0;
    }
    return false;
}

void PlayerManager::VlcEventCallback(const struct libvlc_event_t* p_event, void* p_data) {
    auto pThis = static_cast<PlayerManager*>(p_data);
    if (pThis) {
        pThis->HandleVlcEvent(p_event);
    }
}

void PlayerManager::HandleVlcEvent(const struct libvlc_event_t* p_event) {
    switch (p_event->type) {
        case libvlc_MediaPlayerTimeChanged: {
            double currentSecs = static_cast<double>(p_event->u.media_player_time_changed.new_time) / 1000.0;
            if (onTimeUpdate) {
                onTimeUpdate(currentSecs);
            }
            break;
        }
        case libvlc_MediaPlayerPlaying:
            // Al arrancar a reproducir intentamos obtener los metadatos si ya están listos
            if (!mediaLoadedFired) {
                double duration = GetDuration();
                if (duration > 0.0) {
                    mediaLoadedFired = true;
                    if (onMediaLoaded) {
                        onMediaLoaded(duration, GetAudioTracks(), GetSubtitleTracks());
                    }
                }
            }
            if (onPlayingState) {
                onPlayingState(true);
            }
            break;
        case libvlc_MediaPlayerLengthChanged: {
            double duration = static_cast<double>(p_event->u.media_player_length_changed.new_length) / 1000.0;
            if (duration > 0.0 && !mediaLoadedFired) {
                cachedDuration = duration;
                mediaLoadedFired = true;
                if (onMediaLoaded) {
                    onMediaLoaded(duration, GetAudioTracks(), GetSubtitleTracks());
                }
            }
            break;
        }
        case libvlc_MediaPlayerPaused:
            if (onPlayingState) {
                onPlayingState(false);
            }
            break;
        case libvlc_MediaPlayerStopped:
        case libvlc_MediaPlayerEndReached:
            if (onPlayingState) {
                onPlayingState(false);
            }
            break;
        case libvlc_MediaPlayerEncounteredError: {
            const char* err = libvlc_errmsg();
            std::wstring errMsg = L"Error de reproducción en libVLC:\n";
            if (err) {
                // Convertir const char* de UTF-8 a std::wstring para el MessageBox
                int len = MultiByteToWideChar(CP_UTF8, 0, err, -1, NULL, 0);
                std::wstring wideErr(len, 0);
                MultiByteToWideChar(CP_UTF8, 0, err, -1, &wideErr[0], len);
                errMsg += wideErr;
            } else {
                errMsg += L"Detalles no disponibles.";
            }
            MessageBoxW(NULL, errMsg.c_str(), L"Error de libVLC", MB_ICONERROR);
            break;
        }
    }
}

std::vector<MediaTrackInfo> PlayerManager::GetAudioTracks() {
    std::vector<MediaTrackInfo> tracks;
    if (!mediaPlayer) return tracks;

    libvlc_track_description_t* desc = libvlc_audio_get_track_description(mediaPlayer);
    libvlc_track_description_t* curr = desc;

    // El primer track de audio de libVLC a veces es "Desactivado" (-1). Lo omitimos para que coincida con nuestra UI.
    while (curr) {
        if (curr->i_id != -1) {
            MediaTrackInfo info;
            info.index = curr->i_id;
            info.langName = curr->psz_name ? curr->psz_name : "Audio Track";
            info.details = "VLC Stream";
            tracks.push_back(info);
        }
        curr = curr->p_next;
    }

    if (desc) {
        libvlc_track_description_list_release(desc);
    }
    return tracks;
}

std::vector<MediaTrackInfo> PlayerManager::GetSubtitleTracks() {
    std::vector<MediaTrackInfo> tracks;
    if (!mediaPlayer) return tracks;

    libvlc_track_description_t* desc = libvlc_video_get_spu_description(mediaPlayer);
    libvlc_track_description_t* curr = desc;

    while (curr) {
        // En subtítulos omitimos el ID -1 ("Desactivar") de la lista, ya que el JS maneja su propia opción manual
        if (curr->i_id != -1) {
            MediaTrackInfo info;
            info.index = curr->i_id;
            info.langName = curr->psz_name ? curr->psz_name : "Subtitle Track";
            info.details = "Embedded";
            tracks.push_back(info);
        }
        curr = curr->p_next;
    }

    if (desc) {
        libvlc_track_description_list_release(desc);
    }
    return tracks;
}
